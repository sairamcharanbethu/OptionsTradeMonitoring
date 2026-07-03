import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';
import * as ibPkg from '@stoqey/ib';

const { IBApi, EventName, SecType } = ibPkg as any;

type StreamContract = {
  symbol: string;
  expiration: string;
  strike: number;
  optionType: 'CALL' | 'PUT';
};

type StreamSubscription = {
  key: string;
  reqId: number;
  type: 'stock' | 'option';
  symbol: string;
  contract?: StreamContract;
  snapshot: Record<string, any>;
};

export class IbkrMarketDataStreamService extends EventEmitter {
  private ib: any = null;
  private connectedPromise: Promise<void> | null = null;
  private activeContracts: Map<string, StreamContract> = new Map();
  private positionContracts: Map<string, StreamContract> = new Map();
  private temporaryContracts: Map<string, StreamContract> = new Map();
  private activeUnderlyings: Set<string> = new Set();
  private subscriptionsByKey: Map<string, StreamSubscription> = new Map();
  private subscriptionsByReqId: Map<number, StreamSubscription> = new Map();
  private isConnected = false;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private nextRequestId = Number(process.env.IBKR_STREAM_REQUEST_ID_START || 80_000);
  private readonly host = process.env.IBKR_HOST || 'ib_gateway';
  private readonly port = Number(process.env.IBKR_PORT || 4003);
  private readonly clientId = Number(process.env.IBKR_CLIENT_ID_STREAM || 22);
  private readonly marketDataType = Number(process.env.IBKR_MARKET_DATA_TYPE || 1);
  private readonly requestTimeoutMs = Number(process.env.IBKR_REQUEST_TIMEOUT_MS || 12_000);
  private readonly MAX_RECONNECT_DELAY = 60000;

  constructor(private fastify: FastifyInstance) {
    super();
  }

  public async start(): Promise<boolean> {
    try {
      await this.ensureConnected();
      await this.refreshActiveContracts();
      this.reconcileSubscriptions();
      return true;
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.fastify.log.warn(`[IBKRStream] Failed to start: ${this.lastError}`);
      this.scheduleReconnect();
      return false;
    }
  }

  public async syncSubscriptions() {
    await this.refreshActiveContracts();
    if (!this.isConnected) {
      await this.start();
      return;
    }
    this.reconcileSubscriptions();
  }

  public async addTemporarySubscription(key: string, input: { symbol: string; strike: number; optionType: 'CALL' | 'PUT'; expiration: string | Date }) {
    const contract = this.toStreamContract(input.symbol, input.strike, input.optionType, input.expiration);
    this.temporaryContracts.set(key, contract);
    this.rebuildActiveContracts();
    if (!this.isConnected) {
      await this.start();
      return;
    }
    this.reconcileSubscriptions();
  }

  public removeTemporarySubscription(key: string) {
    const contract = this.temporaryContracts.get(key);
    this.temporaryContracts.delete(key);
    if (contract && !this.isContractStillNeeded(contract)) {
      this.rebuildActiveContracts();
      this.reconcileSubscriptions();
    } else if (contract) {
      this.rebuildActiveContracts();
    }
  }

  public getHealth() {
    return {
      status: this.isConnected ? 'UP' : 'DEGRADED',
      connected: this.isConnected,
      provider: 'ibkr',
      host: this.host,
      port: this.port,
      marketDataType: this.marketDataType,
      activeSubscriptions: this.subscriptionsByKey.size,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  private async refreshActiveContracts() {
    const { rows } = await (this.fastify as any).pg.query(
      "SELECT symbol, option_type, strike_price, expiration_date FROM positions WHERE status = 'OPEN'"
    );

    this.positionContracts = new Map(rows.map((position: any) => {
      const contract = this.toStreamContract(
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date
      );
      return [this.contractKey(contract), contract];
    }));
    this.rebuildActiveContracts();
  }

  private rebuildActiveContracts() {
    const next = new Map(this.positionContracts);
    for (const contract of this.temporaryContracts.values()) {
      next.set(this.contractKey(contract), contract);
    }
    this.activeContracts = next;
    this.activeUnderlyings = new Set([...this.activeContracts.values()].map((contract) => contract.symbol));
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected && this.ib) return;
    if (this.connectedPromise) return this.connectedPromise;

    const ib = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });
    this.ib = ib;
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        ib.off(EventName.nextValidId, onReady);
        ib.off(EventName.error, onError);
      };
      const onReady = () => {
        if (timeout) clearTimeout(timeout);
        cleanup();
        this.isConnected = true;
        this.lastError = null;
        this.reconnectAttempts = 0;
        try { ib.reqMarketDataType(this.marketDataType); } catch {}
        this.attachTickHandlers();
        resolve();
      };
      const onError = (err: any, code: any) => {
        if (code === 2104 || code === 2106 || code === 2158) return;
        if (timeout) clearTimeout(timeout);
        cleanup();
        this.isConnected = false;
        this.connectedPromise = null;
        reject(new Error(`IBKR stream connection failed${code ? ` (${code})` : ''}: ${err?.message || String(err)}`));
      };
      timeout = setTimeout(() => {
        cleanup();
        this.isConnected = false;
        this.connectedPromise = null;
        reject(new Error(`IBKR stream connection timed out to ${this.host}:${this.port}`));
      }, this.requestTimeoutMs);
      ib.once(EventName.nextValidId, onReady);
      ib.on(EventName.error, onError);
      ib.connect();
      ib.reqIds();
    });

    await this.connectedPromise;
  }

  private attachTickHandlers() {
    if (!this.ib) return;
    this.ib.off(EventName.tickPrice, this.onTickPrice);
    this.ib.off(EventName.tickSize, this.onTickSize);
    this.ib.off(EventName.tickOptionComputation, this.onTickOptionComputation);
    this.ib.off(EventName.error, this.onStreamError);
    this.ib.on(EventName.tickPrice, this.onTickPrice);
    this.ib.on(EventName.tickSize, this.onTickSize);
    this.ib.on(EventName.tickOptionComputation, this.onTickOptionComputation);
    this.ib.on(EventName.error, this.onStreamError);
  }

  private readonly onTickPrice = (reqId: number, field: number, price: number) => {
    const subscription = this.subscriptionsByReqId.get(Number(reqId));
    if (!subscription) return;
    const name = this.tickPriceFieldName(field);
    if (!name) return;
    subscription.snapshot[name] = price;
    this.emitQuote(subscription);
  };

  private readonly onTickSize = (reqId: number, field: number, size: number) => {
    const subscription = this.subscriptionsByReqId.get(Number(reqId));
    if (!subscription) return;
    if (field === 0) subscription.snapshot.bidSize = size;
    if (field === 3) subscription.snapshot.askSize = size;
    if (field === 5) subscription.snapshot.lastSize = size;
    if (field === 8) subscription.snapshot.volume = size;
    if (field === 27 || field === 28) subscription.snapshot.openInterest = size;
    this.emitQuote(subscription);
  };

  private readonly onTickOptionComputation = (reqId: number, _tickType: number, _tickAttrib: any, impliedVolatility: number, delta: number, _optPrice: number, _pvDividend: number, gamma: number, vega: number, theta: number) => {
    const subscription = this.subscriptionsByReqId.get(Number(reqId));
    if (!subscription) return;
    if (Number.isFinite(impliedVolatility) && impliedVolatility > 0) subscription.snapshot.volatility = impliedVolatility;
    if (Number.isFinite(delta) && Math.abs(delta) <= 1) subscription.snapshot.delta = delta;
    if (Number.isFinite(gamma)) subscription.snapshot.gamma = gamma;
    if (Number.isFinite(vega)) subscription.snapshot.vega = vega;
    if (Number.isFinite(theta)) subscription.snapshot.theta = theta;
    this.emitQuote(subscription);
  };

  private readonly onStreamError = (err: any, code: any, reqId: any) => {
    if (code === 2104 || code === 2106 || code === 2158) return;
    this.lastError = `IBKR stream error${code ? ` ${code}` : ''}: ${err?.message || String(err)}`;
    this.fastify.log.warn(`[IBKRStream] ${this.lastError}`);
    if (Number(reqId) === -1 || reqId === undefined || reqId === null) {
      this.isConnected = false;
      this.scheduleReconnect();
    }
  };

  private reconcileSubscriptions() {
    if (!this.ib || !this.isConnected) return;

    const desired = new Map<string, { type: 'stock' | 'option'; symbol: string; contract?: StreamContract; ibContract: any }>();
    for (const symbol of this.activeUnderlyings) {
      desired.set(`stock:${symbol}`, {
        type: 'stock',
        symbol,
        ibContract: this.stockContract(symbol)
      });
    }
    for (const contract of this.activeContracts.values()) {
      const key = `option:${this.contractKey(contract)}`;
      desired.set(key, {
        type: 'option',
        symbol: this.toOsiSymbol(contract),
        contract,
        ibContract: this.optionContract(contract)
      });
    }

    for (const [key, subscription] of this.subscriptionsByKey.entries()) {
      if (!desired.has(key)) this.unsubscribe(key, subscription);
    }

    for (const [key, item] of desired.entries()) {
      if (this.subscriptionsByKey.has(key)) continue;
      this.subscribe(key, item);
    }
  }

  private subscribe(key: string, item: { type: 'stock' | 'option'; symbol: string; contract?: StreamContract; ibContract: any }) {
    const reqId = this.nextReqId();
    const subscription: StreamSubscription = {
      key,
      reqId,
      type: item.type,
      symbol: item.symbol,
      contract: item.contract,
      snapshot: {}
    };
    this.subscriptionsByKey.set(key, subscription);
    this.subscriptionsByReqId.set(reqId, subscription);
    this.ib.reqMktData(reqId, item.ibContract, item.type === 'option' ? '100,101,106' : '', false, false);
    this.fastify.log.info(`[IBKRStream] Subscribed ${item.symbol} reqId=${reqId}.`);
  }

  private unsubscribe(key: string, subscription: StreamSubscription) {
    this.subscriptionsByKey.delete(key);
    this.subscriptionsByReqId.delete(subscription.reqId);
    try { this.ib?.cancelMktData(subscription.reqId); } catch {}
    this.fastify.log.info(`[IBKRStream] Unsubscribed ${subscription.symbol} reqId=${subscription.reqId}.`);
  }

  private emitQuote(subscription: StreamSubscription) {
    const snapshot = subscription.snapshot;
    const bid = this.positiveNumber(snapshot.bid);
    const ask = this.positiveNumber(snapshot.ask);
    const last = this.positiveNumber(snapshot.last);
    const price = bid !== null && ask !== null
      ? Number(((bid + ask) / 2).toFixed(2))
      : last !== null
        ? last
        : bid !== null
          ? bid
          : ask !== null
            ? ask
            : null;
    if (price === null) return;

    this.lastMessageAt = new Date().toISOString();
    this.lastError = null;

    this.emit('quote', {
      provider: 'ibkr',
      symbol: subscription.symbol,
      bidPrice: bid ?? undefined,
      askPrice: ask ?? undefined,
      bidSize: this.nonNegativeNumber(snapshot.bidSize) ?? undefined,
      askSize: this.nonNegativeNumber(snapshot.askSize) ?? undefined,
      lastTradePrice: last ?? undefined,
      price,
      volume: this.nonNegativeNumber(snapshot.volume) ?? undefined,
      openInterest: this.nonNegativeNumber(snapshot.openInterest) ?? undefined,
      delta: this.finiteNumber(snapshot.delta) ?? undefined,
      gamma: this.finiteNumber(snapshot.gamma) ?? undefined,
      theta: this.finiteNumber(snapshot.theta) ?? undefined,
      vega: this.finiteNumber(snapshot.vega) ?? undefined,
      volatility: this.finiteNumber(snapshot.volatility) ?? undefined,
      quoteTimestamp: this.lastMessageAt,
      underlyingPrice: subscription.type === 'stock' ? price : undefined,
      raw: {
        reqId: subscription.reqId,
        type: subscription.type,
        snapshot: { ...snapshot }
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(this.MAX_RECONNECT_DELAY, Math.pow(2, this.reconnectAttempts + 1) * 1000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connectedPromise = null;
      try {
        for (const subscription of this.subscriptionsByKey.values()) {
          try { this.ib?.cancelMktData(subscription.reqId); } catch {}
        }
        this.ib?.disconnect?.();
      } catch {}
      this.ib = null;
      this.subscriptionsByKey.clear();
      this.subscriptionsByReqId.clear();
      this.start().catch((err: any) => {
        this.lastError = err.message || String(err);
        this.fastify.log.warn(`[IBKRStream] Reconnect failed: ${this.lastError}`);
      });
    }, delay);
  }

  private isContractStillNeeded(contract: StreamContract): boolean {
    const key = this.contractKey(contract);
    if (this.positionContracts.has(key)) return true;
    for (const temp of this.temporaryContracts.values()) {
      if (this.contractKey(temp) === key) return true;
    }
    return false;
  }

  private toStreamContract(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): StreamContract {
    const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
    return {
      symbol: symbol.toUpperCase(),
      expiration: dateStr,
      strike,
      optionType: type === 'PUT' ? 'PUT' : 'CALL'
    };
  }

  private stockContract(symbol: string) {
    return {
      symbol: symbol.toUpperCase(),
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD'
    };
  }

  private optionContract(contract: StreamContract) {
    return {
      symbol: contract.symbol,
      secType: SecType.OPT,
      exchange: 'SMART',
      currency: 'USD',
      lastTradeDateOrContractMonth: contract.expiration.replace(/-/g, ''),
      strike: contract.strike,
      right: contract.optionType === 'CALL' ? 'C' : 'P',
      multiplier: '100',
      tradingClass: contract.symbol
    };
  }

  private contractKey(contract: StreamContract): string {
    return `${contract.symbol}:${contract.expiration.replace(/-/g, '')}:${contract.optionType}:${Math.round(contract.strike * 1000)}`;
  }

  private toOsiSymbol(contract: StreamContract): string {
    const expiration = contract.expiration.replace(/-/g, '');
    const yy = expiration.slice(2, 4);
    const mm = expiration.slice(4, 6);
    const dd = expiration.slice(6, 8);
    const side = contract.optionType === 'CALL' ? 'C' : 'P';
    const strike = Math.round(contract.strike * 1000).toString().padStart(8, '0');
    return `${contract.symbol}${yy}${mm}${dd}${side}${strike}`;
  }

  private nextReqId() {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }

  private tickPriceFieldName(field: number): string | null {
    if (field === 1) return 'bid';
    if (field === 2) return 'ask';
    if (field === 4) return 'last';
    if (field === 6) return 'high';
    if (field === 7) return 'low';
    if (field === 9) return 'close';
    if (field === 14) return 'open';
    return null;
  }

  private positiveNumber(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private nonNegativeNumber(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private finiteNumber(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
