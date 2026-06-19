import WebSocket from 'ws';
import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';

type ThetaContract = {
  root: string;
  expiration: string | number;
  strike: string | number;
  right: 'C' | 'P';
};

export class ThetaDataStreamService extends EventEmitter {
  private ws: WebSocket | null = null;
  private baseWsUrl = process.env.THETADATA_STREAM_URL || 'ws://127.0.0.1:25510/v1/events';
  private apiKey = process.env.THETADATA_API_KEY || '';
  private activeContracts: Map<string, ThetaContract> = new Map();
  private isConnected = false;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private nextRequestId = 1;
  private readonly MAX_RECONNECT_DELAY = 60000;

  constructor(private fastify: FastifyInstance) {
    super();
  }

  public async start(): Promise<boolean> {
    await this.loadConfig();
    await this.refreshActiveContracts();
    this.connect();
    return true;
  }

  public async syncSubscriptions() {
    await this.refreshActiveContracts();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }
    this.subscribeAll();
  }

  private async loadConfig() {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT DISTINCT ON (key) key, value
       FROM settings
       WHERE key IN ('thetadata_stream_url', 'thetadata_api_key')
         AND value IS NOT NULL
         AND value != ''
       ORDER BY key, updated_at DESC`
    );
    const settings = rows.reduce((acc: Record<string, string>, row: any) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    const envStreamUrl = String(process.env.THETADATA_STREAM_URL || '');
    this.baseWsUrl = this.normalizeStreamUrl(String(settings.thetadata_stream_url || envStreamUrl || this.baseWsUrl));
    this.apiKey = String(settings.thetadata_api_key || process.env.THETADATA_API_KEY || this.apiKey).trim();
  }

  private normalizeStreamUrl(url: string): string {
    const cleaned = url.trim();
    if (!cleaned) return 'ws://127.0.0.1:25510/v1/events';
    return cleaned
      .replace(/^ws:\/\/(127\.0\.0\.1|localhost):25520\/v1\/events$/i, 'ws://thetadata:25510/v1/events')
      .replace(/^ws:\/\/thetadata:25520\/v1\/events$/i, 'ws://thetadata:25510/v1/events');
  }

  private async refreshActiveContracts() {
    const { rows } = await (this.fastify as any).pg.query(
      "SELECT symbol, option_type, strike_price, expiration_date FROM positions WHERE status = 'OPEN'"
    );

    this.activeContracts = new Map(rows.map((position: any) => {
      const contract = this.toThetaContract(
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date
      );
      return [this.contractKey(contract), contract];
    }));
  }

  private connect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }

    this.fastify.log.info(`[ThetaDataStream] Connecting to ${this.baseWsUrl}...`);
    this.ws = new WebSocket(this.baseWsUrl, {
      headers: this.apiKey ? {
        'TD-TERMINAL-KEY': this.apiKey,
        Authorization: `Bearer ${this.apiKey}`
      } : undefined
    });

    this.ws.on('open', () => {
      this.fastify.log.info('[ThetaDataStream] Connected.');
      this.isConnected = true;
      this.lastError = null;
      this.reconnectAttempts = 0;
      this.subscribeAll();
    });
    this.ws.on('message', (data: WebSocket.Data) => this.onMessage(data));
    this.ws.on('error', (err: Error) => {
      this.lastError = err.message;
      this.fastify.log.warn(`[ThetaDataStream] WebSocket error: ${err.message}`);
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnected = false;
      this.lastError = `Closed ${code}: ${reason.toString()}`;
      this.fastify.log.warn(`[ThetaDataStream] Closed (${code}): ${reason.toString()}. Scheduling reconnect...`);
      this.scheduleReconnect();
    });
  }

  private subscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.activeContracts.size === 0) {
      this.fastify.log.info('[ThetaDataStream] No open option positions to subscribe to.');
      return;
    }

    for (const contract of this.activeContracts.values()) {
      this.ws.send(JSON.stringify({
        msg_type: 'STREAM',
        sec_type: 'OPTION',
        req_type: 'QUOTE',
        add: true,
        id: this.nextRequestId++,
        contract
      }));
    }
    this.fastify.log.info(`[ThetaDataStream] Subscribed to ${this.activeContracts.size} option quote stream(s).`);
  }

  private onMessage(data: WebSocket.Data) {
    try {
      const message = JSON.parse(data.toString());
      if (message?.header?.type === 'STATUS') {
        this.lastMessageAt = new Date().toISOString();
        return;
      }

      if (message?.quote && message?.contract) {
        this.lastMessageAt = new Date().toISOString();
        const contract = message.contract;
        const quote = message.quote;
        this.emit('quote', {
          provider: 'thetadata',
          symbol: this.toOsiSymbol(contract),
          bidPrice: Number(quote.bid || 0) || undefined,
          askPrice: Number(quote.ask || 0) || undefined,
          bidSize: Number(quote.bid_size || 0) || undefined,
          askSize: Number(quote.ask_size || 0) || undefined,
          quoteTimestamp: quote.ms_of_day,
          raw: message
        });
        return;
      }

      if (message?.header?.status === 'ERROR' || message?.error) {
        this.lastError = JSON.stringify(message);
        this.fastify.log.warn(`[ThetaDataStream] Stream message error: ${this.lastError}`);
      }
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.fastify.log.warn(`[ThetaDataStream] Failed to parse message: ${this.lastError}`);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(this.MAX_RECONNECT_DELAY, Math.pow(2, this.reconnectAttempts + 1) * 1000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  public getHealth() {
    return {
      status: this.isConnected ? 'UP' : 'DEGRADED',
      connected: this.isConnected,
      provider: 'thetadata',
      activeSubscriptions: this.activeContracts.size,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  private toThetaContract(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): ThetaContract {
    const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
    return {
      root: symbol.toUpperCase(),
      expiration: dateStr.replace(/-/g, ''),
      strike: Math.round(strike * 1000),
      right: type === 'CALL' ? 'C' : 'P'
    };
  }

  private contractKey(contract: ThetaContract): string {
    return `${contract.root}:${contract.expiration}:${contract.right}:${contract.strike}`;
  }

  private toOsiSymbol(contract: any): string {
    const root = String(contract.root || '').toUpperCase();
    const expiration = String(contract.expiration || '');
    const yy = expiration.slice(2, 4);
    const mm = expiration.slice(4, 6);
    const dd = expiration.slice(6, 8);
    const right = String(contract.right || '').toUpperCase() === 'P' ? 'P' : 'C';
    const strike = Math.round(Number(contract.strike || 0)).toString().padStart(8, '0');
    return `${root}${yy}${mm}${dd}${right}${strike}`;
  }
}
