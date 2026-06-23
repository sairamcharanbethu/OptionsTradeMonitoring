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

export type ThetaDataOptionChainQuote = {
  source: 'thetadata_chain';
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
  raw: any;
};

export class ThetaDataService {
  constructor(private fastify: FastifyInstance) {}

  public async getOptionExpirations(userId: number | null, symbol: string): Promise<string[]> {
    const config = await this.getConfig(userId);
    const params = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      format: 'json'
    });

    const data = await this.fetchJson(config, `/v3/option/list/expirations?${params.toString()}`);
    const expirations = this.rows(data)
      .map((row: any) => this.normalizeExpirationValue(
        row?.expiration ?? row?.expiration_date ?? row?.expirationDate ?? row?.date ?? row
      ))
      .filter((value: string | null): value is string => Boolean(value));

    return [...new Set(expirations)].sort();
  }

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

  public async getOptionChainSnapshot(
    userId: number | null,
    symbol: string,
    expiration: string,
    right: 'call' | 'put' | 'both' = 'both'
  ): Promise<ThetaDataOptionChainQuote[]> {
    const config = await this.getConfig(userId);
    const params = new URLSearchParams({
      symbol,
      expiration: expiration.replace(/-/g, ''),
      right,
      strike: '*',
      format: 'json'
    });

    let data: any;
    try {
      data = await this.fetchJson(config, `/v3/option/snapshot/greeks/first_order?${params.toString()}`);
    } catch (err: any) {
      this.fastify.log.warn(`[ThetaData] First-order greeks snapshot unavailable for ${symbol} ${expiration}: ${err.message || String(err)}. Falling back to quote snapshot.`);
      data = await this.fetchJson(config, `/v3/option/snapshot/quote?${params.toString()}`);
    }

    const rows = this.rows(data);
    const openInterestByContract = await this.getOpenInterestByContract(config, symbol, expiration, right).catch((err: any) => {
      this.fastify.log.warn(`[ThetaData] Open-interest snapshot unavailable for ${symbol} ${expiration}: ${err.message || String(err)}`);
      return new Map<string, number>();
    });
    const ohlcByContract = await this.getOhlcByContract(config, symbol, expiration, right).catch((err: any) => {
      this.fastify.log.warn(`[ThetaData] OHLC snapshot unavailable for ${symbol} ${expiration}: ${err.message || String(err)}`);
      return new Map<string, any>();
    });

    return rows
      .map((row: any) => {
        const rowKey = this.contractRowKey(row);
        const openInterest = openInterestByContract.get(rowKey);
        const ohlc = ohlcByContract.get(rowKey);
        return this.normalizeChainRow(symbol, expiration, right, {
          ...row,
          ...(ohlc || {}),
          ...(openInterest === undefined ? {} : { open_interest: openInterest })
        });
      })
      .filter((row: ThetaDataOptionChainQuote | null): row is ThetaDataOptionChainQuote => Boolean(row));
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
      const res = await fetch(`${config.baseUrl}/v3/terminal/mdds/status`, {
        headers: { Accept: 'text/plain, application/json' },
        signal: AbortSignal.timeout(2500)
      });
      const body = (await res.text().catch(() => '')).trim();
      const connected = res.ok && body.toUpperCase().includes('CONNECTED');
      return {
        status: connected ? 'UP' : 'DEGRADED',
        connected,
        provider: 'thetadata',
        baseUrl: config.baseUrl,
        latencyMs: Date.now() - startedAt,
        lastError: connected ? null : `ThetaData MDDS status ${res.status}: ${body || 'empty response'}`
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

  private async getConfig(userId: number | null): Promise<{ baseUrl: string }> {
    let settings: Record<string, string> = {};
    if (userId) {
      settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
    } else {
      const { rows } = await (this.fastify as any).pg.query(
        `SELECT DISTINCT ON (key) key, value
         FROM settings
         WHERE key IN ('thetadata_base_url')
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
    const baseUrl = String(settings.thetadata_base_url || envBaseUrl || 'http://127.0.0.1:25503');

    return {
      baseUrl: this.normalizeBaseUrl(baseUrl, envBaseUrl)
    };
  }

  private normalizeBaseUrl(baseUrl: string, envBaseUrl: string): string {
    const cleaned = baseUrl.trim().replace(/\/$/, '');
    if (!cleaned) return 'http://127.0.0.1:25503';
    if (
      envBaseUrl.trim() &&
      /^https?:\/\/((127\.0\.0\.1|localhost):255(03|10)|thetadata:255(03|10))$/i.test(cleaned)
    ) {
      return this.normalizeBaseUrl(envBaseUrl, '');
    }
    if (/^https?:\/\/thetadata:255(03|10)$/i.test(cleaned)) {
      return 'http://127.0.0.1:25503';
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost):25510$/i.test(cleaned)) {
      return 'http://127.0.0.1:25503';
    }
    return cleaned;
  }

  private async fetchJson(config: { baseUrl: string }, path: string) {
    const res = await fetch(`${config.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ThetaData request failed: ${res.status}${detail ? ` - ${detail.slice(0, 300)}` : ''}`);
    }
    return res.json();
  }

  private firstRow(data: any): any | null {
    const rows = this.rows(data);
    if (rows.length > 0) return rows[0];
    return data && typeof data === 'object' ? data : null;
  }

  private rows(data: any): any[] {
    const sourceRows = Array.isArray(data)
      ? data
      : Array.isArray(data?.response)
        ? data.response
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.rows)
            ? data.rows
            : [];

    const flattened: any[] = [];
    for (const row of sourceRows) {
      if (row && typeof row === 'object' && row.contract && Array.isArray(row.data)) {
        for (const dataRow of row.data) {
          flattened.push({
            ...row.contract,
            ...dataRow,
            contract: row.contract
          });
        }
      } else {
        flattened.push(row);
      }
    }
    return flattened;
  }

  private normalizeChainRow(symbol: string, expiration: string, requestedRight: 'call' | 'put' | 'both', row: any): ThetaDataOptionChainQuote | null {
    const rawStrike = this.pickNumber(row, ['strike', 'strike_price', 'strikePrice']);
    const strike = rawStrike !== null && rawStrike > 10000 ? rawStrike / 1000 : rawStrike;
    if (strike === null || strike <= 0) return null;

    const rowRight = String(row.right ?? row.option_type ?? row.optionType ?? row.contract_type ?? row.contractType ?? requestedRight).toLowerCase();
    const right: 'call' | 'put' = rowRight.startsWith('p') ? 'put' : 'call';
    if (requestedRight !== 'both' && right !== requestedRight) return null;

    const bid = this.pickNumber(row, ['bid', 'bid_price', 'bidPrice']);
    const ask = this.pickNumber(row, ['ask', 'ask_price', 'askPrice']);
    const last = this.pickNumber(row, ['last', 'last_price', 'lastPrice', 'price', 'close']);
    const mid = bid !== null && ask !== null && bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : null;
    const mark = mid !== null ? mid : last !== null && last > 0 ? Number(last.toFixed(2)) : null;
    const spread = bid !== null && ask !== null && bid > 0 && ask > 0 ? Number((ask - bid).toFixed(2)) : null;
    const spreadPct = spread !== null && mark !== null && mark > 0 ? Number(((spread / mark) * 100).toFixed(2)) : null;
    const normalizedExpiration = String(row.expiration ?? row.expiration_date ?? row.expirationDate ?? expiration).split('T')[0];

    return {
      source: 'thetadata_chain',
      ticker: String(row.ticker ?? row.osi ?? this.constructOSITicker(symbol, strike, right === 'call' ? 'CALL' : 'PUT', normalizedExpiration)),
      symbol: symbol.toUpperCase(),
      expiration: normalizedExpiration,
      right,
      strike,
      bid,
      ask,
      last,
      mark,
      spread,
      spreadPct,
      volume: this.pickNumber(row, ['volume', 'day_volume', 'dayVolume']),
      openInterest: this.pickNumber(row, ['open_interest', 'openInterest', 'oi']),
      delta: this.pickNumber(row, ['delta']),
      gamma: this.pickNumber(row, ['gamma']),
      theta: this.pickNumber(row, ['theta']),
      vega: this.pickNumber(row, ['vega']),
      impliedVolatility: this.pickNumber(row, ['implied_vol', 'implied_volatility', 'impliedVolatility', 'iv', 'bid_iv', 'mid_iv', 'ask_iv']),
      raw: row
    };
  }

  private async getOpenInterestByContract(
    config: { baseUrl: string },
    symbol: string,
    expiration: string,
    right: 'call' | 'put' | 'both'
  ): Promise<Map<string, number>> {
    const params = new URLSearchParams({
      symbol,
      expiration: expiration.replace(/-/g, ''),
      right,
      strike: '*',
      format: 'json'
    });
    const data = await this.fetchJson(config, `/v3/option/snapshot/open_interest?${params.toString()}`);
    const result = new Map<string, number>();
    for (const row of this.rows(data)) {
      const openInterest = this.pickNumber(row, ['open_interest', 'openInterest', 'oi']);
      if (openInterest !== null) result.set(this.contractRowKey(row), openInterest);
    }
    return result;
  }

  private async getOhlcByContract(
    config: { baseUrl: string },
    symbol: string,
    expiration: string,
    right: 'call' | 'put' | 'both'
  ): Promise<Map<string, any>> {
    const params = new URLSearchParams({
      symbol,
      expiration: expiration.replace(/-/g, ''),
      right,
      strike: '*',
      format: 'json'
    });
    const data = await this.fetchJson(config, `/v3/option/snapshot/ohlc?${params.toString()}`);
    const result = new Map<string, any>();
    for (const row of this.rows(data)) {
      result.set(this.contractRowKey(row), row);
    }
    return result;
  }

  private contractRowKey(row: any): string {
    const contract = row?.contract || row || {};
    const symbol = String(contract.symbol ?? contract.root ?? row?.symbol ?? row?.root ?? '').toUpperCase();
    const expiration = String(
      contract.expiration ?? contract.expiration_date ?? contract.expirationDate ??
      row?.expiration ?? row?.expiration_date ?? row?.expirationDate ?? ''
    ).replace(/-/g, '');
    const rawRight = String(
      contract.right ?? contract.option_type ?? contract.optionType ??
      row?.right ?? row?.option_type ?? row?.optionType ?? ''
    ).toUpperCase();
    const right = rawRight.startsWith('P') ? 'P' : 'C';
    const rawStrike = Number(contract.strike ?? contract.strike_price ?? contract.strikePrice ?? row?.strike ?? row?.strike_price ?? row?.strikePrice ?? 0);
    const strike = rawStrike > 10000 ? rawStrike / 1000 : rawStrike;
    return `${symbol}:${expiration}:${right}:${strike.toFixed(3)}`;
  }

  private pickNumber(row: any, keys: string[]): number | null {
    for (const key of keys) {
      const value = row?.[key];
      if (value === null || value === undefined || value === '') continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private normalizeExpirationValue(value: any): string | null {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).trim();
    const compact = raw.replace(/-/g, '').slice(0, 8);
    if (!/^\d{8}$/.test(compact)) return null;
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
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
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    const raw = String(value).trim();
    const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    if (!hasExplicitTimezone) {
      const dateTimeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
      if (dateTimeMatch) {
        return this.dateAtEt(
          dateTimeMatch[1],
          Number(dateTimeMatch[2]),
          Number(dateTimeMatch[3]),
          Number(dateTimeMatch[4] || 0),
          Number((dateTimeMatch[5] || '0').padEnd(3, '0'))
        ).toISOString();
      }
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private dateAtEt(dateKey: string, hour: number, minute: number, second = 0, millisecond = 0): Date {
    const [year, month, day] = dateKey.split('-').map((part) => Number(part));
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(utcGuess);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const representedEtAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'), millisecond);
    const intendedEtAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    return new Date(utcGuess.getTime() + (intendedEtAsUtc - representedEtAsUtc));
  }

  private toThetaDate(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}
