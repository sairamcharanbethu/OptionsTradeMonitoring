import axios from 'axios';
import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import { getGlobalSettings } from '../lib/settings-utils';

/**
 * ZeroGEX replay archive.
 *
 * ZeroGEX keeps ~30 sessions of 1-minute replay frames (headline flip/walls +
 * per-strike GEX) and then drops them. With the Unusual Whales subscription
 * gone these frames are the only GEX history this system can still obtain, and
 * they are what the live engine actually sees, so they are the right levels to
 * validate the wall setups against. This service:
 *   - archives every retained session into Postgres on startup (backfill),
 *   - archives the just-finished session every weekday after the close,
 *   - exposes backfill/status for the admin routes and a manual script.
 *
 * Frames are stored raw (jsonb) keyed by (symbol, frame_ts); the per-session
 * row keeps counts and the source path. Parsing is deliberately defensive
 * because the range payload shape is vendor-owned.
 */

export const ZEROGEX_BASE_URL = process.env.ZEROGEX_BASE_URL || 'https://api.zerogex.io';
const DEFAULT_SYMBOL = 'SPY';
const DEFAULT_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 90_000;
const BETWEEN_SESSIONS_MS = 1_500;

export type ReplayFetcher = (path: string, params: Record<string, any>, apiKey: string) => Promise<any>;

export interface ArchiveSummary {
  symbol: string;
  listed: string[];
  archived: string[];
  skipped: string[];
  failed: Array<{ date: string; error: string }>;
  frames: number;
}

export function unwrapEnvelope(payload: any): any {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

/** Sessions endpoint items may be strings or objects; normalise to YYYY-MM-DD, newest first. */
export function normalizeSessionDates(data: any): string[] {
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.sessions) ? data.sessions
    : Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.dates) ? data.dates
    : [];
  const dates = new Set<string>();
  for (const item of list) {
    const raw = typeof item === 'string' ? item
      : item?.date ?? item?.session_date ?? item?.session ?? item?.trading_date ?? item?.day ?? null;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw ?? ''));
    if (match) dates.add(match[1]);
  }
  return Array.from(dates).sort().reverse();
}

export function frameTimestamp(frame: any): Date | null {
  const raw = frame?.ts ?? frame?.timestamp ?? frame?.time ?? frame?.t ?? frame?.as_of ?? frame?.asOf ?? null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const date = new Date(String(raw));
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Find the frame array in a range payload regardless of the wrapper key. */
export function extractFrames(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['frames', 'items', 'bars', 'data', 'results', 'series']) {
    if (Array.isArray(data[key])) return data[key];
  }
  const candidate = Object.values(data).find((value) => Array.isArray(value) && value.length > 0 && typeof value[0] === 'object');
  return Array.isArray(candidate) ? candidate : [];
}

export const defaultFetcher: ReplayFetcher = async (path, params, apiKey) => {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'StrikePilot-Archive/1.0' };
  try {
    const response = await axios.get(`${ZEROGEX_BASE_URL}/api/v2${path}`, { params, headers, timeout: REQUEST_TIMEOUT_MS });
    return response.data;
  } catch (err: any) {
    if (err?.response?.status === 404) {
      const response = await axios.get(`${ZEROGEX_BASE_URL}/api${path}`, { params, headers, timeout: REQUEST_TIMEOUT_MS });
      return response.data;
    }
    throw err;
  }
};

export class ZeroGexArchiveService {
  private started = false;
  private running: Promise<ArchiveSummary> | null = null;

  constructor(private fastify: FastifyInstance, private fetcher: ReplayFetcher = defaultFetcher) {}

  private get pg(): any {
    return (this.fastify as any).pg;
  }

  static async ensureSchema(pg: any): Promise<void> {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS zerogex_replay_sessions (
        symbol VARCHAR(12) NOT NULL,
        session_date DATE NOT NULL,
        frame_count INTEGER NOT NULL DEFAULT 0,
        first_ts TIMESTAMPTZ,
        last_ts TIMESTAMPTZ,
        source_path TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        raw JSONB,
        PRIMARY KEY (symbol, session_date)
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS zerogex_replay_frames (
        symbol VARCHAR(12) NOT NULL,
        session_date DATE NOT NULL,
        frame_ts TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        PRIMARY KEY (symbol, frame_ts)
      )
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS zerogex_replay_frames_session_idx ON zerogex_replay_frames (symbol, session_date)`);
  }

  async resolveApiKey(): Promise<string | null> {
    try {
      const settings = await getGlobalSettings(this.pg);
      const fromSettings = String(settings?.zerogex_api_key || '').trim();
      if (fromSettings) return fromSettings;
    } catch (err: any) {
      this.fastify.log.warn(`[ZeroGexArchive] settings lookup failed: ${err?.message || String(err)}`);
    }
    const fromEnv = String(process.env.ZEROGEX_API_KEY || '').trim();
    return fromEnv || null;
  }

  async listSessions(symbol = DEFAULT_SYMBOL, limit = DEFAULT_LIMIT, apiKey?: string): Promise<string[]> {
    const key = apiKey || await this.resolveApiKey();
    if (!key) throw new Error('ZeroGEX API key is not configured');
    const data = unwrapEnvelope(await this.fetcher('/replay/sessions', { symbol: symbol.toUpperCase(), limit }, key));
    return normalizeSessionDates(data);
  }

  async archivedDates(symbol = DEFAULT_SYMBOL): Promise<Set<string>> {
    const { rows } = await this.pg.query(
      `SELECT to_char(session_date, 'YYYY-MM-DD') AS session_date FROM zerogex_replay_sessions WHERE symbol = $1 AND frame_count > 0`,
      [symbol.toUpperCase()]
    );
    return new Set((rows || []).map((row: any) => String(row.session_date)));
  }

  /** Archive one session. Returns the number of frames stored (0 = nothing usable in the payload). */
  async archiveSession(date: string, symbol = DEFAULT_SYMBOL, apiKey?: string): Promise<number> {
    const key = apiKey || await this.resolveApiKey();
    if (!key) throw new Error('ZeroGEX API key is not configured');
    const sym = symbol.toUpperCase();
    const path = '/replay/range';
    const params = { symbol: sym, date, timeframe: '1min', strike_band_pct: 0.04, include_expirations: false, max_expirations: 6 };
    const data = unwrapEnvelope(await this.fetcher(path, params, key));
    const frames = extractFrames(data);
    const rows: Array<{ ts: Date; frame: any }> = [];
    for (const frame of frames) {
      const ts = frameTimestamp(frame);
      if (ts) rows.push({ ts, frame });
    }
    rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const chunk = 200;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const values: any[] = [];
        const placeholders = slice.map((row, idx) => {
          values.push(sym, date, row.ts.toISOString(), JSON.stringify(row.frame));
          const base = idx * 4;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`;
        });
        await client.query(
          `INSERT INTO zerogex_replay_frames (symbol, session_date, frame_ts, payload)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (symbol, frame_ts) DO UPDATE SET payload = EXCLUDED.payload, session_date = EXCLUDED.session_date`,
          values
        );
      }
      await client.query(
        `INSERT INTO zerogex_replay_sessions (symbol, session_date, frame_count, first_ts, last_ts, source_path, fetched_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7::jsonb)
         ON CONFLICT (symbol, session_date) DO UPDATE
           SET frame_count = EXCLUDED.frame_count, first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts,
               source_path = EXCLUDED.source_path, fetched_at = NOW(), raw = EXCLUDED.raw`,
        [
          sym, date, rows.length,
          rows.length ? rows[0].ts.toISOString() : null,
          rows.length ? rows[rows.length - 1].ts.toISOString() : null,
          `${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`,
          // Keep the raw payload only when we could not parse frames, so the
          // data is never lost to a shape change; otherwise the frames table is the record.
          rows.length ? null : JSON.stringify(data ?? null)
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return rows.length;
  }

  /** Archive every retained session that is not yet stored (or all when force). Serialised. */
  backfill(options: { symbol?: string; limit?: number; force?: boolean } = {}): Promise<ArchiveSummary> {
    if (this.running) return this.running;
    this.running = this.runBackfill(options).finally(() => { this.running = null; });
    return this.running;
  }

  private async runBackfill(options: { symbol?: string; limit?: number; force?: boolean }): Promise<ArchiveSummary> {
    const symbol = (options.symbol || DEFAULT_SYMBOL).toUpperCase();
    const summary: ArchiveSummary = { symbol, listed: [], archived: [], skipped: [], failed: [], frames: 0 };
    const key = await this.resolveApiKey();
    if (!key) {
      this.fastify.log.warn('[ZeroGexArchive] no ZeroGEX API key configured; archive skipped');
      return summary;
    }
    const listed = await this.listSessions(symbol, options.limit ?? DEFAULT_LIMIT, key);
    summary.listed = listed;
    const have = options.force ? new Set<string>() : await this.archivedDates(symbol);
    for (const date of listed) {
      if (have.has(date)) { summary.skipped.push(date); continue; }
      try {
        const count = await this.archiveSession(date, symbol, key);
        summary.frames += count;
        if (count > 0) summary.archived.push(date);
        else summary.failed.push({ date, error: 'no parsable frames in payload (raw kept)' });
      } catch (err: any) {
        summary.failed.push({ date, error: err?.response?.status ? `HTTP ${err.response.status}` : (err?.message || String(err)) });
      }
      await new Promise((resolve) => setTimeout(resolve, BETWEEN_SESSIONS_MS));
    }
    this.fastify.log.info(`[ZeroGexArchive] ${symbol}: listed ${listed.length}, archived ${summary.archived.length} (${summary.frames} frames), skipped ${summary.skipped.length}, failed ${summary.failed.length}`);
    return summary;
  }

  async status(symbol = DEFAULT_SYMBOL): Promise<any> {
    const { rows } = await this.pg.query(
      `SELECT to_char(session_date, 'YYYY-MM-DD') AS session_date, frame_count, first_ts, last_ts, fetched_at
         FROM zerogex_replay_sessions WHERE symbol = $1 ORDER BY session_date DESC`,
      [symbol.toUpperCase()]
    );
    return { symbol: symbol.toUpperCase(), sessions: rows || [], running: Boolean(this.running) };
  }

  /** Startup backfill (delayed so it never competes with boot) + weekday post-close archive. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (String(process.env.ZEROGEX_ARCHIVE_ENABLED ?? 'true').toLowerCase() === 'false') {
      this.fastify.log.info('[ZeroGexArchive] disabled (ZEROGEX_ARCHIVE_ENABLED=false)');
      return;
    }
    setTimeout(() => {
      this.backfill().catch((err: any) => this.fastify.log.warn(`[ZeroGexArchive] startup backfill failed: ${err?.message || String(err)}`));
    }, 60_000).unref?.();
    // 16:35 ET on weekdays: the session just closed and its final frames exist.
    const schedule = process.env.ZEROGEX_ARCHIVE_SCHEDULE || '35 16 * * 1-5';
    cron.schedule(schedule, () => {
      this.backfill().catch((err: any) => this.fastify.log.warn(`[ZeroGexArchive] scheduled archive failed: ${err?.message || String(err)}`));
    }, { timezone: 'America/New_York' });
    this.fastify.log.info(`[ZeroGexArchive] scheduled (${schedule} America/New_York); startup backfill in 60s`);
  }
}
