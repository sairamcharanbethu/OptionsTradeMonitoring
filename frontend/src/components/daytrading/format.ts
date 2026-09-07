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
