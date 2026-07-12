import { FastifyInstance } from 'fastify';

type CapturedOptionQuote = {
  provider?: string;
  symbol?: string;
  bidPrice?: number;
  askPrice?: number;
  lastTradePrice?: number;
  price?: number;
  volume?: number;
  openInterest?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  volatility?: number;
  underlyingPrice?: number;
  quoteTimestamp?: string;
  raw?: any;
};

type CaptureRow = {
  provider: string;
  osiTicker: string;
  underlyingSymbol: string;
  expiration: string;
  optionType: 'CALL' | 'PUT';
  strike: number;
  quoteTime: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  underlyingPrice: number | null;
  raw: any;
};

export class OptionMarketHistoryCaptureService {
  private readonly minimumCaptureIntervalMs = Math.max(250, Number(process.env.OPTION_HISTORY_CAPTURE_INTERVAL_MS || 1_000));
  private readonly maxBufferedQuotes = Math.max(100, Number(process.env.OPTION_HISTORY_CAPTURE_BUFFER_SIZE || 5_000));
  private readonly lastCapturedAt = new Map<string, number>();
  private readonly pending = new Map<string, CaptureRow>();
  private flushTimer: NodeJS.Timeout | null = null;
  private capturedQuotes = 0;
  private persistedQuotes = 0;
  private droppedQuotes = 0;
  private lastCapturedAtIso: string | null = null;
  private lastPersistedAtIso: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly fastify: FastifyInstance) {}

  public handleQuote(quote: CapturedOptionQuote) {
    const row = this.normalizeQuote(quote);
    if (!row) return;

    this.capturedQuotes += 1;
    this.lastCapturedAtIso = row.quoteTime;
    const previousAt = this.lastCapturedAt.get(row.osiTicker) || 0;
    const now = Date.parse(row.quoteTime);
    if (now - previousAt < this.minimumCaptureIntervalMs) return;
    this.lastCapturedAt.set(row.osiTicker, now);

    if (this.pending.size >= this.maxBufferedQuotes && !this.pending.has(row.osiTicker)) {
      this.droppedQuotes += 1;
      return;
    }
    this.pending.set(`${row.osiTicker}:${row.quoteTime}`, row);
    this.scheduleFlush();
  }

  public async flush() {
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending.clear();

    try {
      for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = rows.slice(offset, offset + 100);
        const values: any[] = [];
        const placeholders = chunk.map((row, index) => {
          const base = index * 20;
          values.push(
            row.provider, row.osiTicker, row.underlyingSymbol, row.expiration, row.optionType,
            row.strike, row.quoteTime, row.bid, row.ask, row.last, row.mark, row.volume,
            row.openInterest, row.iv, row.delta, row.gamma, row.theta, row.vega, row.underlyingPrice, row.raw
          );
          return `(${Array.from({ length: 20 }, (_, valueIndex) => `$${base + valueIndex + 1}`).join(', ')})`;
        });
        await this.fastify.pg.query(
          `INSERT INTO option_market_history (
             provider, osi_ticker, underlying_symbol, expiration, option_type, strike,
             quote_time, bid, ask, last, mark, volume, open_interest, iv, delta, gamma, theta, vega, underlying_price, raw_data
           ) VALUES ${placeholders.join(', ')}
           ON CONFLICT DO NOTHING`,
          values
        );
        this.persistedQuotes += chunk.length;
      }
      this.lastPersistedAtIso = new Date().toISOString();
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.fastify.log.warn(`[OptionHistoryCapture] Failed to persist ${rows.length} option quotes: ${this.lastError}`);
      for (const row of rows) {
        if (this.pending.size < this.maxBufferedQuotes) this.pending.set(`${row.osiTicker}:${row.quoteTime}`, row);
      }
    }
  }

  public getHealth() {
    return {
      status: this.lastError ? 'DEGRADED' : 'UP',
      capturedQuotes: this.capturedQuotes,
      persistedQuotes: this.persistedQuotes,
      droppedQuotes: this.droppedQuotes,
      pendingQuotes: this.pending.size,
      lastCapturedAt: this.lastCapturedAtIso,
      lastPersistedAt: this.lastPersistedAtIso,
      lastError: this.lastError
    };
  }

  public async registerSignal(signalId: number, input: { symbol: string; strike: number; optionType: 'CALL' | 'PUT'; expiration: string }) {
    const streamer = (this.fastify as any).ibkrMarketDataStreamer;
    if (!streamer?.addTemporarySubscription) return false;
    const ticker = this.buildOsiTicker(input.symbol, input.strike, input.optionType, input.expiration);
    const key = `research-signal:${signalId}:${ticker}`;
    try {
      await streamer.addTemporarySubscription(key, input);
      const expiry = new Date(`${input.expiration}T23:59:59-04:00`).getTime();
      const delay = Math.max(60_000, expiry - Date.now() + 24 * 60 * 60 * 1000);
      const cleanup = setTimeout(() => {
        streamer.removeTemporarySubscription?.(key);
      }, Math.min(delay, 7 * 24 * 60 * 60 * 1000));
      cleanup.unref?.();
      return true;
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.fastify.log.warn(`[OptionHistoryCapture] Failed to subscribe ${ticker}: ${this.lastError}`);
      return false;
    }
  }

  public async rehydrateRecentSignals() {
    const { rows } = await this.fastify.pg.query(
      `SELECT id, symbol, signal_type, option_expiration_date, option_details
       FROM signals
       WHERE signal_type IN ('CALL', 'PUT')
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day'
       ORDER BY created_at DESC
       LIMIT 250`
    );
    for (const row of rows) {
      const details = typeof row.option_details === 'string' ? this.parseJson(row.option_details) : row.option_details || {};
      const ticker = String(details.ticker || details.symbol || '').toUpperCase();
      const parsed = this.parseOsiTicker(ticker);
      if (!parsed) continue;
      await this.registerSignal(Number(row.id), {
        symbol: parsed.symbol,
        strike: parsed.strike,
        optionType: parsed.optionType,
        expiration: parsed.expiration
      });
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err: any) => {
        this.lastError = err.message || String(err);
      });
    }, 1_000);
    this.flushTimer.unref?.();
  }

  private normalizeQuote(quote: CapturedOptionQuote): CaptureRow | null {
    const parsed = this.parseOsiTicker(quote.symbol);
    if (!parsed) return null;
    const bid = this.positiveNumber(quote.bidPrice);
    const ask = this.positiveNumber(quote.askPrice);
    const last = this.positiveNumber(quote.lastTradePrice);
    const directPrice = this.positiveNumber(quote.price);
    const mark = bid !== null && ask !== null ? Number(((bid + ask) / 2).toFixed(4)) : directPrice ?? last;
    if (mark === null || mark <= 0) return null;
    const timestamp = quote.quoteTimestamp && Number.isFinite(Date.parse(quote.quoteTimestamp))
      ? new Date(quote.quoteTimestamp).toISOString()
      : new Date().toISOString();

    return {
      provider: String(quote.provider || 'ibkr'),
      osiTicker: parsed.ticker,
      underlyingSymbol: parsed.symbol,
      expiration: parsed.expiration,
      optionType: parsed.optionType,
      strike: parsed.strike,
      quoteTime: timestamp,
      bid,
      ask,
      last,
      mark,
      volume: this.nonNegativeNumber(quote.volume),
      openInterest: this.nonNegativeNumber(quote.openInterest),
      iv: this.finiteNumber(quote.volatility),
      delta: this.finiteNumber(quote.delta),
      gamma: this.finiteNumber(quote.gamma),
      theta: this.finiteNumber(quote.theta),
      vega: this.finiteNumber(quote.vega),
      underlyingPrice: this.positiveNumber(quote.underlyingPrice),
      raw: quote.raw || null
    };
  }

  private parseOsiTicker(value?: string) {
    const ticker = String(value || '').replace(/\s+/g, '').toUpperCase();
    const match = ticker.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    return {
      ticker,
      symbol: match[1],
      expiration: `20${match[2].slice(0, 2)}-${match[2].slice(2, 4)}-${match[2].slice(4, 6)}`,
      optionType: match[3] === 'C' ? 'CALL' as const : 'PUT' as const,
      strike: Number(match[4]) / 1000
    };
  }

  private buildOsiTicker(symbol: string, strike: number, optionType: 'CALL' | 'PUT', expiration: string) {
    const clean = expiration.replace(/-/g, '');
    return `${symbol.toUpperCase()}${clean.slice(2, 8)}${optionType === 'CALL' ? 'C' : 'P'}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
  }

  private parseJson(value: string) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private positiveNumber(value: any): number | null {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  private nonNegativeNumber(value: any): number | null {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  private finiteNumber(value: any): number | null {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
}
