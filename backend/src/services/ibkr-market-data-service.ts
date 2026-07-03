import { FastifyInstance } from 'fastify';
import ibPkg from '@stoqey/ib';

const { IBApi, EventName, SecType } = ibPkg as any;

export type IbkrOptionContract = {
  symbol: string;
  expiration: string;
  right: 'call' | 'put';
  strike: number;
};

export type IbkrOptionQuote = {
  source: 'ibkr';
  ticker: string;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  mark: number;
  spreadPct: number | null;
  quoteAgeMs: number | null;
  timestamp: string | null;
  raw: any;
};

export type IbkrOptionChainQuote = {
  source: 'ibkr_chain';
  ticker: string;
  symbol: string;
  expiration: string;
  right: 'call' | 'put';
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  spread: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatility: number | null;
  timestamp: string | null;
  raw: any;
};

export type IbkrHistoricalBar = {
  start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type IbkrRequestHandlers = {
  cleanup: () => void;
};

export class IbkrMarketDataService {
  private static sharedApi: any = null;
  private static connectedPromise: Promise<void> | null = null;
  private static nextRequestId = Number(process.env.IBKR_REQUEST_ID_START || 50_000);

  private readonly host = process.env.IBKR_HOST || 'ib_gateway';
  private readonly port = Number(process.env.IBKR_PORT || 4003);
  private readonly clientId = Number(process.env.IBKR_CLIENT_ID_MARKET_DATA || process.env.IBKR_CLIENT_ID || 21);
  private readonly marketDataType = Number(process.env.IBKR_MARKET_DATA_TYPE || 1);
  private readonly requestTimeoutMs = Number(process.env.IBKR_REQUEST_TIMEOUT_MS || 12_000);
  private readonly snapshotWaitMs = Number(process.env.IBKR_SNAPSHOT_WAIT_MS || 2_500);

  constructor(private fastify: FastifyInstance) {}

  public async getHealth() {
    const startedAt = Date.now();
    try {
      await this.ensureConnected();
      const quote = await this.getUnderlyingQuote('SPY');
      const connected = quote.mark > 0;
      return {
        status: connected ? 'UP' : 'DEGRADED',
        connected,
        provider: 'ibkr',
        host: this.host,
        port: this.port,
        marketDataType: this.marketDataType,
        latencyMs: Date.now() - startedAt,
        lastError: connected ? null : 'IBKR connected but SPY quote did not return a usable mark'
      };
    } catch (err: any) {
      return {
        status: 'DOWN',
        connected: false,
        provider: 'ibkr',
        host: this.host,
        port: this.port,
        marketDataType: this.marketDataType,
        latencyMs: Date.now() - startedAt,
        lastError: err.message || String(err)
      };
    }
  }

  public async getUnderlyingQuote(symbol: string): Promise<IbkrOptionQuote> {
    const contract = this.stockContract(symbol);
    const snapshot = await this.requestMarketData(contract, '', this.snapshotWaitMs, `underlying ${symbol}`);
    const normalized = this.normalizeQuote({
      symbol: symbol.toUpperCase(),
      expiration: this.todayYmd(),
      right: 'call',
      strike: 0,
      ticker: symbol.toUpperCase(),
      snapshot
    });
    if (normalized.mark <= 0) {
      throw new Error(`IBKR returned no usable ${symbol.toUpperCase()} quote`);
    }
    return normalized;
  }

  public async getHistoricalBars(symbol: string, durationStr = '5 D', barSize = '5 mins'): Promise<IbkrHistoricalBar[]> {
    const ib = await this.ensureConnected();
    const reqId = this.nextReqId();
    const rows: IbkrHistoricalBar[] = [];

    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      let quietTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (timeout) clearTimeout(timeout);
        if (quietTimer) clearTimeout(quietTimer);
        cleanup.cleanup();
        resolve();
      };
      const cleanup = this.registerRequest(reqId, reject, [
        [EventName.historicalData, (id: number, time: string, open: number, high: number, low: number, close: number, volume: number) => {
          if (id !== reqId || String(time).toLowerCase().includes('finished')) return;
          rows.push({
            start: this.normalizeIbTimestamp(time),
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume || 0)
          });
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, 500);
        }]
      ]);
      timeout = setTimeout(() => {
        if (quietTimer) clearTimeout(quietTimer);
        cleanup.cleanup();
        if (rows.length > 0) {
          resolve();
        } else {
          reject(new Error(`IBKR historical bars timed out for ${symbol}`));
        }
      }, this.requestTimeoutMs);
      ib.reqHistoricalData(reqId, this.stockContract(symbol), '', durationStr, barSize, 'TRADES', false, 2, false);
    });

    return rows.filter((row) => row.start && row.close > 0);
  }

  public async getOptionExpirations(symbol: string): Promise<string[]> {
    const params = await this.getOptionParameters(symbol);
    return [...new Set(params.flatMap((item) => item.expirations))]
      .map((value) => this.normalizeExpirationValue(value))
      .filter((value: string | null): value is string => Boolean(value))
      .sort();
  }

  public async getOptionChainSnapshot(
    userId: number | null,
    symbol: string,
    expiration: string,
    right: 'call' | 'put' | 'both' = 'both'
  ): Promise<IbkrOptionChainQuote[]> {
    const params = await this.getOptionParameters(symbol);
    const normalizedExpiration = this.normalizeExpirationValue(expiration);
    if (!normalizedExpiration) throw new Error(`Invalid IBKR option expiration ${expiration}`);
    const compactExpiration = normalizedExpiration.replace(/-/g, '');
    const rows = params.filter((item) => item.expirations.includes(compactExpiration));
    const allStrikes = [...new Set(rows.flatMap((item) => item.strikes))]
      .map(Number)
      .filter((strike) => Number.isFinite(strike) && strike > 0)
      .sort((a, b) => a - b);
    const spot = await this.getUnderlyingQuote(symbol).then((quote) => quote.mark).catch(() => null);
    const range = Number(process.env.IBKR_CHAIN_STRIKE_RANGE || 12);
    const maxStrikes = Number(process.env.IBKR_CHAIN_MAX_STRIKES || 32);
    const strikes = spot && Number.isFinite(spot)
      ? allStrikes
        .filter((strike) => Math.abs(strike - spot) <= range)
        .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
        .slice(0, maxStrikes)
        .sort((a, b) => a - b)
      : allStrikes.slice(0, maxStrikes);
    const sides: Array<'call' | 'put'> = right === 'both' ? ['call', 'put'] : [right];
    const contracts: Array<{ contract: any; meta: IbkrOptionContract }> = [];
    for (const strike of strikes) {
      for (const side of sides) {
        const meta: IbkrOptionContract = {
          symbol: symbol.toUpperCase(),
          expiration: normalizedExpiration,
          right: side,
          strike
        };
        contracts.push({ contract: this.optionContract(meta), meta });
      }
    }

    const quotes: IbkrOptionChainQuote[] = [];
    const batchSize = Number(process.env.IBKR_CHAIN_QUOTE_BATCH_SIZE || 16);
    for (let idx = 0; idx < contracts.length; idx += batchSize) {
      const batch = contracts.slice(idx, idx + batchSize);
      const settled = await Promise.allSettled(
        batch.map(async ({ contract, meta }) => {
          const snapshot = await this.requestMarketData(contract, '100,101,106', this.snapshotWaitMs, this.constructOSITicker(meta.symbol, meta.strike, meta.right === 'call' ? 'CALL' : 'PUT', meta.expiration));
          return this.normalizeChainQuote(meta, snapshot);
        })
      );
      for (const result of settled) {
        if (result.status === 'fulfilled') quotes.push(result.value);
      }
    }
    return quotes;
  }

  public async getOptionQuoteForOsi(userId: number | null, osiTicker: string): Promise<IbkrOptionQuote | null> {
    const contract = this.parseCompactOsiTicker(osiTicker);
    if (!contract) return null;
    return this.getOptionQuote(userId, contract);
  }

  public async getOptionQuote(userId: number | null, contract: IbkrOptionContract): Promise<IbkrOptionQuote | null> {
    const snapshot = await this.requestMarketData(this.optionContract(contract), '100,101,106', this.snapshotWaitMs, this.constructOSITicker(contract.symbol, contract.strike, contract.right === 'call' ? 'CALL' : 'PUT', contract.expiration));
    const normalized = this.normalizeQuote({
      ...contract,
      ticker: this.constructOSITicker(contract.symbol, contract.strike, contract.right === 'call' ? 'CALL' : 'PUT', contract.expiration),
      snapshot
    });
    return normalized.mark > 0 ? normalized : null;
  }

  public normalizeChainQuote(contract: IbkrOptionContract, snapshot: any): IbkrOptionChainQuote {
    const ticker = this.constructOSITicker(contract.symbol, contract.strike, contract.right === 'call' ? 'CALL' : 'PUT', contract.expiration);
    const bid = this.positiveNumber(snapshot.bid);
    const ask = this.positiveNumber(snapshot.ask);
    const last = this.positiveNumber(snapshot.last);
    const mid = bid !== null && ask !== null ? Number(((bid + ask) / 2).toFixed(2)) : null;
    const mark = mid !== null ? mid : last !== null ? Number(last.toFixed(2)) : null;
    const spread = bid !== null && ask !== null ? Number((ask - bid).toFixed(2)) : null;
    const spreadPct = spread !== null && mark !== null && mark > 0 ? Number(((spread / mark) * 100).toFixed(2)) : null;
    return {
      source: 'ibkr_chain',
      ticker,
      symbol: contract.symbol.toUpperCase(),
      expiration: this.normalizeExpirationValue(contract.expiration) || contract.expiration,
      right: contract.right,
      strike: contract.strike,
      bid,
      ask,
      last,
      mark,
      spread,
      spreadPct,
      volume: this.nonNegativeNumber(snapshot.volume),
      openInterest: this.nonNegativeNumber(snapshot.openInterest),
      delta: this.finiteNumber(snapshot.delta),
      gamma: this.finiteNumber(snapshot.gamma),
      theta: this.finiteNumber(snapshot.theta),
      vega: this.finiteNumber(snapshot.vega),
      impliedVolatility: this.finiteNumber(snapshot.impliedVolatility),
      timestamp: snapshot.timestamp || null,
      raw: snapshot
    };
  }

  public normalizeQuote(input: IbkrOptionContract & { ticker: string; snapshot: any }): IbkrOptionQuote {
    const chainQuote = this.normalizeChainQuote(input, input.snapshot);
    return {
      source: 'ibkr',
      ticker: input.ticker,
      bid: chainQuote.bid || 0,
      ask: chainQuote.ask || 0,
      last: chainQuote.last || 0,
      mid: chainQuote.bid && chainQuote.ask ? Number(((chainQuote.bid + chainQuote.ask) / 2).toFixed(2)) : 0,
      mark: chainQuote.mark || 0,
      spreadPct: chainQuote.spreadPct,
      quoteAgeMs: chainQuote.timestamp ? Math.max(0, Date.now() - new Date(chainQuote.timestamp).getTime()) : null,
      timestamp: chainQuote.timestamp,
      raw: input.snapshot
    };
  }

  public parseCompactOsiTicker(ticker: string): IbkrOptionContract | null {
    const match = String(ticker || '').replace(/\s+/g, '').toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, symbol, expiry, side, strikeRaw] = match;
    return {
      symbol,
      expiration: `20${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`,
      right: side === 'C' ? 'call' : 'put',
      strike: Number(strikeRaw) / 1000
    };
  }

  public constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
    const cleanDate = dateStr.includes('-') ? dateStr.replace(/-/g, '') : dateStr;
    const yy = cleanDate.slice(2, 4);
    const mm = cleanDate.slice(4, 6);
    const dd = cleanDate.slice(6, 8);
    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${mm}${dd}${side}${strikeValue}`;
  }

  private async getOptionParameters(symbol: string): Promise<Array<{ exchange: string; tradingClass: string; multiplier: string; expirations: string[]; strikes: number[] }>> {
    const ib = await this.ensureConnected();
    const underlying = await this.resolveStockContract(symbol);
    const reqId = this.nextReqId();
    const results: Array<{ exchange: string; tradingClass: string; multiplier: string; expirations: string[]; strikes: number[] }> = [];

    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = this.registerRequest(reqId, reject, [
        [EventName.securityDefinitionOptionParameter, (id: number, exchange: string, _underlyingConId: number, tradingClass: string, multiplier: string, expirations: string[], strikes: number[]) => {
          if (id !== reqId) return;
          const target = symbol.toUpperCase();
          if (tradingClass && tradingClass !== target) return;
          results.push({ exchange, tradingClass, multiplier: String(multiplier || '100'), expirations, strikes });
        }],
        [EventName.securityDefinitionOptionParameterEnd, (id: number) => {
          if (id !== reqId) return;
          if (timeout) clearTimeout(timeout);
          cleanup.cleanup();
          resolve();
        }]
      ]);
      timeout = setTimeout(() => {
        cleanup.cleanup();
        reject(new Error(`IBKR option chain metadata timed out for ${symbol}`));
      }, this.requestTimeoutMs);
      ib.reqSecDefOptParams(reqId, symbol.toUpperCase(), '', 'STK', underlying.conId);
    });

    if (results.length === 0) throw new Error(`IBKR returned no option chain metadata for ${symbol}`);
    return results;
  }

  private async resolveStockContract(symbol: string): Promise<any> {
    const ib = await this.ensureConnected();
    const reqId = this.nextReqId();
    const details: any[] = [];

    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = this.registerRequest(reqId, reject, [
        [EventName.contractDetails, (id: number, contractDetails: any) => {
          if (id !== reqId) return;
          details.push(contractDetails);
        }],
        [EventName.contractDetailsEnd, (id: number) => {
          if (id !== reqId) return;
          if (timeout) clearTimeout(timeout);
          cleanup.cleanup();
          resolve();
        }]
      ]);
      timeout = setTimeout(() => {
        cleanup.cleanup();
        reject(new Error(`IBKR contract details timed out for ${symbol}`));
      }, this.requestTimeoutMs);
      ib.reqContractDetails(reqId, this.stockContract(symbol));
    });

    const contract = details[0]?.contract;
    if (!contract?.conId) throw new Error(`IBKR could not resolve stock contract for ${symbol}`);
    return contract;
  }

  private async requestMarketData(contract: any, genericTicks: string, waitMs: number, label: string): Promise<any> {
    const ib = await this.ensureConnected();
    const reqId = this.nextReqId();
    const snapshot: any = { timestamp: new Date().toISOString() };

    await new Promise<void>((resolve, reject) => {
      const cleanup = this.registerRequest(reqId, reject, [
        [EventName.tickPrice, (id: number, field: number, price: number) => {
          if (id !== reqId) return;
          const name = this.tickPriceFieldName(field);
          if (name) snapshot[name] = price;
        }],
        [EventName.tickSize, (id: number, field: number, size: number) => {
          if (id !== reqId) return;
          if (field === 8) snapshot.volume = size;
          if (field === 27 || field === 28) snapshot.openInterest = size;
        }],
        [EventName.tickOptionComputation, (id: number, _tickType: number, _tickAttrib: any, impliedVolatility: number, delta: number, _optPrice: number, _pvDividend: number, gamma: number, vega: number, theta: number) => {
          if (id !== reqId) return;
          if (Number.isFinite(impliedVolatility) && impliedVolatility > 0) snapshot.impliedVolatility = impliedVolatility;
          if (Number.isFinite(delta) && Math.abs(delta) <= 1) snapshot.delta = delta;
          if (Number.isFinite(gamma)) snapshot.gamma = gamma;
          if (Number.isFinite(vega)) snapshot.vega = vega;
          if (Number.isFinite(theta)) snapshot.theta = theta;
        }]
      ]);
      const timeout = setTimeout(() => {
        cleanup.cleanup();
        try { ib.cancelMktData(reqId); } catch {}
        resolve();
      }, waitMs);
      try {
        ib.reqMktData(reqId, contract, genericTicks, false, false);
      } catch (err) {
        clearTimeout(timeout);
        cleanup.cleanup();
        reject(err);
      }
    });

    this.fastify.log.debug?.(`[IBKR] Market data snapshot ${label}: ${JSON.stringify(snapshot)}`);
    return snapshot;
  }

  private async ensureConnected(): Promise<any> {
    if (IbkrMarketDataService.sharedApi) {
      return IbkrMarketDataService.sharedApi;
    }
    if (!IbkrMarketDataService.connectedPromise) {
      const ib = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });
      IbkrMarketDataService.sharedApi = ib;
      IbkrMarketDataService.connectedPromise = new Promise<void>((resolve, reject) => {
        let timeout: NodeJS.Timeout | null = null;
        const onReady = () => {
          if (timeout) clearTimeout(timeout);
          cleanup();
          try { ib.reqMarketDataType(this.marketDataType); } catch {}
          resolve();
        };
        const onError = (err: any, code: any) => {
          if (code === 2104 || code === 2106 || code === 2158) return;
          if (timeout) clearTimeout(timeout);
          cleanup();
          IbkrMarketDataService.sharedApi = null;
          IbkrMarketDataService.connectedPromise = null;
          reject(new Error(`IBKR connection failed${code ? ` (${code})` : ''}: ${err?.message || String(err)}`));
        };
        const cleanup = () => {
          ib.off(EventName.nextValidId, onReady);
          ib.off(EventName.error, onError);
        };
        timeout = setTimeout(() => {
          cleanup();
          IbkrMarketDataService.sharedApi = null;
          IbkrMarketDataService.connectedPromise = null;
          reject(new Error(`IBKR connection timed out to ${this.host}:${this.port}`));
        }, this.requestTimeoutMs);
        ib.once(EventName.nextValidId, onReady);
        ib.on(EventName.error, onError);
        ib.connect();
        ib.reqIds();
      });
    }
    await IbkrMarketDataService.connectedPromise;
    return IbkrMarketDataService.sharedApi;
  }

  private registerRequest(reqId: number, reject: (err: Error) => void, handlers: Array<[string, (...args: any[]) => void]>): IbkrRequestHandlers {
    const ib = IbkrMarketDataService.sharedApi;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const [event, handler] of handlers) {
        ib.off(event, handler);
      }
      ib.off(EventName.error, onError);
    };
    const onError = (err: any, code: any, errorReqId: any) => {
      if (Number(errorReqId) !== reqId) return;
      cleanup();
      reject(new Error(`IBKR request ${reqId} failed${code ? ` (${code})` : ''}: ${err?.message || String(err)}`));
    };
    for (const [event, handler] of handlers) {
      ib.on(event, handler);
    }
    ib.on(EventName.error, onError);
    return { cleanup };
  }

  private stockContract(symbol: string) {
    return {
      symbol: symbol.toUpperCase(),
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD'
    };
  }

  private optionContract(contract: IbkrOptionContract) {
    return {
      symbol: contract.symbol.toUpperCase(),
      secType: SecType.OPT,
      exchange: 'SMART',
      currency: 'USD',
      lastTradeDateOrContractMonth: (this.normalizeExpirationValue(contract.expiration) || contract.expiration).replace(/-/g, ''),
      strike: contract.strike,
      right: contract.right === 'call' ? 'C' : 'P',
      multiplier: '100',
      tradingClass: contract.symbol.toUpperCase()
    };
  }

  private nextReqId() {
    IbkrMarketDataService.nextRequestId += 1;
    return IbkrMarketDataService.nextRequestId;
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

  private normalizeIbTimestamp(value: any): string {
    const raw = String(value || '').trim();
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  }

  private normalizeExpirationValue(value: any): string | null {
    if (value === null || value === undefined || value === '') return null;
    const compact = String(value).trim().replace(/-/g, '').slice(0, 8);
    if (!/^\d{8}$/.test(compact)) return null;
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }

  private todayYmd(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
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
