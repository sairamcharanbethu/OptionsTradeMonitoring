import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronDown, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import HoldToConfirmButton from '@/components/HoldToConfirmButton';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/hooks/useDashboardData';
import { useLatestAiVerdict } from '@/hooks/tradeEventStore';
import { cn } from '@/lib/utils';
import PriceLadder from './PriceLadder';
import { expiryModeLabel, money, num, seconds, toneClass, type Tone } from './format';
import { contractName, humanContractName, integer, optionExpiryLabel } from './terminalModel';

/** Entry gates the contract block colours against (mirrored from the code). */
const SPREAD_ENTRY_GATE_PCT = 5;   // TradeExecutionService entry quote gate
const SPREAD_ENGINE_MAX_PCT = 15;  // signal_engine MAX_OPTION_SPREAD_PCT
const MIN_REWARD_RISK = 1.5;       // signal_engine MIN_PLAN_REWARD_RISK / adapter MIN_PLAN_REWARD_RISK
const OPTION_QUOTE_GATE_S = 15;

interface Props {
  signal: Record<string, any> | null;
  side: 'CALL' | 'PUT' | null;
  setup: Record<string, any> | null;
  option: Record<string, any>;
  setupId: string | null;
  vetoed: boolean;
  settings: Record<string, string>;
  lifecycle: string;
}

function Stat({ label, value, tone = 'muted', title }: { label: string; value: string; tone?: Tone | 'plain'; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={cn('mt-0.5 truncate font-mono text-xs tabular-nums', tone === 'plain' ? 'text-zinc-200' : tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-rose-300' : 'text-zinc-300')}>{value}</div>
    </div>
  );
}

/** Setup-specific ladder: stop → trigger → targets, with distance-to-trigger and underlying R. */
function SetupLadder({ side, invalidation, trigger, targets, spot, atr }: { side: 'CALL' | 'PUT'; invalidation: number; trigger: number; targets: number[]; spot: number | null; atr: number | null }) {
  const distance = spot != null ? (side === 'CALL' ? trigger - spot : spot - trigger) : null;
  return (
    <PriceLadder
      side={side}
      spot={spot}
      marks={[
        { price: invalidation, label: 'Stop', cls: 'bg-rose-400' },
        { price: trigger, label: 'Trigger', cls: 'bg-sky-300' },
        ...targets.map((t, i) => ({ price: t, label: `T${i + 1}`, cls: 'bg-emerald-400' }))
      ]}
      ariaLabel={`Price ladder: stop ${money(invalidation)}, trigger ${money(trigger)}, targets ${targets.map((t) => money(t)).join(', ')}${spot != null ? `, spot ${money(spot)}` : ''}`}
      footer={(
        <>
          <span>Direction <span className="font-semibold text-zinc-200">{side === 'CALL' ? 'up →' : 'down →'}</span> (profit runs right)</span>
          {distance != null && (
            <span>
              To trigger <span className={cn('font-mono font-semibold', distance <= 0 ? 'text-emerald-300' : 'text-zinc-200')}>{distance <= 0 ? 'through' : `${money(distance)}${atr ? ` · ${num(distance / atr, 2)} ATR` : ''}`}</span>
            </span>
          )}
          <span>Underlying R <span className="font-mono font-semibold text-zinc-200">{money(Math.abs(trigger - invalidation))}</span></span>
        </>
      )}
    />
  );
}

export default function SetupCard({ signal, side, setup, option, setupId, vetoed, settings, lifecycle }: Props) {
  const queryClient = useQueryClient();
  const aiVerdict = useLatestAiVerdict(setupId);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: Tone; text: string } | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);

  const spot = signal?.spot != null ? Number(signal.spot) : null;
  const atr = signal?.market_context?.atr_5m != null ? Number(signal.market_context.atr_5m) : null;
  const trigger = setup?.trigger != null ? Number(setup.trigger) : NaN;
  const invalidation = setup?.invalidation != null ? Number(setup.invalidation) : setup?.stop != null ? Number(setup.stop) : NaN;
  const targets: number[] = (Array.isArray(setup?.targets) ? setup.targets : []).map(Number).filter((v: number) => Number.isFinite(v)).slice(0, 3);
  const hasPlan = side != null && Number.isFinite(trigger) && Number.isFinite(invalidation) && targets.length > 0;
  const quality = setup?.plan_quality || signal?.plan_quality || {};
  const rewardRisk = quality.reward_risk != null ? Number(quality.reward_risk) : null;
  const meetsMin = quality.meets_minimum === true || (rewardRisk != null && rewardRisk >= MIN_REWARD_RISK);

  const spread = option.spread_pct != null ? Number(option.spread_pct) : (option.bid > 0 && option.ask > 0 && option.mid > 0 ? ((option.ask - option.bid) / option.mid) * 100 : NaN);
  const spreadTone: Tone = !Number.isFinite(spread) ? 'muted' : spread > SPREAD_ENGINE_MAX_PCT ? 'bad' : spread > SPREAD_ENTRY_GATE_PCT ? 'warn' : 'good';
  const quoteAge = option.quote_age_seconds != null ? Number(option.quote_age_seconds) : null;
  const quoteTone: Tone = quoteAge == null ? 'muted' : quoteAge > OPTION_QUOTE_GATE_S ? 'bad' : quoteAge > OPTION_QUOTE_GATE_S * 0.7 ? 'warn' : 'good';
  const stopRisk = option.estimated_stop_risk?.per_contract_dollars != null ? Number(option.estimated_stop_risk.per_contract_dollars) : null;
  const riskBudget = Number(settings.strategy_max_risk_per_trade_dollars || 500) || 500;
  const riskTone: Tone = stopRisk == null ? 'muted' : stopRisk > riskBudget ? 'bad' : stopRisk > riskBudget * 0.7 ? 'warn' : 'good';
  const eligible = option.eligible === true;
  const rejections: string[] = Array.isArray(option.rejection_reasons) ? option.rejection_reasons : [];
  const blockers: string[] = Array.from(new Set(((signal?.blockers || []) as unknown[]).filter(Boolean).map(String))).reverse();
  const warnings: string[] = Array.from(new Set(((signal?.warnings || []) as unknown[]).filter(Boolean).map(String)));
  const dte = expiryModeLabel(option.expiry_mode);

  const run = useCallback(async (action: () => Promise<string>, tone: Tone) => {
    if (busy) return;
    setBusy(true);
    try {
      setNote({ tone, text: await action() });
    } catch (err: any) {
      setNote({ tone: 'bad', text: err?.message || 'Action failed' });
    } finally {
      setBusy(false);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyState });
    }
  }, [busy, queryClient]);

  const veto = useCallback(() => {
    if (!setupId) return;
    void run(async () => { await api.vetoSetup(setupId, 'setup card'); return `Setup ${setupId.slice(0, 8)} vetoed — the engine will not enter it.`; }, 'warn');
  }, [run, setupId]);
  const unveto = useCallback(() => {
    if (!setupId) return;
    void run(async () => { await api.unvetoSetup(setupId); return `Veto cleared on setup ${setupId.slice(0, 8)}.`; }, 'good');
  }, [run, setupId]);

  const stateTone: Tone = lifecycle === 'ACTIVE' ? 'good' : lifecycle === 'ARMED' ? 'warn' : ['INVALIDATED', 'FAILED', 'TRACKING_ABORTED'].includes(lifecycle) ? 'bad' : 'muted';

  return (
    <section aria-label="Current setup" className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
      {/* Status strip */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn('font-mono text-2xs', toneClass[stateTone])}>{lifecycle}</Badge>
          <span className="text-sm font-semibold text-zinc-100">{signal?.strategy || 'No setup'}</span>
          {side && <Badge variant="outline" className="border-zinc-700 bg-zinc-950 font-mono text-2xs text-zinc-300">{side}</Badge>}
          {signal?.confidence_score != null && <span className="font-mono text-2xs text-zinc-400" title="Engine confidence score">score {num(signal.confidence_score, 0)}</span>}
          {setupId && <span className="font-mono text-2xs text-zinc-500" title={setupId}>#{setupId.slice(0, 8)}</span>}
          {vetoed && <Badge variant="outline" className={cn('font-mono text-2xs', toneClass.warn)}>VETOED</Badge>}
        </div>
        {setupId && (
          vetoed
            ? <HoldToConfirmButton label="Clear veto" hint="Allow the engine to enter this setup again" icon={<RotateCcw className="h-3.5 w-3.5" />} tone="good" busy={busy} onConfirm={unveto} />
            : <HoldToConfirmButton label="Veto setup" hint="Block autonomous entry for this setup id" icon={<Ban className="h-3.5 w-3.5" />} tone="warn" busy={busy} onConfirm={veto} shortcut="Shift+V" />
        )}
      </div>
      {note && <div className={cn('mt-2 rounded-md border px-2.5 py-1.5 text-2xs', toneClass[note.tone])} role="status">{note.text}</div>}

      {/* Plan geometry */}
      {hasPlan && side ? (
        <SetupLadder side={side} invalidation={invalidation} trigger={trigger} targets={targets} spot={spot} atr={atr} />
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center text-xs text-zinc-500">
          No frozen plan yet. Trigger, invalidation and targets appear when a setup arms.
        </div>
      )}
      {hasPlan && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-800 pt-3 sm:grid-cols-4">
          <Stat label="Reward / risk" value={rewardRisk != null ? `${num(rewardRisk)} : 1` : '—'} tone={rewardRisk == null ? 'muted' : meetsMin ? 'good' : 'bad'} title={`Minimum ${MIN_REWARD_RISK}:1`} />
          <Stat label="Spot" value={money(spot)} tone="plain" />
          <Stat label="ATR (5m)" value={money(atr)} tone="plain" />
          <Stat label="Targets" value={targets.map((t) => num(t)).join(' → ')} tone="plain" />
        </div>
      )}

      {/* Contract block */}
      <div className="mt-4 rounded-lg bg-zinc-950/55 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Contract</div>
            <div className="mt-0.5 text-sm font-semibold text-zinc-100">{humanContractName(option, side)}</div>
            <div className="mt-0.5 select-all break-all font-mono text-2xs text-zinc-500" title="Contract symbol">
              {option.local_symbol || contractName(option, side)}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {option.expiry != null && <Badge variant="outline" className="border-zinc-700 bg-zinc-950 font-mono text-2xs text-zinc-300">{optionExpiryLabel(option.expiry)}</Badge>}
            {dte && <Badge variant="outline" className="border-zinc-700 bg-zinc-950 font-mono text-2xs text-zinc-300">{dte}</Badge>}
            <Badge variant="outline" className={cn('font-mono text-2xs', eligible ? toneClass.good : toneClass.bad)}>{eligible ? 'eligible' : 'not eligible'}</Badge>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
          <Stat label="Bid" value={money(option.bid)} tone="plain" />
          <Stat label="Ask" value={money(option.ask)} tone="plain" />
          <Stat label="Mid" value={money(option.mid)} tone="plain" />
          <Stat label="Spread" value={Number.isFinite(spread) ? `${num(spread, 1)}%` : '—'} tone={spreadTone} title={`Entry gate ${SPREAD_ENTRY_GATE_PCT}% · engine max ${SPREAD_ENGINE_MAX_PCT}%`} />
          <Stat label="Delta" value={num(option.delta)} tone="plain" />
          <Stat label="Quote age" value={seconds(quoteAge)} tone={quoteTone} title={`Gate ${OPTION_QUOTE_GATE_S}s`} />
          <Stat label="Planned qty" value={option.planned_contracts != null ? String(option.planned_contracts) : '—'} tone="plain" />
          <Stat label="Planned limit" value={money(option.planned_limit_price)} tone="plain" />
          <Stat label="Stop risk / ct" value={stopRisk != null ? `${money(stopRisk, 0)} / ${money(riskBudget, 0)}` : '—'} tone={riskTone} title="Estimated stop-loss $ per contract vs strategy_max_risk_per_trade_dollars" />
          <Stat label="Method" value={String(option.estimated_stop_risk?.method || '—').replace(/_/g, ' ')} tone="plain" />
          <Stat label="Mark" value={money(option.mark)} tone="plain" />
          <Stat label="Volume" value={integer(option.volume)} tone="plain" />
          <Stat label="Open interest" value={integer(option.openInterest ?? option.open_interest)} tone="plain" />
        </div>
        <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
          {option.mark != null && Number.isFinite(Number(option.mark))
            ? 'Entry remains blocked when the quote is older than 15 seconds or the spread fails the strategy quality gate.'
            : 'IBKR did not provide a mark. Bid and ask can still support a protected planned limit, but entry remains blocked unless the complete quote passes freshness and spread checks.'}
        </p>
        {rejections.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-2xs text-rose-300/90">
            {rejections.map((r) => <li key={r}>• {r}</li>)}
          </ul>
        )}
      </div>

      {/* Blockers, AI verdict, warnings */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div>
          <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Blockers {blockers.length ? `(${blockers.length})` : ''}</div>
          {blockers.length ? (
            <ul className="mt-1.5 space-y-1">
              {blockers.map((b) => <li key={b} className="rounded bg-zinc-950/55 px-2.5 py-1.5 text-2xs leading-relaxed text-amber-200/90">{b}</li>)}
            </ul>
          ) : <div className="mt-1.5 text-2xs text-emerald-300/80">No blockers.</div>}
        </div>
        <div>
          <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">AI gate</div>
          {aiVerdict ? (
            <div className={cn('mt-1.5 rounded border px-2.5 py-1.5 text-2xs leading-relaxed', aiVerdict.metadata?.decision === 'SKIP' ? toneClass.bad : toneClass.good)}>
              <span className="font-mono font-semibold">{String(aiVerdict.metadata?.decision || '—')} · {String(aiVerdict.metadata?.risk_tier || '—')} · {String(aiVerdict.metadata?.source || '—')}</span>
              <div className="mt-0.5 opacity-90">{String(aiVerdict.metadata?.rationale || aiVerdict.message || '')}</div>
            </div>
          ) : <div className="mt-1.5 text-2xs text-zinc-500">No verdict yet for this setup (runs at entry time).</div>}
        </div>
      </div>
      {warnings.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setWarningsOpen((v) => !v)} aria-expanded={warningsOpen} className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500 hover:text-zinc-300">
            Warnings ({warnings.length}) <ChevronDown className={cn('h-3 w-3 transition-transform', warningsOpen && 'rotate-180')} />
          </button>
          {warningsOpen && (
            <ul className="mt-1.5 space-y-1">
              {warnings.map((w) => <li key={w} className="rounded bg-zinc-950/40 px-2.5 py-1 text-2xs text-zinc-400">{w}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
