import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CircleSlash2, ExternalLink, Flame } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import HoldToConfirmButton from '@/components/HoldToConfirmButton';
import { api, type PaperAccountSummary, type Position } from '@/lib/api';
import { QUERY_KEYS } from '@/hooks/useDashboardData';
import { cn } from '@/lib/utils';
import PriceLadder from './PriceLadder';
import { contractLabel, etDateKey, etMinuteOfDayFor, etTimeOfDay, money, num, sameDayMaxHoldMinutes, signedMoney, toneClass, type Tone } from './format';

type PaperPosition = PaperAccountSummary['openPositions'][number];

export interface PositionsStripProps {
  positions: Position[];
  paperPositions: PaperPosition[];
  paperCanManage: boolean;
  settings: Record<string, string>;
  /** Position id highlighted from the decision log. */
  highlightedId: number | null;
  onPaperChanged?: () => void;
}

type RowKind = 'live' | 'paper' | 'simulated';

interface Row {
  kind: RowKind;
  position: Position;
}

const LIVE_BROKER = 'wealthsimple_snaptrade';

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return value == null || value === '' || !Number.isFinite(n) ? null : n;
}

/** Fraction of the way from `from` to `to` that `value` sits, clamped 0..1. */
function progress(value: number | null, from: number | null, to: number | null): number | null {
  if (value == null || from == null || to == null || to === from) return null;
  return Math.max(0, Math.min(1, (value - from) / (to - from)));
}

function Bar({ value, tone, label, title }: { value: number | null; tone: Tone; label: string; title?: string }) {
  const pct = value == null ? 0 : Math.round(value * 100);
  const fill = tone === 'bad' ? 'bg-rose-400' : tone === 'warn' ? 'bg-amber-400' : tone === 'good' ? 'bg-emerald-400' : 'bg-zinc-500';
  return (
    <div className="min-w-[7rem]" title={title}>
      <div className="flex items-center justify-between text-2xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
        <span>{label}</span>
        <span className="font-mono normal-case tracking-normal text-zinc-400">{value == null ? '—' : `${pct}%`}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : pct} aria-label={label}>
        <div className={cn('h-1.5 rounded-full transition-[width]', fill)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function statusTone(status: string | undefined): Tone {
  const s = String(status || '').toUpperCase();
  if (!s || s === 'FILLED' || s === 'FILLED_FULLY' || s === 'OPEN') return 'muted';
  if (s.startsWith('EXIT_') || s === 'PENDING_EXIT' || s === 'PENDING_TRIM') return s.includes('STALE') || s.includes('FAIL') || s.includes('RETRY') ? 'bad' : 'warn';
  if (s.includes('STALE') || s.includes('RECONCILE') || s.includes('ERROR')) return 'bad';
  return 'warn';
}

export default function PositionsStrip({ positions, paperPositions, paperCanManage, settings, highlightedId, onPaperChanged }: PositionsStripProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, { tone: Tone; text: string; forceable?: boolean }>>({});

  const multiDayMaxHold = useMemo(() => {
    const raw = Number(settings.strategy_multi_day_max_hold_minutes);
    return Number.isInteger(raw) && raw >= 0 ? raw : 45;
  }, [settings.strategy_multi_day_max_hold_minutes]);
  const maxSameDirection = Math.max(1, Number(settings.max_same_direction_positions) || 1);

  const rows = useMemo<Row[]>(() => {
    const seen = new Set<number>();
    const out: Row[] = [];
    for (const position of positions) {
      if (position.status !== 'OPEN') continue;
      const id = Number(position.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const broker = String(position.execution_broker || '');
      const kind: RowKind = !position.is_simulated && broker === LIVE_BROKER ? 'live' : broker === 'system_paper' || position.paper_account_id ? 'paper' : 'simulated';
      out.push({ kind, position });
    }
    for (const paper of paperPositions) {
      const id = Number(paper.id);
      if (seen.has(id) || String(paper.status || 'OPEN') !== 'OPEN') continue;
      seen.add(id);
      out.push({ kind: 'paper', position: paper });
    }
    const order: Record<RowKind, number> = { live: 0, simulated: 1, paper: 2 };
    return out.sort((a, b) => order[a.kind] - order[b.kind] || Date.parse(b.position.created_at) - Date.parse(a.position.created_at));
  }, [positions, paperPositions]);

  const liveByDirection = useMemo(() => {
    const counts = { CALL: 0, PUT: 0 };
    for (const row of rows) if (row.kind === 'live') counts[row.position.option_type] += 1;
    return counts;
  }, [rows]);

  const finish = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.paperAccount });
    onPaperChanged?.();
  }, [onPaperChanged, queryClient]);

  const closeLive = useCallback(async (position: Position) => {
    const id = Number(position.id);
    setBusy(id);
    try {
      await api.closePosition(id);
      setNotes((n) => ({ ...n, [id]: { tone: 'warn', text: 'MARKET close submitted; awaiting broker fill.' } }));
    } catch (err: any) {
      setNotes((n) => ({ ...n, [id]: { tone: 'bad', text: err?.message || 'Close failed' } }));
    } finally {
      setBusy(null);
      finish();
    }
  }, [finish]);

  const closePaper = useCallback(async (position: Position, force = false) => {
    const id = Number(position.id);
    setBusy(id);
    try {
      const result = await api.closePaperPosition(id, force);
      setNotes((n) => ({ ...n, [id]: { tone: result.realizedPnl >= 0 ? 'good' : 'warn', text: `Paper ${result.forced ? 'force ' : ''}closed at ${money(result.fillPrice)} (${result.priceSource.replace(/_/g, ' ').toLowerCase()}); realized ${signedMoney(result.realizedPnl)}.` } }));
    } catch (err: any) {
      const forceable = !force && err?.code === 'PAPER_FRESH_QUOTE_REQUIRED';
      setNotes((n) => ({ ...n, [id]: { tone: 'bad', text: `${err?.message || 'Paper close failed'}${forceable ? ' Hold "Force close" to use the last mark.' : ''}`, forceable } }));
    } finally {
      setBusy(null);
      finish();
    }
  }, [finish]);

  const today = etDateKey();

  if (rows.length === 0) {
    return (
      <section aria-label="Open positions" className="rounded-xl border border-zinc-800 bg-[#101216] px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Open positions</div>
            <div className="mt-1 text-sm text-zinc-400">No open positions.</div>
          </div>
          <div className="text-2xs text-zinc-500">
            Same-direction slots <span className="font-mono text-zinc-300">CALL 0/{maxSameDirection}</span> · <span className="font-mono text-zinc-300">PUT 0/{maxSameDirection}</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Open positions" className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Open positions ({rows.length})</div>
        <div className="text-2xs text-zinc-500" title={`max_same_direction_positions = ${maxSameDirection}`}>
          Same-direction slots <span className={cn('font-mono', liveByDirection.CALL >= maxSameDirection ? 'text-amber-300' : 'text-zinc-300')}>CALL {liveByDirection.CALL}/{maxSameDirection}</span> · <span className={cn('font-mono', liveByDirection.PUT >= maxSameDirection ? 'text-amber-300' : 'text-zinc-300')}>PUT {liveByDirection.PUT}/{maxSameDirection}</span>
        </div>
      </div>

      <div className="mt-3 flex gap-3 overflow-x-auto pb-1 lg:block lg:space-y-3 lg:overflow-visible">
        {rows.map(({ kind, position }) => {
          const id = Number(position.id);
          const qty = Number(position.quantity) || 0;
          const entry = toNumber(position.entry_price);
          const mark = toNumber(position.current_price);
          const pnl = entry != null && mark != null ? (mark - entry) * 100 * qty : null;
          const pnlPct = entry != null && mark != null && entry > 0 ? ((mark - entry) / entry) * 100 : null;
          const stop = toNumber(position.stop_loss_trigger);
          const tp = toNumber(position.take_profit_trigger);
          const trailingHigh = toNumber(position.trailing_high_price);
          const analysis = (typeof position.analysis_data === 'string' ? (() => { try { return JSON.parse(position.analysis_data); } catch { return {}; } })() : position.analysis_data) || {};
          const smartStop: string | null = analysis?.smartStopWarning?.status || null;
          const syntheticTrail = analysis?.syntheticTrailing?.active === true;
          const underlying = toNumber(position.underlying_price);
          const uStop = toNumber(position.suggested_stop_loss) ?? toNumber(position.underlying_stop_price);
          const uT1 = toNumber(position.suggested_take_profit_1);
          const uT2 = toNumber(position.suggested_take_profit_2);
          const hasUnderlyingLevels = uStop != null || uT1 != null || uT2 != null;

          // Time held vs the applicable max hold.
          const startedAt: string = analysis?.thetaStop?.startedAt || position.created_at;
          const heldMinutes = Math.max(0, (Date.now() - Date.parse(startedAt)) / 60000);
          const expiresToday = String(position.expiration_date || '').slice(0, 10) === today;
          const entryMinute = etMinuteOfDayFor(startedAt);
          const maxHold = expiresToday
            ? (entryMinute != null ? sameDayMaxHoldMinutes(entryMinute) : null)
            : position.strategy_managed === true && multiDayMaxHold > 0 ? multiDayMaxHold : null;
          const holdFraction = maxHold ? Math.min(1, heldMinutes / maxHold) : null;
          const holdTone: Tone = holdFraction == null ? 'muted' : holdFraction >= 1 ? 'bad' : holdFraction >= 0.8 ? 'warn' : 'good';

          // Premium geometry: how far the mark sits between the stop and the TP (or entry when no TP).
          const premiumUpper = tp ?? (entry != null && stop != null ? entry + (entry - stop) * 2 : null);
          const premiumProgress = progress(mark, stop, premiumUpper);
          const distanceToStopPct = mark != null && stop != null && mark > 0 ? ((mark - stop) / mark) * 100 : null;
          const stopTone: Tone = distanceToStopPct == null ? 'muted' : distanceToStopPct <= 5 ? 'bad' : distanceToStopPct <= 12 ? 'warn' : 'good';

          const side = position.option_type;
          const note = notes[id];
          const highlighted = highlightedId === id;
          const kindTone: Tone = kind === 'live' ? 'good' : kind === 'paper' ? 'muted' : 'warn';

          return (
            <article
              key={id}
              id={`position-row-${id}`}
              className={cn(
                'min-w-[19rem] shrink-0 rounded-lg border bg-zinc-950/55 p-3 transition-colors lg:min-w-0 lg:shrink',
                highlighted ? 'border-sky-400/60 shadow-[0_0_0_1px_rgba(56,189,248,0.35)]' : 'border-zinc-800'
              )}
              aria-label={`${kind} position ${contractLabel(position, side)}`}
            >
              <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr_1.4fr_1.2fr_auto] lg:items-start">
                {/* Identity */}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={cn('font-mono text-2xs uppercase', toneClass[kindTone])}>{kind}</Badge>
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-950 font-mono text-2xs text-zinc-300">{side}</Badge>
                    <span className="font-mono text-2xs text-zinc-500">×{qty}</span>
                    {position.strategy_snapshot?.strategy && <span className="truncate text-2xs text-zinc-400" title="Strategy">{String(position.strategy_snapshot.strategy).replace(/_/g, ' ')}</span>}
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold text-zinc-100" title={contractLabel(position, side)}>{contractLabel(position, side)}</div>
                  <div className="mt-0.5 text-2xs text-zinc-500">In at {etTimeOfDay(startedAt)} ET · held {Math.round(heldMinutes)}m{maxHold ? ` / ${maxHold}m` : ''}</div>
                  <div className="mt-2"><Bar value={holdFraction} tone={holdTone} label="Hold" title={maxHold ? (expiresToday ? 'Same-day theta ladder 25/15/10 min by entry time' : `Multi-day max hold ${maxHold} min (strategy_multi_day_max_hold_minutes)`) : 'No time stop applies to this position'} /></div>
                </div>

                {/* Prices */}
                <div className="grid grid-cols-3 gap-x-3 gap-y-1 lg:grid-cols-1">
                  <div><div className="text-2xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Entry</div><div className="font-mono text-xs text-zinc-300">{money(entry)}</div></div>
                  <div><div className="text-2xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Mark</div><div className="font-mono text-xs text-zinc-100">{money(mark)}</div></div>
                  <div>
                    <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-zinc-500">P&amp;L</div>
                    <div className={cn('font-mono text-xs font-semibold', pnl == null ? 'text-pnl-flat' : pnl >= 0 ? 'text-pnl-up' : 'text-pnl-down')}>
                      {pnl == null ? '—' : `${signedMoney(pnl)}${pnlPct != null ? ` (${pnlPct >= 0 ? '+' : ''}${num(pnlPct, 1)}%)` : ''}`}
                    </div>
                  </div>
                </div>

                {/* Exit geometry */}
                <div className="space-y-2">
                  <Bar value={premiumProgress} tone={stopTone} label={tp != null ? 'Stop → TP' : 'Stop → 2R'} title={`Premium stop ${money(stop)}${tp != null ? ` · TP ${money(tp)}` : ''} · mark ${money(mark)}${distanceToStopPct != null ? ` · ${num(distanceToStopPct, 1)}% above stop` : ''}`} />
                  {hasUnderlyingLevels ? (
                    <PriceLadder
                      side={side}
                      spot={underlying}
                      compact
                      marks={[
                        ...(uStop != null ? [{ price: uStop, label: 'Stop', cls: 'bg-rose-400' }] : []),
                        ...(uT1 != null ? [{ price: uT1, label: 'T1', cls: 'bg-emerald-400' }] : []),
                        ...(uT2 != null ? [{ price: uT2, label: 'T2', cls: 'bg-emerald-400' }] : [])
                      ]}
                      ariaLabel={`Underlying ladder${uStop != null ? `, stop ${money(uStop)}` : ''}${uT1 != null ? `, T1 ${money(uT1)}` : ''}${uT2 != null ? `, T2 ${money(uT2)}` : ''}${underlying != null ? `, underlying ${money(underlying)}` : ''}`}
                    />
                  ) : (
                    <div className="text-2xs text-zinc-500">No underlying levels on this row{underlying != null ? ` · SPY ${money(underlying)}` : ''}.</div>
                  )}
                </div>

                {/* Exit engine status */}
                <div className="flex flex-wrap content-start gap-1.5">
                  <Badge variant="outline" className={cn('font-mono text-2xs', toneClass[statusTone(position.execution_status)])} title="Execution status">{String(position.execution_status || position.status).replace(/_/g, ' ')}</Badge>
                  {smartStop && <Badge variant="outline" className={cn('font-mono text-2xs', toneClass[smartStop.includes('CONFIRMED') || smartStop.includes('HARD') || smartStop.includes('EMERGENCY') ? 'bad' : 'warn'])} title="Smart stop state">{smartStop.replace(/_/g, ' ')}</Badge>}
                  {syntheticTrail && <Badge variant="outline" className={cn('font-mono text-2xs', toneClass.good)} title="Synthetic trailing stop active after TP1"><Flame className="mr-1 h-3 w-3" aria-hidden="true" />trail</Badge>}
                  {trailingHigh != null && <span className="font-mono text-2xs text-zinc-500" title="Trailing high">high {money(trailingHigh)}</span>}
                  {position.exit_reason && <span className="text-2xs text-zinc-500" title="Exit reason">{String(position.exit_reason).replace(/_/g, ' ')}</span>}
                </div>

                {/* Actions */}
                <div className="flex flex-col items-stretch gap-2 lg:items-end">
                  {kind === 'paper' ? (
                    <>
                      <HoldToConfirmButton label="Close" hint={`Close paper ${contractLabel(position, side)} at the live bid`} icon={<CircleSlash2 className="h-3.5 w-3.5" aria-hidden="true" />} tone="danger" disabled={!paperCanManage} busy={busy === id} onConfirm={() => void closePaper(position)} />
                      {note?.forceable && <HoldToConfirmButton label="Force close" hint="Close at the last recorded mark (no fresh quote)" icon={<CircleSlash2 className="h-3.5 w-3.5" aria-hidden="true" />} tone="warn" busy={busy === id} onConfirm={() => void closePaper(position, true)} />}
                    </>
                  ) : (
                    <HoldToConfirmButton label="Close" hint={`MARKET-close ${contractLabel(position, side)} ×${qty}`} icon={<CircleSlash2 className="h-3.5 w-3.5" aria-hidden="true" />} tone="danger" busy={busy === id} onConfirm={() => void closeLive(position)} />
                  )}
                  <Link to={`/positions/${id}`} className="inline-flex items-center justify-center gap-1 text-2xs text-zinc-400 hover:text-zinc-200" aria-label={`Open details for position ${id}`}>
                    details <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              </div>
              {note && <div className={cn('mt-2 rounded-md border px-2.5 py-1.5 text-2xs', toneClass[note.tone])} role="status">{note.text}</div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
