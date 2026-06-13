import WebSocket from 'ws';
import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';
import { decode, encode } from '@msgpack/msgpack';

type AlpacaStreamMessage = {
  T?: string;
  msg?: string;
  S?: string;
  bp?: number;
  ap?: number;
  p?: number;
};

export class AlpacaMarketDataStreamService extends EventEmitter {
  private fastify: FastifyInstance;
  private ws: WebSocket | null = null;
  private keyId = '';
  private secretKey = '';
  private feed = 'indicative';
  private activeSymbols: Set<string> = new Set();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnected = false;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;
  private readonly MAX_RECONNECT_DELAY = 60000;

  constructor(fastify: FastifyInstance) {
    super();
    this.fastify = fastify;
  }

  public async start(): Promise<boolean> {
    const loaded = await this.loadConfig();
    if (!loaded) {
      this.fastify.log.info('[AlpacaMarketDataStream] No Alpaca credentials configured. Stream not started.');
      return false;
    }

    await this.refreshActiveSymbols();
    this.connect();
    return true;
  }

  public async syncSubscriptions() {
    if (!this.keyId || !this.secretKey) {
      const loaded = await this.loadConfig();
      if (!loaded) return;
    }

    await this.refreshActiveSymbols();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }

    this.sendSubscribe();
  }

  private async loadConfig(): Promise<boolean> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT s1.user_id, s1.value AS key_id, s2.value AS secret_key, s3.value AS feed
       FROM settings s1
       JOIN settings s2 ON s1.user_id = s2.user_id AND s2.key = 'alpaca_secret_key'
       LEFT JOIN settings s3 ON s1.user_id = s3.user_id AND s3.key = 'alpaca_options_feed'
       WHERE s1.key = 'alpaca_key_id' AND s1.value != '' AND s2.value != ''
       ORDER BY s1.updated_at DESC
       LIMIT 1`
    );

    if (rows.length === 0) return false;

    this.keyId = rows[0].key_id.trim();
    this.secretKey = rows[0].secret_key.trim();
    this.feed = (rows[0].feed || process.env.ALPACA_OPTIONS_FEED || 'indicative').trim();
    return Boolean(this.keyId && this.secretKey);
  }

  private async refreshActiveSymbols() {
    const { rows } = await (this.fastify as any).pg.query(
      "SELECT symbol, option_type, strike_price, expiration_date FROM positions WHERE status = 'OPEN'"
    );

    this.activeSymbols = new Set(rows.map((position: any) => this.constructOSITicker(
      position.symbol,
      Number(position.strike_price),
      position.option_type,
      position.expiration_date
    )));
  }

  private connect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }

    const url = `wss://stream.data.alpaca.markets/v1beta1/${this.feed}`;
    this.fastify.log.info(`[AlpacaMarketDataStream] Connecting to ${url}...`);

    this.ws = new WebSocket(url, {
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/msgpack'
      }
    });

    this.ws.on('open', () => {
      this.fastify.log.info('[AlpacaMarketDataStream] Connected. Authenticating...');
      this.isConnected = true;
      this.lastError = null;
      this.send({ action: 'auth', key: this.keyId, secret: this.secretKey });
    });

    this.ws.on('message', (data: WebSocket.Data) => this.onMessage(data));
    this.ws.on('error', (err: Error) => {
      this.lastError = err.message;
      this.fastify.log.error(`[AlpacaMarketDataStream] WebSocket error: ${err.message}`);
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnected = false;
      this.fastify.log.warn(`[AlpacaMarketDataStream] Closed (${code}): ${reason.toString()}. Scheduling reconnect...`);
      this.scheduleReconnect();
    });
  }

  private onMessage(data: WebSocket.Data) {
    try {
      const decoded = decode(data instanceof Buffer ? data : Buffer.from(data as any)) as AlpacaStreamMessage | AlpacaStreamMessage[];
      this.lastMessageAt = new Date().toISOString();
      const messages = Array.isArray(decoded) ? decoded : [decoded];

      for (const message of messages) {
        if (message.T === 'success') {
          this.fastify.log.info(`[AlpacaMarketDataStream] ${message.msg}`);
          if (message.msg === 'authenticated') {
            this.reconnectAttempts = 0;
            this.sendSubscribe();
          }
          continue;
        }

        if (message.T === 'subscription') {
          this.fastify.log.info(`[AlpacaMarketDataStream] Subscription updated: ${JSON.stringify(message)}`);
          continue;
        }

        if (message.T === 'error') {
          this.lastError = JSON.stringify(message);
          this.fastify.log.error(`[AlpacaMarketDataStream] Stream error: ${JSON.stringify(message)}`);
          continue;
        }

        if (message.T === 'q') {
          this.emit('quote', {
            provider: 'alpaca',
            symbol: message.S,
            bidPrice: message.bp,
            askPrice: message.ap
          });
        } else if (message.T === 't') {
          this.emit('quote', {
            provider: 'alpaca',
            symbol: message.S,
            lastTradePrice: message.p
          });
        }
      }
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.fastify.log.error(`[AlpacaMarketDataStream] Failed to decode message: ${err.message}`);
    }
  }

  private sendSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const symbols = Array.from(this.activeSymbols);
    if (symbols.length === 0) {
      this.fastify.log.info('[AlpacaMarketDataStream] No open option positions to subscribe to.');
      return;
    }

    this.fastify.log.info(`[AlpacaMarketDataStream] Subscribing to ${symbols.length} option symbols.`);
    this.send({ action: 'subscribe', quotes: symbols, trades: symbols });
  }

  private send(payload: Record<string, any>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.from(encode(payload)));
  }

  public getHealth() {
    return {
      status: this.isConnected ? 'UP' : this.keyId && this.secretKey ? 'DEGRADED' : 'DOWN',
      connected: this.isConnected,
      provider: 'alpaca',
      feed: this.feed,
      activeSubscriptions: this.activeSymbols.size,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    let dateStr = '';
    if (expiration instanceof Date) {
      const year = expiration.getFullYear();
      const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
      const day = expiration.getDate().toString().padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    } else {
      dateStr = expiration.split('T')[0];
    }

    const parts = dateStr.split('-');
    if (parts.length !== 3) return symbol.toUpperCase();

    const YY = parts[0].slice(-2);
    const MM = parts[1].padStart(2, '0');
    const DD = parts[2].padStart(2, '0');
    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');

    return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
  }
}
