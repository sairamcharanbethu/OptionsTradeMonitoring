import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Pause, Play, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { tradeEventStore, toTradeEventItem, useTradeEventState, type TradeEventItem } from '@/hooks/tradeEventStore';
import { useRealtimeConnected } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { etTimeOfDay, toneClass, type Tone } from './format';

export type EventClass = 'entry' | 'exit' | 'risk' | 'ai' | 'veto' | 'flatten' | 'kill' | 'order' | 'other';

export const EVENT_CLASSES: Array<{ key: EventClass; label: string; cls: string }> = [
  { key: 'entry', label: 'Entries', cls: 'border-sky-500/40 bg-sky-950/30 text-sky-300' },
  { key: 'exit', label: 'Exits', cls: 'border-violet-500/40 bg-violet-950/30 text-violet-300' },
  { key: 'risk', label: 'Risk denials', cls: 'border-amber-500/40 bg-amber-950/30 text-amber-300' },
  { key: 'ai', label: 'AI gate', cls: 'border-fuchsia-500/40 bg-fuchsia-950/30 text-fuchsia-300' },
  { key: 'veto', label: 'Vetoes', cls: 'border-orange-500/40 bg-orange-950/30 text-orange-300' },
  { key: 'flatten', label: 'Flatten', cls: 'border-rose-500/40 bg-rose-950/30 text-rose-300' },
  { key: 'kill', label: 'Kill switch', cls: 'border-red-500/50 bg-red-950/40 text-red-300' },
  { key: 'order', label: 'Orders', cls: 'border-zinc-600 bg-zinc-900 text-zinc-300' },
  { key: 'other', label: 'Other', cls: 'border-zinc-700 bg-zinc-950 text-zinc-400' }
];

export function classifyEvent(type: string): EventClass {
  const t = String(type || '').toUpperCase();
  if (t === 'AI_LIVE_GATE' || t.startsWith('AI_')) return 'ai';
  if (t === 'SETUP_VETOED' || t === 'SETUP_VETO_CLEARED') return 'veto';
  if (t === 'MANUAL_FLATTEN_ALL') return 'flatten';
  if (t.includes('KILL') || t.includes('DISARM') || t === 'LIVE_ARMED' || t.includes('HALT')) return 'kill';
  if (t.includes('DENIED') || t.includes('RISK') || t.includes('LIMIT') || t.includes('REJECT') || t.includes('SKIP') || t.includes('COOLDOWN')) return 'risk';
  if (t.startsWith('EXIT') || t === 'POSITION_CLOSED' || t.includes('STOP') || t.includes('TAKE_PROFIT') || t.includes('FLATTEN') || t.includes('TRIM') || t.includes('TRAIL')) return 'exit';
  if (t.startsWith('ENTRY') || t === 'POSITION_OPENED' || t.includes('EXECUTED') || t.includes('SUBMITTED')) return 'entry';
  if (t.startsWith('ORDER') || t.startsWith('BROKER') || t.includes('FILL') || t.includes('SYNC') || t.includes('RECONCILE')) return 'order';
  return 'other';
}

/** Pull the keys an operator wants inline out of arbitrary metadata. */
function highlights(metadata: Record<string, any> | null | undefined): Array<[string, string]> {
  if (!metadata || typeof metadata !== 'object') return [];
  const pick = (keys: string[]) => keys.map((k) => [k, metadata[k]] as const).find(([, v]) => v != null && v !== '');
  const out: Array<[string, string]> = [];
  const add = (label: string, entry: readonly [string, any] | undefined) => { if (entry) out.push([label, typeof entry[1] === 'object' ? JSON.stringify(entry[1]) : String(entry[1])]); };
  add('code', pick(['riskCode', 'risk_code', 'code', 'reason_code']));
  add('decision', pick(['decision']));
  add('tier', pick(['risk_tier', 'riskTier']));
  add('source', pick(['source']));
  add('exit', pick(['exit_reason', 'exitReason', 'trigger_type', 'triggerType']));
  add('fill', pick(['fillPrice', 'fill_price', 'exitPrice', 'exit_price']));
  add('order', pick(['orderId', 'order_id', 'status']));
  add('why', pick(['rationale', 'reason', 'message']));
  return out.slice(0, 5);
}

const INITIAL_LIMIT = 200;

export default function DecisionLog({ onHighlightPosition, highlightedId, currentSetupId }: {
  onHighlightPosition: (positionId: number | null) => void;
  highlightedId: number | null;
  currentSetupId?: string | null;
}) {
  const { events, cursor, loadedAt, lastSource } = useTradeEventState();
  const connected = useRealtimeConnected();
  const [open, setOpen] = useState<boolean>(() => typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches);
  const [paused, setPaused] = useState(false);
  const [classes, setClasses] = useState<Set<EventClass>>(() => new Set(EVENT_CLASSES.map((c) => c.key)));
  const [positionFilter, setPositionFilter] = useState('');
  const [setupFilter, setSetupFilter] = useState('');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pausedCount = useRef<number>(0);
  const [unread, setUnread] = useState(0);
  const lastSeenCount = useRef(events.length);
  const wasConnected = useRef(connected);
  const listRef = useRef<HTMLOListElement | null>(null);

  const load = useCallback(async (after: string | null) => {
    setLoading(true);
    try {
      const page = await api.getTradeEventStream({ limit: INITIAL_LIMIT, after });
      const items = page.events.map((row) => toTradeEventItem(row)).filter((row): row is TradeEventItem => row !== null);
      tradeEventStore.merge(items, page.source, page.cursor);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load trade events');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial history (once per app session), then backfill on every reconnect.
  useEffect(() => {
    if (loadedAt == null) void load(null);
  }, [load, loadedAt]);
  useEffect(() => {
    if (connected && !wasConnected.current && loadedAt != null) void load(cursor);
    wasConnected.current = connected;
  }, [connected, cursor, load, loadedAt]);

  // Unread counter while paused; auto-scroll to top (newest) while not paused.
  useEffect(() => {
    if (paused) {
      const delta = events.length - lastSeenCount.current;
      if (delta > 0) { pausedCount.current += delta; setUnread(pausedCount.current); }
    } else {
      pausedCount.current = 0;
      setUnread(0);
      if (listRef.current) listRef.current.scrollTop = 0;
    }
    lastSeenCount.current = events.length;
  }, [events.length, paused]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const positionNeedle = positionFilter.trim();
    const setupNeedle = setupFilter.trim().toLowerCase();
    return events.filter((event) => {
      if (!classes.has(classifyEvent(event.event_type))) return false;
      if (positionNeedle && String(event.position_id ?? '') !== positionNeedle) return false;
      if (setupNeedle) {
        const setupId = String(event.metadata?.setup_id || event.metadata?.setupId || '').toLowerCase();
        const signalId = String(event.signal_id ?? '');
        if (!setupId.startsWith(setupNeedle) && signalId !== setupNeedle) return false;
      }
      if (needle) {
        const haystack = `${event.event_type} ${event.message || ''} ${JSON.stringify(event.metadata || {})}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [classes, events, positionFilter, setupFilter, text]);

  const toggleClass = (key: EventClass) => setClasses((current) => {
    const next = new Set(current);
    if (next.has(key)) { if (next.size > 1) next.delete(key); } else next.add(key);
    return next;
  });

  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const sourceTone: Tone = lastSource === 'redis' ? 'good' : lastSource === 'postgres' ? 'warn' : 'muted';

  return (
    <section aria-label="Decision log" className="rounded-xl border border-zinc-800 bg-[#101216]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-2 text-left">
          <ChevronDown className={cn('h-4 w-4 text-zinc-500 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Decision log</span>
          <span className="font-mono text-2xs text-zinc-500">{filtered.length}/{events.length}</span>
          {unread > 0 && <Badge variant="outline" className={cn('font-mono text-2xs', toneClass.warn)}>{unread} new</Badge>}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full border px-2 py-0.5 font-mono text-2xs', toneClass[sourceTone])} title="History source: Redis stream (live) or Postgres fallback">{loading ? 'loading…' : lastSource || 'no history'}</span>
          <span className={cn('rounded-full border px-2 py-0.5 font-mono text-2xs', toneClass[connected ? 'good' : 'warn'])}>{connected ? 'streaming' : 'reconnecting'}</span>
          <button type="button" onClick={() => setPaused((v) => !v)} aria-pressed={paused} className={cn('inline-flex h-7 items-center gap-1 rounded-md border px-2 text-2xs font-semibold', paused ? toneClass.warn : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800')} title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll while reading'}>
            {paused ? <Play className="h-3 w-3" aria-hidden="true" /> : <Pause className="h-3 w-3" aria-hidden="true" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-zinc-800 px-4 pb-4 sm:px-5">
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {EVENT_CLASSES.map((c) => (
              <button key={c.key} type="button" onClick={() => toggleClass(c.key)} aria-pressed={classes.has(c.key)} className={cn('rounded-full border px-2 py-0.5 text-2xs font-semibold transition-opacity', c.cls, classes.has(c.key) ? 'opacity-100' : 'opacity-35')}>{c.label}</button>
            ))}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem_9rem]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search message or metadata" aria-label="Search events" className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 pl-7 pr-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600" />
            </label>
            <input value={positionFilter} onChange={(e) => setPositionFilter(e.target.value)} placeholder="Position id" aria-label="Filter by position id" inputMode="numeric" className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600" />
            <div className="flex gap-1">
              <input value={setupFilter} onChange={(e) => setSetupFilter(e.target.value)} placeholder="Setup / signal id" aria-label="Filter by setup or signal id" className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600" />
              {currentSetupId && <button type="button" onClick={() => setSetupFilter(currentSetupId.slice(0, 8))} className="h-8 rounded-md border border-zinc-700 px-2 text-2xs text-zinc-300 hover:bg-zinc-800" title={`Filter to the current setup ${currentSetupId}`}>this setup</button>}
            </div>
          </div>
          {loadError && <div className={cn('mt-2 rounded-md border px-2.5 py-1.5 text-2xs', toneClass.bad)} role="alert">{loadError} <button type="button" className="underline" onClick={() => void load(null)}>retry</button></div>}

          <ol ref={listRef} className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto pr-1" aria-live={paused ? 'off' : 'polite'}>
            {filtered.length === 0 && <li className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">{events.length === 0 ? (loading ? 'Loading events…' : 'No events yet.') : 'No events match the current filters.'}</li>}
            {filtered.map((event) => {
              const key = event.id ? `id:${event.id}` : `${event.created_at}|${event.event_type}|${event.position_id ?? ''}|${event.message ?? ''}`;
              const klass = classifyEvent(event.event_type);
              const meta = EVENT_CLASSES.find((c) => c.key === klass)!;
              const isExpanded = expanded.has(key);
              const inline = highlights(event.metadata);
              const positionId = event.position_id != null ? Number(event.position_id) : null;
              const isHighlighted = positionId != null && highlightedId === positionId;
              return (
                <li key={key} className={cn('rounded-md border bg-zinc-950/55 px-2.5 py-1.5', isHighlighted ? 'border-sky-400/60' : 'border-zinc-800/80')}>
                  <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                    <span className="font-mono text-2xs text-zinc-500" title={event.created_at}>{etTimeOfDay(event.created_at)}</span>
                    <Badge variant="outline" className={cn('font-mono text-2xs', meta.cls)}>{event.event_type.replace(/_/g, ' ')}</Badge>
                    {positionId != null && (
                      <button type="button" onClick={() => onHighlightPosition(isHighlighted ? null : positionId)} className={cn('rounded border px-1.5 font-mono text-2xs', isHighlighted ? 'border-sky-400/60 text-sky-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200')} title="Highlight this position in the strip" aria-pressed={isHighlighted}>#{positionId}</button>
                    )}
                    {event.signal_id != null && <span className="font-mono text-2xs text-zinc-600" title="Signal id">sig {event.signal_id}</span>}
                    <span className="min-w-0 flex-1 truncate text-2xs text-zinc-200" title={event.message || ''}>{event.message || '—'}</span>
                    {event.metadata && (
                      <button type="button" onClick={() => toggleExpanded(key)} aria-expanded={isExpanded} className="text-zinc-500 hover:text-zinc-300" title="Show metadata">
                        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-180')} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {inline.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-zinc-400">
                      {inline.map(([label, value]) => <span key={label}><span className="text-zinc-600">{label}</span> <span className="font-mono text-zinc-300">{value.length > 140 ? `${value.slice(0, 140)}…` : value}</span></span>)}
                    </div>
                  )}
                  {isExpanded && event.metadata && (
                    <pre className="mt-1.5 max-h-56 overflow-auto rounded bg-zinc-950 p-2 font-mono text-2xs leading-relaxed text-zinc-400">{JSON.stringify(event.metadata, null, 2)}</pre>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
