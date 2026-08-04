import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { WALL_REACTION_BUNDLED_EVENTS, WALL_REACTION_CALENDAR_COVERAGE } from './wall-reaction-economic-calendar';

export type WallReactionSymbol = 'SPY' | 'QQQ';

export type EconomicEvent = {
  id: string;
  name: string;
  country: string;
  importance: number;
  source: string;
  scheduledAt: string;
};

export type EconomicCalendarSnapshot = {
  fetchedAt: string;
  coverageStart: string;
  coverageThrough: string;
  events: EconomicEvent[];
};

export type EconomicCalendarHealth = {
  status: 'READY' | 'DEGRADED' | 'COVERAGE_MISSING';
  coverageStart: string;
  coverageThrough: string;
  lastRefreshAt: string | null;
  lastError: string | null;
  eventCount: number;
  nextEvent: EconomicEvent | null;
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

function bundledCalendar(): EconomicCalendarSnapshot {
  return {
    fetchedAt: WALL_REACTION_CALENDAR_COVERAGE.reviewedAt,
    coverageStart: WALL_REACTION_CALENDAR_COVERAGE.startsOn,
    coverageThrough: WALL_REACTION_CALENDAR_COVERAGE.endsOn,
    events: WALL_REACTION_BUNDLED_EVENTS.map((event) => ({
      ...event, country: 'United States', importance: 3
    }))
  };
}

export function normalizeBeaEvents(payload: unknown): EconomicEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const dates = (payload as any)?.['Personal Income and Outlays']?.release_dates;
  if (!Array.isArray(dates)) return [];
  return dates.flatMap((value: unknown) => {
    const scheduledAt = safeTimestamp(value);
    if (scheduledAt === null) return [];
    const iso = new Date(scheduledAt).toISOString();
    return [{
      id: `bea-pio-${iso.slice(0, 10)}`,
      name: 'Personal Income and Outlays (PCE)',
      country: 'United States',
      importance: 3,
      source: 'BEA',
      scheduledAt: iso
    }];
  }).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

export function mergeEconomicEvents(...groups: EconomicEvent[][]): EconomicEvent[] {
  const merged = new Map<string, EconomicEvent>();
  for (const event of groups.flat()) {
    const timestamp = safeTimestamp(event.scheduledAt);
    if (timestamp === null || !event.name || !event.source) continue;
    const normalized = { ...event, scheduledAt: new Date(timestamp).toISOString() };
    merged.set(`${normalized.source}:${normalized.name}:${normalized.scheduledAt}`, normalized);
  }
  return [...merged.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

function calendarWithBeaEvents(beaEvents: EconomicEvent[], fetchedAt?: string): EconomicCalendarSnapshot {
  const baseline = bundledCalendar();
  if (beaEvents.length === 0) return baseline;
  return {
    ...baseline,
    fetchedAt: fetchedAt || baseline.fetchedAt,
    events: mergeEconomicEvents(baseline.events.filter((event) => !event.id.startsWith('bea-pio-')), beaEvents)
  };
}

export function calendarCoversDate(snapshot: EconomicCalendarSnapshot | null, now = new Date()): boolean {
  if (!snapshot) return false;
  const date = dateParts(now);
  return /^\d{4}-\d{2}-\d{2}$/.test(snapshot.coverageStart)
    && /^\d{4}-\d{2}-\d{2}$/.test(snapshot.coverageThrough)
    && date >= snapshot.coverageStart && date <= snapshot.coverageThrough;
}

export function blockingEconomicEvent(
  snapshot: EconomicCalendarSnapshot | null,
  now = new Date(),
  _maxSnapshotAgeMs?: number
): { blocked: boolean; reason: string; event: EconomicEvent | null } {
  if (!snapshot) return { blocked: true, reason: 'Economic calendar is unavailable', event: null };
  const fetchedAt = safeTimestamp(snapshot.fetchedAt);
  if (fetchedAt === null || fetchedAt > now.getTime() + 5_000 || !calendarCoversDate(snapshot, now)) {
    return { blocked: true, reason: `Economic calendar coverage is unavailable for ${dateParts(now)}`, event: null };
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
  private calendar: EconomicCalendarSnapshot = bundledCalendar();
  private calendarPromise: Promise<EconomicCalendarSnapshot> | null = null;
  private cacheLoaded = false;
  private cachedBeaEvents: EconomicEvent[] = [];
  private lastCalendarRefresh: string | null = null;
  private lastCalendarError: string | null = null;

  constructor(
    private readonly dataDir = process.env.STRATEGY_DATA_DIR || '/strategy-data/trade',
    private readonly request: typeof fetch = fetch
  ) {}

  public zeroGexPath(symbol: WallReactionSymbol): string {
    return symbol === 'SPY'
      ? path.join(this.dataDir, 'zerogex.json')
      : path.join(path.dirname(this.dataDir), 'wall-reaction', 'QQQ-zerogex.json');
  }

  public calendarCachePath(): string {
    return path.join(path.dirname(this.dataDir), 'wall-reaction', 'economic-calendar.json');
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

  public async refreshCalendar(now = new Date()): Promise<EconomicCalendarSnapshot> {
    if (this.calendarPromise) return this.calendarPromise;
    this.calendarPromise = this.fetchCalendar(now).finally(() => { this.calendarPromise = null; });
    return this.calendarPromise;
  }

  private async loadCalendarCache(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      const cached = JSON.parse(await readFile(this.calendarCachePath(), 'utf8'));
      if (!cached || !Array.isArray(cached.events)) throw new Error('invalid cache payload');
      this.cachedBeaEvents = normalizeBeaEvents({ 'Personal Income and Outlays': { release_dates: cached.events.map((event: any) => event?.scheduledAt) } });
      this.calendar = calendarWithBeaEvents(this.cachedBeaEvents);
      const savedAt = safeTimestamp(cached.savedAt);
      this.lastCalendarRefresh = savedAt === null ? null : new Date(savedAt).toISOString();
    } catch (error: any) {
      if (error?.code !== 'ENOENT') this.lastCalendarError = `Persisted calendar cache could not be loaded: ${error?.message || String(error)}`;
    }
  }

  private async persistCalendarCache(events: EconomicEvent[], now: Date): Promise<void> {
    const cachePath = this.calendarCachePath();
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify({ savedAt: now.toISOString(), events }, null, 2), 'utf8');
    await rename(temporaryPath, cachePath);
  }

  private async fetchCalendar(now: Date): Promise<EconomicCalendarSnapshot> {
    await this.loadCalendarCache();
    const response = await this.request('https://apps.bea.gov/API/signup/release_dates.json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) {
      this.lastCalendarError = `BEA calendar request failed (${response.status})`;
      throw new Error(this.lastCalendarError);
    }
    const beaEvents = normalizeBeaEvents(await response.json());
    if (beaEvents.length === 0) {
      this.lastCalendarError = 'BEA calendar returned no Personal Income and Outlays releases';
      throw new Error(this.lastCalendarError);
    }
    this.cachedBeaEvents = beaEvents;
    this.calendar = calendarWithBeaEvents(beaEvents, now.toISOString());
    this.lastCalendarRefresh = now.toISOString();
    try {
      await this.persistCalendarCache(beaEvents, now);
      this.lastCalendarError = null;
    } catch (error: any) {
      this.lastCalendarError = `BEA calendar refreshed but could not be persisted: ${error?.message || String(error)}`;
      throw new Error(this.lastCalendarError);
    }
    return this.calendar;
  }

  public getCalendar(): EconomicCalendarSnapshot {
    return this.calendar;
  }

  public getCalendarHealth(now = new Date()): EconomicCalendarHealth {
    const covered = calendarCoversDate(this.calendar, now);
    const coveredEvents = this.calendar.events.filter((event) => {
      const date = event.scheduledAt.slice(0, 10);
      return date >= this.calendar.coverageStart && date <= this.calendar.coverageThrough;
    });
    return {
      status: covered ? this.lastCalendarError ? 'DEGRADED' : 'READY' : 'COVERAGE_MISSING',
      coverageStart: this.calendar.coverageStart,
      coverageThrough: this.calendar.coverageThrough,
      lastRefreshAt: this.lastCalendarRefresh,
      lastError: this.lastCalendarError,
      eventCount: coveredEvents.length,
      nextEvent: coveredEvents.find((event) => Date.parse(event.scheduledAt) >= now.getTime()) || null
    };
  }
}
