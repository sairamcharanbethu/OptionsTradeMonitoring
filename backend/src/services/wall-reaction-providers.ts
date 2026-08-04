import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { WALL_REACTION_BUNDLED_EVENTS, WALL_REACTION_CALENDAR_COVERAGE } from './wall-reaction-economic-calendar';

export type WallReactionSymbol = 'SPY' | 'QQQ';
export type EconomicEventImpact = 'BLOCKING' | 'INFORMATIONAL';
export type CalendarSourceMode = 'LIVE' | 'CACHED' | 'BUNDLED';

export type EconomicEvent = {
  id: string;
  name: string;
  country: string;
  importance: number;
  impact: EconomicEventImpact;
  source: string;
  scheduledAt: string;
};

export type CalendarSourceHealth = {
  source: string;
  mode: CalendarSourceMode;
  lastRefreshAt: string | null;
  lastError: string | null;
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
  blockingEventCount: number;
  informationalEventCount: number;
  nextEvent: EconomicEvent | null;
  nextBlockingEvent: EconomicEvent | null;
  upcomingEvents: EconomicEvent[];
  sources: CalendarSourceHealth[];
};

export type ZeroGexWallSnapshot = {
  symbol: WallReactionSymbol;
  fetchedAt: string;
  raw: Record<string, any>;
};

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const BLS_CALENDAR_URL = 'https://www.bls.gov/schedule/news_release/bls.ics';
const BEA_CALENDAR_URL = 'https://apps.bea.gov/API/signup/release_dates.json';
const BLS_BLOCKING_RELEASES = new Set([
  'Consumer Price Index',
  'Employment Situation',
  'Job Openings and Labor Turnover Survey',
  'Producer Price Index'
]);

function dateParts(date: Date): string {
  return ET_DATE.format(date);
}

function safeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const millis = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function eventImpact(value: unknown, importance?: unknown): EconomicEventImpact {
  if (value === 'BLOCKING' || value === 'INFORMATIONAL') return value;
  return Number(importance) >= 3 ? 'BLOCKING' : 'INFORMATIONAL';
}

function localEasternTimestamp(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match) return null;
  const desired = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = desired;
  if (match[7] === 'Z') return Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(ET_PARTS.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    timestamp += Date.UTC(year, month - 1, day, hour, minute, second) - represented;
  }
  return Number.isFinite(timestamp) ? timestamp : null;
}

function unescapeIcal(value: string): string {
  return value.replace(/\\[nN]/g, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

export function normalizeBlsEvents(payload: unknown): EconomicEvent[] {
  if (typeof payload !== 'string' || !payload.includes('BEGIN:VCALENDAR')) return [];
  const unfolded = payload.replace(/\r/g, '').replace(/\n[ \t]/g, '');
  const events: EconomicEvent[] = [];
  for (const block of unfolded.matchAll(/BEGIN:VEVENT\n([\s\S]*?)\nEND:VEVENT/g)) {
    const lines = block[1].split('\n');
    const summaryLine = lines.find((line) => line.startsWith('SUMMARY:'));
    const startLine = lines.find((line) => line.startsWith('DTSTART'));
    const uidLine = lines.find((line) => line.startsWith('UID:'));
    if (!summaryLine || !startLine) continue;
    const start = /^DTSTART(?:;[^:]*)?:(\d{8}T\d{6}Z?)$/.exec(startLine);
    const timestamp = start ? localEasternTimestamp(start[1]) : null;
    const name = unescapeIcal(summaryLine.slice('SUMMARY:'.length));
    if (timestamp === null || !name) continue;
    const scheduledAt = new Date(timestamp).toISOString();
    const uid = uidLine ? unescapeIcal(uidLine.slice('UID:'.length)).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) : '';
    const impact: EconomicEventImpact = BLS_BLOCKING_RELEASES.has(name) ? 'BLOCKING' : 'INFORMATIONAL';
    events.push({
      id: uid ? `bls-${uid}` : `bls-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${scheduledAt}`,
      name, country: 'United States', importance: impact === 'BLOCKING' ? 3 : 1,
      impact, source: 'BLS', scheduledAt
    });
  }
  return mergeEconomicEvents(events);
}

function isUsableBlsCalendar(events: EconomicEvent[]): boolean {
  const covered = events.filter((event) => {
    const date = event.scheduledAt.slice(0, 10);
    return date >= WALL_REACTION_CALENDAR_COVERAGE.startsOn && date <= WALL_REACTION_CALENDAR_COVERAGE.endsOn;
  });
  return events.length >= BLS_BLOCKING_RELEASES.size
    && [...BLS_BLOCKING_RELEASES].every((name) => covered.some((event) => event.name === name && event.impact === 'BLOCKING'));
}

export function normalizeCachedEvents(payload: unknown): EconomicEvent[] {
  if (!Array.isArray(payload)) return [];
  return mergeEconomicEvents(payload.flatMap((value: any) => {
    if (!value || typeof value !== 'object') return [];
    const timestamp = safeTimestamp(value.scheduledAt);
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const source = typeof value.source === 'string' ? value.source.trim() : '';
    if (timestamp === null || !name || !source) return [];
    const impact = eventImpact(value.impact, value.importance);
    return [{
      id: typeof value.id === 'string' && value.id ? value.id : `${source}-${name}-${timestamp}`,
      name, country: 'United States', importance: impact === 'BLOCKING' ? 3 : 1,
      impact, source, scheduledAt: new Date(timestamp).toISOString()
    }];
  }));
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
      ...event, country: 'United States', impact: event.impact || 'BLOCKING',
      importance: event.impact === 'INFORMATIONAL' ? 1 : 3
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
      impact: 'BLOCKING' as const,
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
    const impact = eventImpact(event.impact, event.importance);
    const normalized = { ...event, impact, importance: impact === 'BLOCKING' ? 3 : 1, scheduledAt: new Date(timestamp).toISOString() };
    merged.set(`${normalized.source}:${normalized.name}:${normalized.scheduledAt}`, normalized);
  }
  return [...merged.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

function calendarWithLiveEvents(blsEvents: EconomicEvent[], beaEvents: EconomicEvent[], fetchedAt?: string): EconomicCalendarSnapshot {
  const baseline = bundledCalendar();
  const retained = baseline.events.filter((event) => {
    if (blsEvents.length > 0 && event.source === 'BLS') return false;
    if (beaEvents.length > 0 && event.id.startsWith('bea-pio-')) return false;
    return true;
  });
  return {
    ...baseline,
    fetchedAt: fetchedAt || baseline.fetchedAt,
    events: mergeEconomicEvents(retained, blsEvents, beaEvents)
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
    if (eventImpact(event.impact, event.importance) !== 'BLOCKING') continue;
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
  private cachedBlsEvents: EconomicEvent[] = [];
  private cachedBeaEvents: EconomicEvent[] = [];
  private lastCalendarRefresh: string | null = null;
  private lastCalendarError: string | null = null;
  private sourceState: Record<'BLS' | 'BEA', CalendarSourceHealth> = {
    BLS: { source: 'BLS', mode: 'BUNDLED', lastRefreshAt: null, lastError: null },
    BEA: { source: 'BEA', mode: 'BUNDLED', lastRefreshAt: null, lastError: null }
  };

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
      const events = normalizeCachedEvents(cached.events);
      const cachedBlsEvents = events.filter((event) => event.source === 'BLS');
      this.cachedBlsEvents = isUsableBlsCalendar(cachedBlsEvents) ? cachedBlsEvents : [];
      this.cachedBeaEvents = events.filter((event) => event.source === 'BEA');
      const savedAt = safeTimestamp(cached.savedAt);
      this.lastCalendarRefresh = savedAt === null ? null : new Date(savedAt).toISOString();
      const blsSavedAt = safeTimestamp(cached.sources?.BLS?.lastRefreshAt);
      const beaSavedAt = safeTimestamp(cached.sources?.BEA?.lastRefreshAt);
      if (this.cachedBlsEvents.length > 0) this.sourceState.BLS = { source: 'BLS', mode: 'CACHED', lastRefreshAt: blsSavedAt === null ? this.lastCalendarRefresh : new Date(blsSavedAt).toISOString(), lastError: null };
      if (this.cachedBeaEvents.length > 0) this.sourceState.BEA = { source: 'BEA', mode: 'CACHED', lastRefreshAt: beaSavedAt === null ? this.lastCalendarRefresh : new Date(beaSavedAt).toISOString(), lastError: null };
      if (cachedBlsEvents.length > 0 && this.cachedBlsEvents.length === 0) this.lastCalendarError = 'Persisted BLS calendar was incomplete; bundled BLS schedule is active';
      this.calendar = calendarWithLiveEvents(this.cachedBlsEvents, this.cachedBeaEvents, this.lastCalendarRefresh || undefined);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') this.lastCalendarError = `Persisted calendar cache could not be loaded: ${error?.message || String(error)}`;
    }
  }

  private async persistCalendarCache(events: EconomicEvent[], now: Date): Promise<void> {
    const cachePath = this.calendarCachePath();
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify({
      savedAt: now.toISOString(),
      sources: {
        BLS: { lastRefreshAt: this.sourceState.BLS.lastRefreshAt },
        BEA: { lastRefreshAt: this.sourceState.BEA.lastRefreshAt }
      },
      events
    }, null, 2), 'utf8');
    await rename(temporaryPath, cachePath);
  }

  private async fetchCalendar(now: Date): Promise<EconomicCalendarSnapshot> {
    await this.loadCalendarCache();
    const refreshedAt = now.toISOString();
    const [blsResult, beaResult] = await Promise.allSettled([this.fetchBlsCalendar(), this.fetchBeaCalendar()]);
    const errors: string[] = [];
    if (blsResult.status === 'fulfilled') {
      this.cachedBlsEvents = blsResult.value;
      this.sourceState.BLS = { source: 'BLS', mode: 'LIVE', lastRefreshAt: refreshedAt, lastError: null };
    } else {
      const message = blsResult.reason?.message || String(blsResult.reason);
      errors.push(message);
      this.sourceState.BLS = { ...this.sourceState.BLS, mode: this.cachedBlsEvents.length > 0 ? 'CACHED' : 'BUNDLED', lastError: message };
    }
    if (beaResult.status === 'fulfilled') {
      this.cachedBeaEvents = beaResult.value;
      this.sourceState.BEA = { source: 'BEA', mode: 'LIVE', lastRefreshAt: refreshedAt, lastError: null };
    } else {
      const message = beaResult.reason?.message || String(beaResult.reason);
      errors.push(message);
      this.sourceState.BEA = { ...this.sourceState.BEA, mode: this.cachedBeaEvents.length > 0 ? 'CACHED' : 'BUNDLED', lastError: message };
    }
    const refreshed = blsResult.status === 'fulfilled' || beaResult.status === 'fulfilled';
    if (refreshed) this.lastCalendarRefresh = refreshedAt;
    this.calendar = calendarWithLiveEvents(this.cachedBlsEvents, this.cachedBeaEvents, this.lastCalendarRefresh || undefined);
    if (refreshed) {
      try {
        await this.persistCalendarCache([...this.cachedBlsEvents, ...this.cachedBeaEvents], now);
      } catch (error: any) {
        errors.push(`Official calendar refreshed but could not be persisted: ${error?.message || String(error)}`);
      }
    }
    this.lastCalendarError = errors.length > 0 ? [...new Set(errors)].join('; ') : null;
    return this.calendar;
  }

  private async fetchBlsCalendar(): Promise<EconomicEvent[]> {
    const contact = String(process.env.STRIKEPILOT_CALENDAR_CONTACT || '').trim();
    const userAgent = contact ? `StrikePilot/1.0 (${contact})` : 'StrikePilot/1.0 (official-calendar-monitor)';
    const response = await this.request(BLS_CALENDAR_URL, {
      headers: { Accept: 'text/calendar', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`BLS calendar request failed (${response.status})`);
    const events = normalizeBlsEvents(await response.text());
    if (!isUsableBlsCalendar(events)) {
      throw new Error('BLS calendar returned an incomplete release schedule');
    }
    return events;
  }

  private async fetchBeaCalendar(): Promise<EconomicEvent[]> {
    const response = await this.request(BEA_CALENDAR_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`BEA calendar request failed (${response.status})`);
    const events = normalizeBeaEvents(await response.json());
    if (events.length === 0) throw new Error('BEA calendar returned no Personal Income and Outlays releases');
    return events;
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
    const upcomingEvents = coveredEvents.filter((event) => Date.parse(event.scheduledAt) >= now.getTime()).slice(0, 8);
    const blockingEvents = coveredEvents.filter((event) => event.impact === 'BLOCKING');
    return {
      status: covered ? this.lastCalendarError ? 'DEGRADED' : 'READY' : 'COVERAGE_MISSING',
      coverageStart: this.calendar.coverageStart,
      coverageThrough: this.calendar.coverageThrough,
      lastRefreshAt: this.lastCalendarRefresh,
      lastError: this.lastCalendarError,
      eventCount: coveredEvents.length,
      blockingEventCount: blockingEvents.length,
      informationalEventCount: coveredEvents.length - blockingEvents.length,
      nextEvent: coveredEvents.find((event) => Date.parse(event.scheduledAt) >= now.getTime()) || null,
      nextBlockingEvent: blockingEvents.find((event) => Date.parse(event.scheduledAt) >= now.getTime()) || null,
      upcomingEvents,
      sources: [
        this.sourceState.BLS,
        this.sourceState.BEA,
        { source: 'Census', mode: 'BUNDLED', lastRefreshAt: WALL_REACTION_CALENDAR_COVERAGE.reviewedAt, lastError: null },
        { source: 'Federal Reserve', mode: 'BUNDLED', lastRefreshAt: WALL_REACTION_CALENDAR_COVERAGE.reviewedAt, lastError: null },
        { source: 'ISM', mode: 'BUNDLED', lastRefreshAt: WALL_REACTION_CALENDAR_COVERAGE.reviewedAt, lastError: null }
      ]
    };
  }
}
