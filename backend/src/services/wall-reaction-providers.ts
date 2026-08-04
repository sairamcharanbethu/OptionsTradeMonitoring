import { readFile } from 'fs/promises';
import path from 'path';

export type WallReactionSymbol = 'SPY' | 'QQQ';

export type EconomicEvent = {
  id: string;
  name: string;
  country: string;
  importance: number;
  scheduledAt: string;
};

export type EconomicCalendarSnapshot = {
  fetchedAt: string;
  events: EconomicEvent[];
};

export type ZeroGexWallSnapshot = {
  symbol: WallReactionSymbol;
  fetchedAt: string;
  raw: Record<string, any>;
};

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});

function dateParts(date: Date): string {
  return ET_DATE.format(date);
}

function safeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const millis = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

export function providerAgeSeconds(value: unknown, now = new Date()): number | null {
  const timestamp = safeTimestamp(value);
  return timestamp === null ? null : (now.getTime() - timestamp) / 1000;
}

export function normalizeTradingEconomicsEvents(payload: unknown): EconomicEvent[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row: any) => {
    const rawDate = row?.Date ?? row?.date;
    const utcDate = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(rawDate)
      ? `${rawDate}Z`
      : rawDate;
    const scheduledAt = safeTimestamp(utcDate);
    const importance = Number(row?.Importance ?? row?.importance);
    const country = String(row?.Country ?? row?.country ?? '').trim();
    const name = String(row?.Event ?? row?.event ?? row?.Category ?? row?.category ?? '').trim();
    if (scheduledAt === null || !name || country.toLowerCase() !== 'united states' || importance !== 3) return [];
    return [{
      id: String(row?.CalendarID ?? row?.calendarId ?? `${scheduledAt}:${name}`),
      name,
      country,
      importance,
      scheduledAt: new Date(scheduledAt).toISOString()
    }];
  }).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

export function blockingEconomicEvent(
  snapshot: EconomicCalendarSnapshot | null,
  now = new Date(),
  maxSnapshotAgeMs = 30 * 60 * 1000
): { blocked: boolean; reason: string; event: EconomicEvent | null } {
  if (!snapshot) return { blocked: true, reason: 'Economic calendar is unavailable', event: null };
  const fetchedAt = safeTimestamp(snapshot.fetchedAt);
  if (fetchedAt === null || fetchedAt > now.getTime() + 5_000 || now.getTime() - fetchedAt > maxSnapshotAgeMs) {
    return { blocked: true, reason: 'Economic calendar is stale', event: null };
  }
  for (const event of snapshot.events) {
    const eventAt = safeTimestamp(event.scheduledAt);
    if (eventAt === null) continue;
    const minutes = (now.getTime() - eventAt) / 60_000;
    if (minutes >= -30 && minutes <= 15) {
      return { blocked: true, reason: `${event.name} macro window`, event };
    }
  }
  return { blocked: false, reason: '', event: null };
}

export class WallReactionProviders {
  private calendar: EconomicCalendarSnapshot | null = null;
  private calendarPromise: Promise<EconomicCalendarSnapshot> | null = null;

  constructor(
    private readonly dataDir = process.env.STRATEGY_DATA_DIR || '/strategy-data/trade',
    private readonly request: typeof fetch = fetch
  ) {}

  public zeroGexPath(symbol: WallReactionSymbol): string {
    return symbol === 'SPY'
      ? path.join(this.dataDir, 'zerogex.json')
      : path.join(path.dirname(this.dataDir), 'wall-reaction', 'QQQ-zerogex.json');
  }

  public async readZeroGex(symbol: WallReactionSymbol): Promise<ZeroGexWallSnapshot> {
    const snapshotPath = this.zeroGexPath(symbol);
    let raw: Record<string, any>;
    try {
      raw = JSON.parse(await readFile(snapshotPath, 'utf8'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        const service = symbol === 'QQQ' ? 'zerogex-prefetch-qqq' : 'zerogex-prefetch';
        throw new Error(`ZeroGEX ${symbol} provider unavailable: ${service} has not produced its snapshot`);
      }
      throw new Error(`ZeroGEX ${symbol} snapshot could not be read: ${error?.message || String(error)}`);
    }
    if (!raw || typeof raw !== 'object' || String(raw.symbol || '').toUpperCase() !== symbol) {
      throw new Error(`ZeroGEX ${symbol} snapshot is missing or has the wrong symbol`);
    }
    const fetchedAt = Number(raw.fetched_at);
    if (!Number.isFinite(fetchedAt)) throw new Error(`ZeroGEX ${symbol} snapshot has no fetch timestamp`);
    return { symbol, fetchedAt: new Date(fetchedAt * 1000).toISOString(), raw };
  }

  public async refreshCalendar(apiKey: string, now = new Date()): Promise<EconomicCalendarSnapshot> {
    if (!String(apiKey || '').trim()) throw new Error('Trading Economics API key is not configured');
    if (this.calendarPromise) return this.calendarPromise;
    this.calendarPromise = this.fetchCalendar(apiKey, now).finally(() => { this.calendarPromise = null; });
    return this.calendarPromise;
  }

  private async fetchCalendar(apiKey: string, now: Date): Promise<EconomicCalendarSnapshot> {
    const from = dateParts(now);
    const to = dateParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const url = `https://api.tradingeconomics.com/calendar/country/united%20states/${from}/${to}?importance=3&f=json`;
    const response = await this.request(url, {
      headers: { Accept: 'application/json', Authorization: `Client ${String(apiKey).trim()}` },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`Trading Economics calendar request failed (${response.status})`);
    const snapshot = { fetchedAt: now.toISOString(), events: normalizeTradingEconomicsEvents(await response.json()) };
    this.calendar = snapshot;
    return snapshot;
  }

  public getCalendar(): EconomicCalendarSnapshot | null {
    return this.calendar;
  }
}
