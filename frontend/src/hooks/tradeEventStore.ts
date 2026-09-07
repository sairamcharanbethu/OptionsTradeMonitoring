import { useSyncExternalStore } from 'react';

/**
 * App-wide trade-event store: seeded from GET /api/trade-events, appended by
 * realtime TRADE_EVENT pushes, read by the Decision Log, the Setup Card (latest
 * AI verdict for a setup) and anything else that needs recent decisions.
 * Newest first, bounded, deduplicated by stream id (or a content key when an
 * event has no id).
 */
export interface TradeEventItem {
  /** Redis stream id (e.g. "1725-0") or a Postgres row id as string; null if unknown. */
  id: string | null;
  user_id?: number | null;
  signal_id?: number | null;
  position_id?: number | null;
  event_type: string;
  message?: string | null;
  metadata?: Record<string, any> | null;
  created_at: string;
  /** Where this row came from — realtime push, stream fetch, or DB fallback. */
  source?: 'realtime' | 'redis' | 'postgres';
}

export const MAX_TRADE_EVENTS = 500;

interface TradeEventState {
  events: TradeEventItem[];
  /** Newest stream cursor seen (for `after=` backfill on reconnect). */
  cursor: string | null;
  /** Number of events appended while a consumer asked to hold scrolling. */
  loadedAt: number | null;
  lastSource: 'redis' | 'postgres' | null;
}

let state: TradeEventState = { events: [], cursor: null, loadedAt: null, lastSource: null };
const listeners = new Set<() => void>();

function emit() { listeners.forEach((listener) => listener()); }

export function eventKey(event: TradeEventItem): string {
  if (event.id) return `id:${event.id}`;
  return `k:${event.created_at}|${event.event_type}|${event.position_id ?? ''}|${event.signal_id ?? ''}|${event.message ?? ''}`;
}

function sortNewestFirst(events: TradeEventItem[]): TradeEventItem[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
}

/** Redis stream ids are "<ms>-<seq>"; compare numerically so cursors advance correctly. */
function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+-\d+$/.test(value);
}
function newerCursor(a: string | null, b: string | null): string | null {
  if (!isStreamId(a)) return isStreamId(b) ? b : a ?? b;
  if (!isStreamId(b)) return a;
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return bm > am || (bm === am && bs > as) ? b : a;
}

function mergeInto(incoming: TradeEventItem[], sourceLabel?: 'redis' | 'postgres') {
  if (incoming.length === 0 && !sourceLabel) return;
  const byKey = new Map<string, TradeEventItem>();
  for (const event of state.events) byKey.set(eventKey(event), event);
  let cursor = state.cursor;
  for (const event of incoming) {
    const key = eventKey(event);
    const existing = byKey.get(key);
    // Prefer the row that carries an id/metadata; realtime pushes may arrive before the fetch.
    byKey.set(key, existing ? { ...existing, ...event, id: event.id || existing.id, metadata: event.metadata ?? existing.metadata } : event);
    if (isStreamId(event.id)) cursor = newerCursor(cursor, event.id);
  }
  state = {
    events: sortNewestFirst(Array.from(byKey.values())).slice(0, MAX_TRADE_EVENTS),
    cursor,
    loadedAt: sourceLabel ? Date.now() : state.loadedAt,
    lastSource: sourceLabel ?? state.lastSource
  };
  emit();
}

export const tradeEventStore = {
  getState: () => state,
  /** Realtime push: one event, newest. */
  append(event: TradeEventItem) { mergeInto([{ ...event, source: event.source || 'realtime' }]); },
  /** Initial fetch or backfill result. */
  merge(events: TradeEventItem[], source: 'redis' | 'postgres', cursor?: string | null) {
    mergeInto(events.map((event) => ({ ...event, source })), source);
    if (cursor && newerCursor(state.cursor, cursor) === cursor && cursor !== state.cursor) {
      state = { ...state, cursor };
      emit();
    }
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
};

export function useTradeEventState(): TradeEventState {
  return useSyncExternalStore(tradeEventStore.subscribe, tradeEventStore.getState, tradeEventStore.getState);
}

export function useTradeEvents(): TradeEventItem[] {
  return useTradeEventState().events;
}

/** Latest AI gate verdict recorded for a setup id, from history + live pushes. */
export function useLatestAiVerdict(setupId: string | null | undefined): TradeEventItem | null {
  const events = useTradeEvents();
  if (!setupId) return null;
  return events.find((event) => event.event_type === 'AI_LIVE_GATE' && String(event.metadata?.setup_id || '') === String(setupId)) || null;
}

/** Normalise a realtime TRADE_EVENT envelope (or an API row) into a store item. */
export function toTradeEventItem(raw: any, envelope?: any): TradeEventItem | null {
  if (!raw || typeof raw.event_type !== 'string') return null;
  const idCandidate = raw.stream_id ?? raw.cursor ?? raw.id ?? envelope?.cursor ?? envelope?.stream_id ?? envelope?.id ?? null;
  let metadata: Record<string, any> | null = null;
  if (raw.metadata && typeof raw.metadata === 'object') metadata = raw.metadata;
  else if (typeof raw.metadata === 'string') { try { metadata = JSON.parse(raw.metadata); } catch { metadata = { raw: raw.metadata }; } }
  return {
    id: idCandidate != null ? String(idCandidate) : null,
    user_id: raw.user_id != null ? Number(raw.user_id) : null,
    signal_id: raw.signal_id != null ? Number(raw.signal_id) : null,
    position_id: raw.position_id != null ? Number(raw.position_id) : null,
    event_type: raw.event_type,
    message: raw.message ?? null,
    metadata,
    created_at: raw.created_at || new Date().toISOString()
  };
}
