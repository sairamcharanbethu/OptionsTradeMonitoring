import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { KillSwitchResponse, Position, StrategyEngineState, TradeUsageResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { etClock, etMinuteOfDay, freshnessTone, minuteLabel, seconds, signedMoney, toneClass, type Tone } from './format';

/**
 * Entry-gate thresholds mirrored from the code that enforces them, so a chip
 * turns red exactly when the gate would reject:
 *  - SPY quote: signal_engine.market_data_readiness(stale_after) — the live
 *    prefetch runs with stale_after ~5s (trade_prefetch_service --stale-after).
 *  - option quote: signal_engine._evaluate_option_contract (>15s rejected) and
 *    StrategyEngineAdapter.assertSignalExecutable (quoteAge > 15).
 *  - GEX provider age: MAX_GEX_ENTRY_AGE_SECONDS = 20 in the engine (hard
 *    block); the adapter allows up to MAX_GEX_PROVIDER_AGE_SECONDS = 120.
 *  - signal age: assertSignalExecutable (signalAge > 20).
 */
export const GATES = {
  spyQuoteSeconds: 5,
  optionQuoteSeconds: 15,
  gexEngineSeconds: 20,
  gexAdapterSeconds: 120,
  signalSeconds: 20
} as const;

type Window = { start_minute_et: number; end_minute_et: number; reason?: string };

interface Props {
  strategyState: StrategyEngineState | null | undefined;
  killSwitch: KillSwitchResponse | null | undefined;
  killSwitchUnavailable?: boolean;
  positions: Position[];
  tradeUsage: TradeUsageResponse | null | undefined;
  settings: Record<string, string>;
  healthy: boolean | null;
  healthLabel?: string;
}

function useEtNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type Segment = { from: number; to: number; kind: 'buffer' | 'event' | 'open' | 'cutoff' | 'flatten'; label: string };

function buildSegments(session: Record<string, any>): Segment[] {
  const open = Number(session.open_minute_et);
  const close = Number(session.close_minute_et);
  const cutoff = Number(session.entry_cutoff_minute_et);
  const flatten = Number(session.flatten_minute_et);
  const windows: Window[] = Array.isArray(session.no_trade_windows) ? session.no_trade_windows : [];
  const segments: Segment[] = [];
  // Base layers first, then windows on top (rendered later = above).
  if (Number.isFinite(open) && Number.isFinite(cutoff) && cutoff > open) segments.push({ from: open, to: cutoff, kind: 'open', label: `Entries open ${minuteLabel(open)} – ${minuteLabel(cutoff)}` });
  if (Number.isFinite(cutoff) && Number.isFinite(flatten) && flatten > cutoff) segments.push({ from: cutoff, to: flatten, kind: 'cutoff', label: `No new entries after ${minuteLabel(cutoff)}; positions managed` });
  if (Number.isFinite(flatten) && Number.isFinite(close) && close > flatten) segments.push({ from: flatten, to: close, kind: 'flatten', label: `Mandatory flatten from ${minuteLabel(flatten)}` });
  for (const w of windows) {
    const from = Number(w.start_minute_et); const to = Number(w.end_minute_et);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const reason = String(w.reason || 'no-trade window');
    segments.push({ from, to, kind: /warm-up|opening/i.test(reason) ? 'buffer' : 'event', label: `${reason}: ${minuteLabel(from)} – ${minuteLabel(to)}` });
  }
  return segments;
}

const segmentClass: Record<Segment['kind'], string> = {
  open: 'bg-emerald-500/35',
  cutoff: 'bg-zinc-600/50',
  flatten: 'bg-rose-500/35',
  buffer: 'bg-amber-500/60',
  event: 'bg-fuchsia-500/60'
};

function sessionSentence(session: Record<string, any> | null, nowMin: number): { text: string; tone: Tone } {
  if (!session || session.valid === false) return { text: 'Calendar policy unavailable — entries blocked', tone: 'bad' };
  if (session.is_trading_day === false) return { text: 'Not a trading day — entries blocked', tone: 'muted' };
  const open = Number(session.open_minute_et); const close = Number(session.close_minute_et);
  const cutoff = Number(session.entry_cutoff_minute_et); const flatten = Number(session.flatten_minute_et);
  if (nowMin < open) return { text: `Pre-market — session opens ${minuteLabel(open)}`, tone: 'muted' };
  if (nowMin >= close) return { text: 'Session closed', tone: 'muted' };
  if (nowMin >= flatten) return { text: `Flatten window — every strategy position closes by ${minuteLabel(close)}`, tone: 'bad' };
  const windows: Window[] = Array.isArray(session.no_trade_windows) ? session.no_trade_windows : [];
  const active = windows.find((w) => nowMin >= Number(w.start_minute_et) && nowMin < Number(w.end_minute_et));
  if (active) return { text: `No-trade window: ${active.reason || 'blocked'} until ${minuteLabel(active.end_minute_et)}`, tone: 'warn' };
  if (nowMin >= cutoff) return { text: `Entries closed (cutoff ${minuteLabel(cutoff)}) — flatten at ${minuteLabel(flatten)}`, tone: 'warn' };
  return { text: `Entries open until ${minuteLabel(cutoff)} ET`, tone: 'good' };
}

function Chip({ label, value, tone, title }: { label: string; value: string; tone: Tone; title: string }) {
  return (
    <span title={title} aria-label={`${label} ${value}. ${title}`} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-2xs leading-none', toneClass[tone])}>
      <span className="font-sans font-semibold uppercase tracking-[0.12em] opacity-80">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

export default function CockpitHeader({ strategyState, killSwitch, killSwitchUnavailable, positions, tradeUsage, settings, healthy, healthLabel }: Props) {
  const now = useEtNow();
  const nowMin = etMinuteOfDay(now);
  const signal = strategyState?.signal || null;
  const session: Record<string, any> | null = signal?.session_policy || null;

  const segments = useMemo(() => (session ? buildSegments(session) : []), [session]);
  const open = Number(session?.open_minute_et ?? 9 * 60 + 30);
  const close = Number(session?.close_minute_et ?? 16 * 60);
  const span = Math.max(1, close - open);
  const pct = (minute: number) => `${Math.min(100, Math.max(0, ((minute - open) / span) * 100))}%`;
  const sentence = sessionSentence(session, nowMin);

  // Freshness (all in seconds).
  const spyQuoteAge = signal?.market_data_readiness?.quote_age_seconds ?? null;
  const side = signal?.favoring === 'puts' ? 'put_setup' : signal?.favoring === 'calls' ? 'call_setup' : null;
  const optionQuoteAge = side ? signal?.[side]?.option?.quote_age_seconds ?? null : null;
  const gexAge = signal?.gex?.provider_age_seconds ?? signal?.zerogex_shadow?.provider_age_seconds ?? null;
  const generatedAt = Number(signal?.generated_at || 0);
  const signalAge = generatedAt > 0 ? now.getTime() / 1000 - generatedAt : strategyState?.ageSeconds ?? null;

  // Risk row.
  const live = killSwitch?.live;
  const liveOpen = positions.filter((p) => p.status === 'OPEN' && p.is_simulated !== true && (p.execution_broker || '').toLowerCase() === 'wealthsimple_snaptrade');
  const calls = liveOpen.filter((p) => p.option_type === 'CALL').length;
  const puts = liveOpen.filter((p) => p.option_type === 'PUT').length;
  const sameDirectionMax = Number(settings.max_same_direction_positions || 1) || 1;
  const tradesUsed = tradeUsage?.used ?? null;
  const tradesMax = tradeUsage?.max ?? Number(settings.max_trades_per_day || 2);
  const pnl = live ? Number(live.dayTotalPnl ?? Number(live.dayRealizedPnl || 0) + Number(live.dayOpenPnl || 0)) : null;
  const limit = live ? Number(live.limit) : null;
  const pnlTone: Tone = pnl == null || limit == null ? 'muted' : live?.halted ? 'bad' : pnl <= -Math.abs(limit) * 0.7 ? 'warn' : 'good';
  const autonomous: { text: string; tone: Tone } = killSwitchUnavailable
    ? { text: 'unreachable', tone: 'bad' }
    : !live ? { text: 'loading', tone: 'muted' }
      : live.halted ? { text: 'halted', tone: 'bad' }
        : live.disarmed ? { text: 'disarmed', tone: 'warn' }
          : strategyState?.setupVetoed ? { text: 'armed · setup vetoed', tone: 'warn' }
            : { text: 'armed', tone: 'good' };

  return (
    <section aria-label="Session cockpit" className="border-b border-zinc-800 bg-[#0b0d10] px-3 py-3 sm:px-6">
      {/* Row 1: session timeline */}
      <div className="flex items-center justify-between gap-3 text-2xs text-zinc-500">
        <span className="font-semibold uppercase tracking-[0.16em]">Session</span>
        <span className="font-mono tabular-nums text-zinc-300">{etClock(now)}</span>
      </div>
      <div className="relative mt-1.5 h-3 w-full overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800" role="img" aria-label={segments.map((s) => s.label).join('; ') || 'No session policy'}>
        {segments.map((seg, index) => (
          <div key={`${seg.kind}-${index}`} title={seg.label} className={cn('absolute inset-y-0', segmentClass[seg.kind])} style={{ left: pct(seg.from), width: `calc(${pct(seg.to)} - ${pct(seg.from)})` }} />
        ))}
        {nowMin >= open && nowMin <= close && (
          <div className="absolute inset-y-[-2px] w-0.5 bg-zinc-50 shadow-[0_0_6px_rgba(255,255,255,0.8)]" style={{ left: pct(nowMin) }} aria-hidden="true" />
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs font-mono text-zinc-500">
        <span>{minuteLabel(open).replace(' ET', '')}</span>
        <span className={cn('rounded px-1.5 py-0.5 font-sans font-medium', toneClass[sentence.tone])}>{sentence.text}</span>
        <span>{minuteLabel(close).replace(' ET', '')}</span>
      </div>

      {/* Row 2: freshness + risk */}
      <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5" aria-label="Data freshness against entry gates">
          <Chip label="SPY" value={seconds(spyQuoteAge)} tone={freshnessTone(spyQuoteAge, GATES.spyQuoteSeconds)} title={`SPY quote age / gate ${GATES.spyQuoteSeconds}s (engine stale_after)`} />
          <Chip label="Option" value={seconds(optionQuoteAge)} tone={freshnessTone(optionQuoteAge, GATES.optionQuoteSeconds)} title={`Option quote age / gate ${GATES.optionQuoteSeconds}s (engine + adapter)`} />
          <Chip label="GEX" value={seconds(gexAge)} tone={freshnessTone(gexAge, GATES.gexEngineSeconds)} title={`GEX provider age / engine gate ${GATES.gexEngineSeconds}s, adapter gate ${GATES.gexAdapterSeconds}s`} />
          <Chip label="Signal" value={seconds(signalAge)} tone={freshnessTone(signalAge, GATES.signalSeconds)} title={`Signal age / adapter gate ${GATES.signalSeconds}s`} />
          <Chip label="Gateway" value={healthy == null ? '…' : healthy ? 'up' : 'down'} tone={healthy == null ? 'muted' : healthy ? 'good' : 'bad'} title={healthLabel || 'Strategy engine + IBKR gateway health'} />
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Risk state">
          <Chip label="Day P&L" value={pnl == null ? '—' : `${signedMoney(pnl)} / −$${Math.abs(limit || 0).toFixed(0)}`} tone={pnlTone} title="Realized + open live P&L against the kill-switch limit" />
          <Chip label="Trades" value={`${tradesUsed ?? '—'}/${tradesMax}`} tone={tradesUsed != null && tradesUsed >= tradesMax ? 'warn' : 'muted'} title="Live entries used today vs max_trades_per_day" />
          <Chip label="Dir" value={`C ${calls}/${sameDirectionMax} · P ${puts}/${sameDirectionMax}`} tone={calls >= sameDirectionMax || puts >= sameDirectionMax ? 'warn' : 'muted'} title="Open live positions per direction vs max_same_direction_positions" />
          <Badge variant="outline" className={cn('h-[22px] rounded-md font-mono text-2xs', toneClass[autonomous.tone])} title="Autonomous live entry state (same source as the action bar)">
            auto · {autonomous.text}
          </Badge>
        </div>
      </div>
    </section>
  );
}
