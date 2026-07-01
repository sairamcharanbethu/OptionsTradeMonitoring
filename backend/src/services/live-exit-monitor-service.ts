import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';

type LiveExitHealth = {
  status: 'UP' | 'DEGRADED' | 'DOWN';
  active: boolean;
  provider: string;
  quotesProcessed: number;
  matchedUpdates: number;
  lastQuoteAt: string | null;
  lastMatchedAt: string | null;
  lastError: string | null;
  positionCacheSize: number;
  positionCacheAgeMs: number | null;
  activeLocks: number;
};

export class LiveExitMonitorService {
  private fastify: FastifyInstance;
  private streamUpdateLocks: Set<number> = new Set();
  private quotesProcessed = 0;
  private matchedUpdates = 0;
  private lastQuoteAt: string | null = null;
  private lastMatchedAt: string | null = null;
  private lastError: string | null = null;
  private provider = 'none';
  private active = false;
  private positionsByTicker: Map<string, any[]> = new Map();
  private positionsCacheLoadedAtMs = 0;
  private positionsCacheExpiresAtMs = 0;
  private positionsRefreshPromise: Promise<Map<string, any[]>> | null = null;
  private readonly POSITION_CACHE_TTL_MS = Number(process.env.LIVE_EXIT_POSITION_CACHE_MS || 2000);

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
  }

  public start(provider: string) {
    this.provider = provider;
    this.active = true;
    this.lastError = null;
    this.fastify.log.info(`[LiveExitMonitor] Started with ${provider} quote stream.`);
  }

  public setProvider(provider: string) {
    this.provider = provider;
    this.active = true;
  }

  public async handleQuote(quote: any) {
    if (!this.active || !quote || (!quote.symbolId && !quote.symbol)) return;

    this.quotesProcessed++;
    this.lastQuoteAt = new Date().toISOString();

    try {
      const ticker = quote.symbol || await redis.get(`SYMBOL_NAME:${quote.symbolId}`);
      if (!ticker) {
        this.fastify.log.debug(`[LiveExitMonitor] Quote skipped. No ticker mapping for symbolId ${quote.symbolId}.`);
        return;
      }

      const price = this.getStreamQuotePrice(quote);
      if (!price || price <= 0) {
        this.fastify.log.debug(`[LiveExitMonitor] Quote skipped for ${ticker}. No usable premium.`);
        return;
      }

      const matchedPositions = await this.getMatchedPositions(ticker);

      if (matchedPositions.length === 0) return;

      const greeks = {
        delta: quote.delta ?? null,
        gamma: quote.gamma ?? null,
        theta: quote.theta ?? null,
        vega: quote.vega ?? null,
        rho: quote.rho ?? null
      };
      const iv = Number(quote.volatility ?? quote.iv ?? 0) || undefined;

      for (const position of matchedPositions) {
        const positionId = Number(position.id);
        if (this.streamUpdateLocks.has(positionId)) continue;

        this.streamUpdateLocks.add(positionId);
        try {
          const underlyingPrice = this.getStreamUnderlyingPrice(quote, position);
          const quoteContext = this.getStreamQuoteContext(quote, price);
          this.fastify.log.info(`[LiveExitMonitor] ${this.provider} update for ${ticker}: $${price}`);
          await (this.fastify as any).poller.processPositionExitUpdate(position, price, greeks, iv, underlyingPrice, quoteContext);
          this.matchedUpdates++;
          this.lastMatchedAt = new Date().toISOString();
          this.lastError = null;
        } finally {
          this.streamUpdateLocks.delete(positionId);
        }
      }
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.fastify.log.error(`[LiveExitMonitor] Failed to process stream quote: ${this.lastError}`);
    }
  }

  public getHealth(): LiveExitHealth {
    const streamHealth = this.getStreamHealth();
    const streamStatus = streamHealth?.status;
    const status = !this.active
      ? 'DOWN'
      : streamStatus === 'DOWN'
        ? 'DOWN'
        : this.lastError
          ? 'DEGRADED'
          : 'UP';

    return {
      status,
      active: this.active,
      provider: this.provider,
      quotesProcessed: this.quotesProcessed,
      matchedUpdates: this.matchedUpdates,
      lastQuoteAt: this.lastQuoteAt,
      lastMatchedAt: this.lastMatchedAt,
      lastError: this.lastError,
      positionCacheSize: this.positionsByTicker.size,
      positionCacheAgeMs: this.positionsCacheLoadedAtMs > 0 ? Date.now() - this.positionsCacheLoadedAtMs : null,
      activeLocks: this.streamUpdateLocks.size
    };
  }

  private async getMatchedPositions(ticker: string): Promise<any[]> {
    const positionsByTicker = await this.getOpenPositionsByTicker();
    return positionsByTicker.get(ticker) || [];
  }

  private async getOpenPositionsByTicker(): Promise<Map<string, any[]>> {
    const now = Date.now();
    if (this.positionsCacheExpiresAtMs > now) {
      return this.positionsByTicker;
    }

    if (!this.positionsRefreshPromise) {
      this.positionsRefreshPromise = this.refreshOpenPositionsByTicker()
        .finally(() => {
          this.positionsRefreshPromise = null;
        });
    }

    return this.positionsRefreshPromise;
  }

  private async refreshOpenPositionsByTicker(): Promise<Map<string, any[]>> {
    let positions: any[] = [];
    try {
      const result = await (this.fastify as any).pg.query(
        "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.status = 'OPEN' AND COALESCE(p.execution_status, '') NOT IN ('PENDING_EXIT', 'PENDING_TRIM') AND COALESCE(p.execution_status, '') NOT LIKE 'EXIT_%'"
      );
      positions = result.rows;
    } catch (err) {
      this.positionsCacheExpiresAtMs = Date.now() + Math.max(1000, this.POSITION_CACHE_TTL_MS);
      if (this.positionsByTicker.size > 0) return this.positionsByTicker;
      throw err;
    }

    const nextPositionsByTicker = new Map<string, any[]>();

    for (const position of positions) {
      const positionTicker = this.constructOSITicker(
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date
      );
      const current = nextPositionsByTicker.get(positionTicker) || [];
      current.push(position);
      nextPositionsByTicker.set(positionTicker, current);
    }

    this.positionsByTicker = nextPositionsByTicker;
    this.positionsCacheLoadedAtMs = Date.now();
    this.positionsCacheExpiresAtMs = this.positionsCacheLoadedAtMs + Math.max(250, this.POSITION_CACHE_TTL_MS);
    return this.positionsByTicker;
  }

  private getStreamHealth(): any {
    if (this.provider === 'alpaca') return (this.fastify as any).alpacaMarketDataStreamer?.getHealth?.();
    if (this.provider === 'thetadata') return (this.fastify as any).thetaDataStreamer?.getHealth?.();
    return null;
  }

  private getStreamQuotePrice(quote: any): number {
    const bid = Number(quote.bidPrice ?? quote.bid ?? 0);
    const ask = Number(quote.askPrice ?? quote.ask ?? 0);
    const last = Number(quote.lastTradePrice ?? quote.last ?? quote.price ?? 0);

    if (bid > 0 && ask > 0) return Number(((bid + ask) / 2).toFixed(2));
    if (last > 0) return Number(last.toFixed(2));
    if (bid > 0) return Number(bid.toFixed(2));
    if (ask > 0) return Number(ask.toFixed(2));
    return 0;
  }

  private getStreamQuoteContext(quote: any, price: number): any {
    const bid = Number(quote.bidPrice ?? quote.bid ?? 0);
    const ask = Number(quote.askPrice ?? quote.ask ?? 0);
    const last = Number(quote.lastTradePrice ?? quote.last ?? quote.price ?? 0);
    const mid = bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : price;
    const spreadPct = bid > 0 && ask > 0 && mid > 0 ? Number((((ask - bid) / mid) * 100).toFixed(2)) : undefined;
    return {
      bid: bid > 0 ? bid : undefined,
      ask: ask > 0 ? ask : undefined,
      last: last > 0 ? last : undefined,
      mid: mid > 0 ? mid : undefined,
      spreadPct,
      source: this.provider
    };
  }

  private getStreamUnderlyingPrice(quote: any, position: any): number | undefined {
    const streamedUnderlying = Number(quote.underlyingPrice ?? quote.underlying_price ?? 0);
    if (streamedUnderlying > 0) return streamedUnderlying;

    const lastKnownUnderlying = Number(position.underlying_price || 0);
    return lastKnownUnderlying > 0 ? lastKnownUnderlying : undefined;
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
