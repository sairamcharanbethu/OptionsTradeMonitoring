/** Small formatting helpers shared by the cockpit header and setup card. */
export const ET_ZONE = 'America/New_York';

export function etMinuteOfDay(date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ET_ZONE, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return (get('hour') % 24) * 60 + get('minute') + get('second') / 60;
}

export function etClock(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET_ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date) + ' ET';
}

export function minuteLabel(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const total = Math.round(Number(minutes));
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix} ET`;
}

export function money(value: unknown, digits = 2): string {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function signedMoney(value: unknown): string {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;
}

export function num(value: unknown, digits = 2): string {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function seconds(value: unknown): string {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return n >= 100 ? `${Math.round(n)}s` : `${n.toFixed(n < 10 ? 1 : 0)}s`;
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

/** Freshness tone against a gate: amber from 70% of the gate, red at/over it. */
export function freshnessTone(age: number | null | undefined, gate: number): Tone {
  if (age == null || !Number.isFinite(Number(age)) || Number(age) < 0) return 'muted';
  const n = Number(age);
  if (n > gate) return 'bad';
  if (n > gate * 0.7) return 'warn';
  return 'good';
}

export const toneClass: Record<Tone, string> = {
  good: 'border-emerald-500/30 bg-emerald-950/30 text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-950/30 text-amber-300',
  bad: 'border-rose-500/40 bg-rose-950/30 text-rose-300',
  muted: 'border-zinc-700 bg-zinc-900 text-zinc-400'
};

export function expiryModeLabel(mode: unknown): string | null {
  const text = String(mode || '');
  if (!text) return null;
  if (text.startsWith('MULTI_DAY_') && text !== 'MULTI_DAY_WALL') return text.slice('MULTI_DAY_'.length);
  return ({ '0DTE': '0DTE', '0DTE_NO_FUTURE_EXPIRY': '0DTE', '1DTE_NEXT_LISTED': '1DTE', MULTI_DAY_WALL: 'wall 3DTE', LOCKED_POSITION: 'locked' } as Record<string, string>)[text] || text;
}

/** h:mm:ss ET for an ISO timestamp. */
export function etTimeOfDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: ET_ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
}

/** ET minute-of-day for an ISO timestamp (for the same-day theta ladder). */
export function etMinuteOfDayFor(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return etMinuteOfDay(date);
}

/** YYYY-MM-DD in ET for a Date. */
export function etDateKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ET_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "SPY $770 Call · Sep 8" style label for a position or option row. */
export function contractLabel(input: { strike?: unknown; strike_price?: unknown; expiry?: unknown; expiration_date?: unknown }, side: string | null | undefined): string {
  const strikeRaw = Number(input.strike ?? input.strike_price);
  const strike = Number.isFinite(strikeRaw) ? `$${strikeRaw.toFixed(2).replace(/\.00$/, '')}` : 'strike —';
  const expiryRaw = String(input.expiry ?? input.expiration_date ?? '').slice(0, 10);
  let expiry = 'expiry —';
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(expiryRaw.replace(/-/g, '')) || /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiryRaw);
  if (match) {
    const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    expiry = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
  }
  const sideLabel = side ? `${side[0]}${side.slice(1).toLowerCase()}` : 'option';
  return `SPY ${strike} ${sideLabel} · ${expiry}`;
}

/** Same-day theta ladder used by the live exit engine (MarketPoller.getThetaStopMaxHoldMinutes). */
export function sameDayMaxHoldMinutes(entryMinuteEt: number): number | null {
  if (entryMinuteEt < 11 * 60 + 30) return 25;
  if (entryMinuteEt < 14 * 60) return 15;
  if (entryMinuteEt < 15 * 60 + 30) return 10;
  return null;
}
