import { FastifyInstance } from 'fastify';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';

export type ThetaDataOptionQuote = {
  source: 'thetadata';
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

export type ThetaDataContract = {
  symbol: string;
  expiration: string;
  right: 'call' | 'put';
  strike: number;
};

export class ThetaDataService {
  constructor(private fastify: FastifyInstance) {}

  public async getOptionQuoteForOsi(userId: number | null, osiTicker: string): Promise<ThetaDataOptionQuote | null> {
    const contract = this.parseCompactOsiTicker(osiTicker);
    if (!contract) return null;
    return this.getOptionQuote(userId, contract);
  }

  public async getOptionQuote(userId: number | null, contract: ThetaDataContract): Promise<ThetaDataOptionQuote | null> {
    const config = await this.getConfig(userId);
    const params = new URLSearchParams({
      symbol: contract.symbol,
      expiration: contract.expiration.replace(/-/g, ''),
      right: contract.right,
      strike: contract.strike.toFixed(3),
      format: 'json'
    });

    const data = await this.fetchJson(config, `/v3/option/snapshot/quote?${params.toString()}`);
    const quote = this.firstRow(data);
    if (!quote) return null;

    const bid = Number(quote.bid ?? quote.bid_price ?? quote.bidPrice ?? 0);
    const ask = Number(quote.ask ?? quote.ask_price ?? quote.askPrice ?? 0);
    const last = Number(quote.last ?? quote.last_price ?? quote.price ?? 0);
    const mid = bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : 0;
    const mark = mid > 0 ? mid : last > 0 ? Number(last.toFixed(2)) : 0;
    if (mark <= 0) return null;

    const timestamp = this.normalizeTimestamp(quote.timestamp ?? quote.time ?? quote.datetime);
    const timestampMs = timestamp ? new Date(timestamp).getTime() : null;

    return {
      source: 'thetadata',
      ticker: this.constructOSITicker(contract.symbol, contract.strike, contract.right === 'call' ? 'CALL' : 'PUT', contract.expiration),
      bid,
      ask,
      last,
      mid,
      mark,
      spreadPct: bid > 0 && ask > 0 && mid > 0 ? Number((((ask - bid) / mid) * 100).toFixed(2)) : null,
      quoteAgeMs: timestampMs && Number.isFinite(timestampMs) ? Math.max(0, Date.now() - timestampMs) : null,
      timestamp,
      raw: quote
    };
  }

  public async getOptionOhlcHistory(
    userId: number | null,
    contract: ThetaDataContract,
    startDate: Date,
    endDate: Date,
    interval: string = '5m'
  ): Promise<Array<{ start: string; open: number; high: number; low: number; close: number; volume: number }>> {
    const config = await this.getConfig(userId);
    const params = new URLSearchParams({
      symbol: contract.symbol,
      expiration: contract.expiration.replace(/-/g, ''),
      right: contract.right,
      strike: contract.strike.toFixed(3),
      start_date: this.toThetaDate(startDate),
      end_date: this.toThetaDate(endDate),
      interval,
      format: 'json'
    });

    const data = await this.fetchJson(config, `/v3/option/history/ohlc?${params.toString()}`);
    const rows = this.rows(data);
    return rows.map((row: any) => ({
      start: String(row.timestamp || row.start || row.datetime || ''),
      open: Number(row.open || 0),
      high: Number(row.high || 0),
      low: Number(row.low || 0),
      close: Number(row.close || 0),
      volume: Number(row.volume || 0)
    })).filter((row) => row.start && row.close > 0);
  }

  public async getHealth(userId: number | null = null) {
    const config = await this.getConfig(userId);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${config.baseUrl}/v3/stock/list/symbols?format=json`, {
        headers: this.headers(config),
        signal: AbortSignal.timeout(2500)
      });
      return {
        status: res.ok ? 'UP' : 'DEGRADED',
        connected: res.ok,
        provider: 'thetadata',
        baseUrl: config.baseUrl,
        latencyMs: Date.now() - startedAt,
        lastError: res.ok ? null : `ThetaData HTTP ${res.status}`
      };
    } catch (err: any) {
      return {
        status: 'DOWN',
        connected: false,
        provider: 'thetadata',
        baseUrl: config.baseUrl,
        latencyMs: Date.now() - startedAt,
        lastError: err.message || String(err)
      };
    }
  }

  private async getConfig(userId: number | null): Promise<{ baseUrl: string; apiKey: string }> {
    let settings: Record<string, string> = {};
    if (userId) {
      settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
    } else {
      const { rows } = await (this.fastify as any).pg.query(
        `SELECT DISTINCT ON (key) key, value
         FROM settings
         WHERE key IN ('thetadata_base_url', 'thetadata_api_key')
           AND value IS NOT NULL
           AND value != ''
         ORDER BY key, updated_at DESC`
      );
      settings = rows.reduce((acc: Record<string, string>, row: any) => {
        acc[row.key] = row.value;
        return acc;
      }, {});
    }

    const envBaseUrl = String(process.env.THETADATA_BASE_URL || '');
    const baseUrl = String(settings.thetadata_base_url || envBaseUrl || 'http://127.0.0.1:25510');

    return {
      baseUrl: this.normalizeBaseUrl(baseUrl, envBaseUrl),
      apiKey: String(settings.thetadata_api_key || process.env.THETADATA_API_KEY || '').trim()
    };
  }

  private normalizeBaseUrl(baseUrl: string, envBaseUrl: string): string {
    const cleaned = baseUrl.trim().replace(/\/$/, '');
    if (!cleaned) return 'http://127.0.0.1:25510';
    if (
      envBaseUrl.trim() &&
      /^https?:\/\/(127\.0\.0\.1|localhost):255(03|10)$/i.test(cleaned)
    ) {
      return this.normalizeBaseUrl(envBaseUrl, '');
    }
    if (cleaned.endsWith(':25503')) {
      return `${cleaned.slice(0, -6)}:25510`;
    }
    return cleaned;
  }

  private async fetchJson(config: { baseUrl: string; apiKey: string }, path: string) {
    const res = await fetch(`${config.baseUrl}${path}`, {
      headers: this.headers(config),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ThetaData request failed: ${res.status}${detail ? ` - ${detail.slice(0, 300)}` : ''}`);
    }
    return res.json();
  }

  private headers(config: { apiKey: string }) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.apiKey) {
      headers['TD-TERMINAL-KEY'] = config.apiKey;
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
  }

  private firstRow(data: any): any | null {
    const rows = this.rows(data);
    if (rows.length > 0) return rows[0];
    return data && typeof data === 'object' ? data : null;
  }

  private rows(data: any): any[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.response)) return data.response;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.rows)) return data.rows;
    return [];
  }

  private parseCompactOsiTicker(ticker: string): ThetaDataContract | null {
    const match = String(ticker || '').replace(/\s+/g, '').toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, symbol, expiry, side, strikeRaw] = match;
    return {
      symbol,
      expiration: `20${expiry.slice(0, 2)}${expiry.slice(2, 4)}${expiry.slice(4, 6)}`,
      right: side === 'C' ? 'call' : 'put',
      strike: Number(strikeRaw) / 1000
    };
  }

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
    const cleanDate = dateStr.includes('-') ? dateStr.replace(/-/g, '') : dateStr;
    const yy = cleanDate.slice(2, 4);
    const mm = cleanDate.slice(4, 6);
    const dd = cleanDate.slice(6, 8);
    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${mm}${dd}${side}${strikeValue}`;
  }

  private normalizeTimestamp(value: any): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private toThetaDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}
