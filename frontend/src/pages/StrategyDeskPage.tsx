import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  ChevronDown,
  Clock3,
  Crosshair,
  Layers3,
  Radar,
  RefreshCw,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { usePaperAccount, useStrategyFamilyHistory, useStrategyHistory, useStrategyState } from '@/hooks/useDashboardData';
import type { ShadowEntryStructureContext, ShadowStrategyFamilyContext, StrategyHistorySetup } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'positive' | 'warning' | 'negative';

const money = (value: unknown, digits = 2) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';
};

const compactTime = (value: unknown) => {
  if (!value) return '—';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const compactEpochTime = (value: unknown) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? compactTime(new Date(seconds * 1000).toISOString())
    : '—';
};

const humanize = (value: unknown, fallback = 'Watching') => {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, letter => letter.toUpperCase());
};

const toneClass: Record<Tone, string> = {
  neutral: 'border-border bg-muted/25 text-foreground',
  positive: 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/25 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300',
  negative: 'border-rose-500/25 bg-rose-500/[0.07] text-rose-700 dark:text-rose-300'
};

function LoadingDesk() {
  return (
    <div className="mx-auto w-full max-w-[1600px] animate-pulse px-3 py-4 sm:w-[95%] sm:px-0" aria-label="Loading Strategy Desk">
      <div className="h-7 w-52 rounded bg-muted" />
      <div className="mt-2 h-4 w-80 max-w-full rounded bg-muted/70" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map(item => <div key={item} className="h-28 rounded-xl border border-border bg-card" />)}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="h-[28rem] rounded-xl border border-border bg-card" />
        <div className="h-[28rem] rounded-xl border border-border bg-card" />
      </div>
    </div>
  );
}

function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <div className={cn('rounded-xl border p-4', toneClass[tone])}>
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-65">{label}</div>
      <div className="mt-2 font-mono text-xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs leading-5 opacity-70">{detail}</div>
    </div>
  );
}

function PlaybookCard({ title, subtitle, value, detail, tone = 'neutral' }: {
  title: string;
  subtitle: string;
  value: string;
  detail: string;
  tone?: Tone;
}) {
  return (
    <article className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <Badge variant="outline" className="shrink-0 border-violet-500/25 bg-violet-500/[0.06] text-[9px] uppercase tracking-wider text-violet-700 dark:text-violet-300">Shadow</Badge>
      </div>
      <div className={cn('mt-4 rounded-lg border px-3 py-2', toneClass[tone])}>
        <div className="text-xs font-semibold">{value}</div>
        <div className="mt-1 text-[11px] leading-4 opacity-75">{detail}</div>
      </div>
    </article>
  );
}

function FamilyCard({ title, subtitle, status, side, observation, facts, tone = 'neutral' }: {
  title: string;
  subtitle: string;
  status: string;
  side: string;
  observation: string;
  facts: Array<{ label: string; value: string }>;
  tone?: Tone;
}) {
  return (
    <article className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <Badge variant="outline" className="border-violet-500/25 bg-violet-500/[0.06] text-[9px] uppercase tracking-wider text-violet-700 dark:text-violet-300">Shadow</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className={cn('rounded-lg border px-3 py-2 text-right', toneClass[tone])}>
          <div className="text-[9px] font-bold uppercase tracking-[0.13em] opacity-65">{side}</div>
          <div className="mt-0.5 text-xs font-semibold">{status}</div>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6">{observation}</p>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {facts.map(fact => (
          <div key={fact.label} className="rounded-lg bg-muted/35 px-3 py-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{fact.label}</div>
            <div className="mt-1 truncate font-mono text-xs font-semibold" title={fact.value}>{fact.value}</div>
          </div>
        ))}
      </div>
    </article>
  );
}

function historyContext(setup: StrategyHistorySetup): ShadowEntryStructureContext {
  return setup.entry_structure_context
    || setup.option_details?.decision_telemetry?.entry_structure_context
    || {};
}

function historyFamilyContext(setup: StrategyHistorySetup): ShadowStrategyFamilyContext {
  return setup.strategy_family_context
    || setup.option_details?.decision_telemetry?.strategy_family_context
    || {};
}

function outcomeTone(setup: StrategyHistorySetup): Tone {
  if (setup.realized_pnl == null) return 'neutral';
  return Number(setup.realized_pnl) >= 0 ? 'positive' : 'negative';
}

function EvidenceFact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      <div className="text-[9px] font-bold uppercase tracking-[0.13em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xs font-semibold">{value}</div>
      {detail && <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{detail}</div>}
    </div>
  );
}

export default function StrategyDeskPage() {
  const strategy = useStrategyState(5000);
  const history = useStrategyHistory(15000);
  const familyHistory = useStrategyFamilyHistory(15000);
  const paper = usePaperAccount(10000);
  const loading = strategy.isLoading && !strategy.data;
  const refreshing = strategy.isFetching || history.isFetching || familyHistory.isFetching || paper.isFetching;
  const signal = strategy.data?.signal || {};
  const laneSignals = strategy.data?.strategySignals || [];
  const orbLaneSignal = laneSignals.find(item => item.lane === 'orb_index')?.signal || {};
  const vwapLaneSignal = laneSignals.find(item => item.lane === 'vwap_trend')?.signal || {};
  const structure: ShadowEntryStructureContext = signal.entry_structure_context
    || signal.decision_telemetry?.entry_structure_context
    || {};
  const emaVwap = structure.ema_vwap || {};
  const emaEvent = emaVwap.event || {};
  const gexRange = structure.gex_range || {};
  const wallBreak = structure.gex_wall_break || {};
  const confluence = structure.confluence || {};
  const prior = structure.prior_session_levels || {};
  const breadth = structure.cross_market || {};
  const trendline = signal.trendline_context || signal.decision_telemetry?.trendline_context || {};
  const family: ShadowStrategyFamilyContext = signal.strategy_family_context
    || signal.decision_telemetry?.strategy_family_context
    || {};
  const orbFamily: ShadowStrategyFamilyContext = orbLaneSignal.strategy_family_context || {};
  const vwapFamily: ShadowStrategyFamilyContext = vwapLaneSignal.strategy_family_context || {};
  const orb = orbFamily.orb_index || family.orb_index || {};
  const orbCandidate = orb.candidate || {};
  const vwapTrend = vwapFamily.vwap_trend || family.vwap_trend || {};
  const vwapCandidate = vwapTrend.candidate || vwapTrend.suppressed_candidate || {};
  const sharedRisk = orbFamily.shared_risk || vwapFamily.shared_risk || family.shared_risk || orb.risk_plan || vwapTrend.risk_plan || {};
  const familyIsPrimary = [orbFamily, vwapFamily, family].some(context => (
    context.entry_authority === true && context.mode === 'primary'
  ));
  const lifecycle = signal.lifecycle || {};
  const side = signal.favoring === 'calls' ? 'CALL' : signal.favoring === 'puts' ? 'PUT' : 'WAIT';
  const isActionable = lifecycle.entry_allowed === true;
  const runtimeHealthy = !strategy.data?.error && (strategy.data?.ageSeconds == null || strategy.data.ageSeconds <= 15);
  const breakEvent = wallBreak.break || {};
  const trendlineBreak = trendline.break || {};
  const recentEvidence = (history.data || []).slice(0, 6);
  const recentFamilyEvents = (familyHistory.data || []).slice(0, 8);
  const telemetryEvidence = (history.data || []).filter(setup => (
    Object.keys(historyContext(setup)).length > 0
    || Object.keys(historyFamilyContext(setup)).length > 0
  ));
  const closedEvidence = telemetryEvidence.filter(setup => setup.realized_pnl != null);
  const evidenceWins = closedEvidence.filter(setup => Number(setup.realized_pnl) > 0).length;
  const tripleConfluenceSetups = telemetryEvidence.filter(setup => historyContext(setup).confluence?.grade === 'TRIPLE_CONFLUENCE').length;
  const closedPaper = paper.data?.recentPositions?.filter(position => position.status === 'CLOSED') || [];
  const paperPnl = closedPaper.reduce((sum, position) => sum + Number(position.realized_pnl || 0), 0);

  const deskRead = useMemo(() => {
    const lines: string[] = [];
    lines.push(isActionable
      ? `${side} entry permission is active under the authoritative strategy rules.`
      : `${side === 'WAIT' ? 'No side is favored' : `${side} is favored`}, but authoritative entry permission is not active.`);
    if (gexRange.available) lines.push(`SPY is ${humanize(gexRange.classification, 'inside the active GEX range').toLowerCase()}.`);
    if (emaEvent.side) lines.push(`${humanize(emaEvent.side)} ${String(emaEvent.line || 'EMA/VWAP').toUpperCase()} rejection was observed on a completed ${emaEvent.timeframe || ''} candle.`);
    if (breadth.available) lines.push(`SPY/QQQ breadth is ${humanize(breadth.alignment).toLowerCase()}${breadth.side ? ` for ${breadth.side}` : ''}.`);
    if (confluence.grade && confluence.grade !== 'NONE') lines.push(`Shadow confluence is ${confluence.score || 0}/${confluence.maximum_score || 3}: ${humanize(confluence.grade)}.`);
    if (lines.length === 1) lines.push('The shadow playbooks are collecting completed-candle evidence; none has produced a current observation.');
    return lines;
  }, [breadth, confluence, emaEvent, gexRange, isActionable, side]);

  const refresh = () => Promise.all([strategy.refetch(), history.refetch(), familyHistory.refetch(), paper.refetch()]);

  if (loading) return <LoadingDesk />;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:w-[95%] sm:px-0 sm:py-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Strategy Desk</h1>
            <Badge variant="outline" className="gap-1 border-violet-500/25 bg-violet-500/[0.06] text-violet-700 dark:text-violet-300">
              <Sparkles className="h-3 w-3" /> Deterministic intelligence
            </Badge>
          </div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">A live SPY decision workspace with completed-candle context, replay evidence, and paper outcomes. Shadow observations explain the tape but never grant entry permission.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild variant="outline" className="h-11 gap-2 sm:h-10">
            <Link to="/?tab=day-trading">Open Day Trading <ArrowRight className="h-4 w-4" /></Link>
          </Button>
          <Button variant="outline" className="h-11 gap-2 sm:h-10" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh desk
          </Button>
        </div>
      </header>

      {(strategy.error || history.error || familyHistory.error || paper.error) && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-800 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>Some desk panels could not refresh. Existing evidence remains visible while the services recover.</span>
          <Button variant="outline" size="sm" onClick={refresh}>Retry all</Button>
        </div>
      )}

      <section className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Strategy desk status" aria-live="polite">
        <Metric label="Authoritative state" value={String(signal.state || 'Unavailable')} detail={isActionable ? 'Entry permission is active' : humanize(signal.signal_phase, 'No entry permission')} tone={isActionable ? 'positive' : 'neutral'} />
        <Metric label="Favored side" value={side} detail={`${humanize(signal.strategy, 'No setup selected')} · ${Number(signal.confidence_score || 0)} confidence`} tone={side === 'CALL' ? 'positive' : side === 'PUT' ? 'negative' : 'neutral'} />
        <Metric label="SPY spot" value={money(signal.spot)} detail={`Signal age ${strategy.data?.ageSeconds == null ? '—' : `${Number(strategy.data.ageSeconds).toFixed(1)}s`}`} tone={runtimeHealthy ? 'neutral' : 'warning'} />
        <Metric label="Paper account" value={money(paper.data?.account?.equity, 0)} detail={`${paper.data?.openPositions?.length || 0} open · closed P&L ${money(paperPnl)}`} tone={paperPnl > 0 ? 'positive' : paperPnl < 0 ? 'negative' : 'neutral'} />
      </section>

      <section className="mt-4 overflow-hidden rounded-xl border border-border bg-muted/[0.08]" aria-labelledby="family-lab-title">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Radar className="h-4 w-4 text-violet-500" />
              <h2 id="family-lab-title" className="text-sm font-semibold">Strategy family lab</h2>
              <Badge variant="secondary">{familyIsPrimary ? 'Autonomous authority' : 'No entry authority'}</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{familyIsPrimary
              ? 'Qualified ORB_INDEX and VWAP_TREND events enter independent authoritative lifecycles for paper processing and per-user guarded live execution.'
              : 'ORB_INDEX and VWAP_TREND are calculated from completed SPY bars and recorded for forward paper evaluation. Their candidates cannot activate, block, or rewrite the live strategy.'}</p>
          </div>
          <Button asChild variant="ghost" size="sm" className="w-fit gap-1.5 text-xs">
            <Link to="/strategy-guide">Read exact rules <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        </div>
        <div className="grid gap-3 p-3 lg:grid-cols-2 sm:p-4">
          <FamilyCard
            title="ORB_INDEX"
            subtitle="09:30–09:35 box · next two completed 1m closes"
            status={humanize(orb.status, orb.available === false ? 'Building range' : 'Unavailable')}
            side={orbCandidate.side === 'calls' ? 'CALL candidate' : orbCandidate.side === 'puts' ? 'PUT candidate' : 'No candidate'}
            observation={orb.observation || 'Waiting for the five opening-range candles.'}
            facts={[
              { label: 'Range high', value: money(orb.opening_range?.high) },
              { label: 'Range low', value: money(orb.opening_range?.low) },
              { label: 'Freshness', value: orbCandidate.fresh == null ? '—' : orbCandidate.fresh ? `${Number(orbCandidate.age_seconds || 0).toFixed(0)}s · fresh` : 'Expired' },
              { label: 'GEX alignment', value: humanize(orb.gex_alignment?.alignment, 'Unavailable') },
              { label: 'Confirmation', value: `${Number(orb.confirmation_bars_seen || 0)}/${Number(orb.trigger_bar_count || 2)} bars` },
              { label: 'Entry authority', value: familyIsPrimary ? 'Autonomous' : 'None' }
            ]}
            tone={orbCandidate.side === 'calls' ? 'positive' : orbCandidate.side === 'puts' ? 'negative' : orb.status === 'EXPIRED_BREAK' ? 'warning' : 'neutral'}
          />
          <FamilyCard
            title="VWAP_TREND"
            subtitle="Slope + hold + adverse pullback + completed reclaim"
            status={humanize(vwapTrend.status, vwapTrend.available === false ? 'Building context' : 'Unavailable')}
            side={vwapCandidate.side === 'calls' ? 'CALL candidate' : vwapCandidate.side === 'puts' ? 'PUT candidate' : 'No candidate'}
            observation={vwapTrend.observation || 'Waiting for completed session bars and volume.'}
            facts={[
              { label: 'Session VWAP', value: money(vwapTrend.trend?.vwap) },
              { label: 'VWAP slope', value: Number.isFinite(Number(vwapTrend.trend?.slope_bps)) ? `${Number(vwapTrend.trend.slope_bps).toFixed(1)} bps` : '—' },
              { label: 'Freshness', value: vwapCandidate.fresh == null ? '—' : vwapCandidate.fresh ? `${Number(vwapCandidate.age_seconds || 0).toFixed(0)}s · fresh` : 'Expired' },
              { label: 'VWAP crosses', value: vwapTrend.kill_switch?.crosses == null ? '—' : `${vwapTrend.kill_switch.crosses}/${vwapTrend.kill_switch.maximum_crosses}` },
              { label: 'Regime switch', value: vwapTrend.kill_switch?.active ? 'Suppressed' : 'Clear' },
              { label: 'Entry authority', value: familyIsPrimary ? 'Autonomous' : 'None' }
            ]}
            tone={vwapTrend.kill_switch?.active || vwapTrend.status === 'REENTRY_COOLDOWN' ? 'warning' : vwapCandidate.side === 'calls' ? 'positive' : vwapCandidate.side === 'puts' ? 'negative' : 'neutral'}
          />
        </div>
        <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
          <div className="bg-card px-4 py-3"><div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Premium stop plan</div><div className="mt-1 font-mono text-sm font-semibold">{sharedRisk.premium_stop_pct == null ? '—' : `−${Number(sharedRisk.premium_stop_pct).toFixed(0)}%`}</div></div>
          <div className="bg-card px-4 py-3"><div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Future trim ladder</div><div className="mt-1 font-mono text-sm font-semibold">{Array.isArray(sharedRisk.trim_ladder_pct) ? sharedRisk.trim_ladder_pct.map((value: number) => `+${value}%`).join(' · ') : '—'}</div></div>
          <div className="bg-card px-4 py-3"><div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Quantity handling</div><div className="mt-1 text-xs font-medium leading-5">{sharedRisk.quantity_aware_ladder || 'Uses configured contract quantity.'}</div></div>
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="family-history-title">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <div className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              <h2 id="family-history-title" className="text-sm font-semibold">Family candidate journal</h2>
              <Badge variant="outline" className="text-[9px] uppercase tracking-wider">Candidate evidence</Badge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">ORB_INDEX and VWAP_TREND candidates are retained with stable event IDs whether they activate, expire, or are suppressed.</p>
          </div>
          <div className="text-[11px] text-muted-foreground">{familyHistory.data?.length || 0} deduplicated candidates retained</div>
        </div>
        {familyHistory.isLoading && !familyHistory.data ? (
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading family candidate history">
            {[0, 1, 2, 3].map(item => <div key={item} className="h-36 animate-pulse rounded-xl bg-muted/50" />)}
          </div>
        ) : recentFamilyEvents.length === 0 ? (
          <div className="px-4 py-9 text-center sm:px-5">
            <Radar className="mx-auto h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">No family candidates recorded yet</h3>
            <p className="mt-1 text-xs text-muted-foreground">The first completed ORB break or VWAP pullback-reclaim will appear here with its activation outcome.</p>
          </div>
        ) : (
          <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-4">
            {recentFamilyEvents.map(event => {
              const isCall = event.side === 'calls';
              const isPut = event.side === 'puts';
              const levelDetail = event.family === 'ORB_INDEX'
                ? `${money(event.opening_range?.low)} → ${money(event.opening_range?.high)}`
                : `${money(event.trend?.vwap)} · ${Number(event.trend?.slope_bps || 0).toFixed(1)} bps`;
              return (
                <article key={event.event_id} className="rounded-xl border border-border bg-muted/[0.12] p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">{event.family}</div>
                      <div className={cn('mt-1 text-sm font-semibold', isCall && 'text-emerald-600 dark:text-emerald-300', isPut && 'text-rose-600 dark:text-rose-300')}>{isCall ? 'CALL' : isPut ? 'PUT' : 'Observed'}</div>
                    </div>
                    <Badge variant="outline" className={cn('text-[9px]', event.suppressed && 'border-amber-500/30 text-amber-700 dark:text-amber-300')}>{event.suppressed ? 'Suppressed' : humanize(event.status)}</Badge>
                  </div>
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Confirmed</span><span>{compactEpochTime(event.confirmed_at)}</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">SPY</span><span className="font-mono">{money(event.spot)}</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Structure</span><span className="truncate font-mono" title={levelDetail}>{levelDetail}</span></div>
                  </div>
                  <p className="mt-3 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{event.observation || 'Shadow candidate recorded for evaluation.'}</p>
                  <div className="mt-3 truncate font-mono text-[9px] text-muted-foreground" title={event.event_id}>{event.event_id}</div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.7fr)]">
        <section className="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="playbooks-title">
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <div>
              <div className="flex items-center gap-2"><Radar className="h-4 w-4 text-muted-foreground" /><h2 id="playbooks-title" className="text-sm font-semibold">Live playbook matrix</h2></div>
              <p className="mt-1 text-xs text-muted-foreground">Independent observations from completed SPY candles and fresh provider context.</p>
            </div>
            <Badge variant="secondary">Advisory only</Badge>
          </div>
          <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
            <PlaybookCard title="EMA9 + VWAP rejection" subtitle="Completed 3m / 5m candle" value={emaEvent.side ? `${humanize(emaEvent.side)} ${String(emaEvent.line || 'event').toUpperCase()}` : 'No confirmed rejection'} detail={emaVwap.observation || 'Waiting for a wick-through and close-back confirmation.'} tone={emaEvent.side === 'bullish' ? 'positive' : emaEvent.side === 'bearish' ? 'negative' : 'neutral'} />
            <PlaybookCard title="GEX range location" subtitle="Put wall → call wall" value={humanize(gexRange.classification, 'Unavailable')} detail={gexRange.available ? `Floor ${money(gexRange.floor)} · ceiling ${money(gexRange.ceiling)}` : gexRange.reason || 'Fresh walls and ATR are required.'} tone={gexRange.range_play_eligible ? 'positive' : gexRange.avoid_mid_range ? 'warning' : 'neutral'} />
            <PlaybookCard title="Wall break + retest" subtitle="Close and volume confirmation" value={breakEvent.status ? `${humanize(breakEvent.status)} ${humanize(breakEvent.side, '')}` : 'No active wall break'} detail={breakEvent.status ? `Retest ${humanize(wallBreak.retest?.status)} · event ${breakEvent.event_id || '—'}` : wallBreak.observation || 'A wick through a wall does not qualify.'} tone={breakEvent.confirmed ? 'positive' : breakEvent.status === 'low_volume_cross' ? 'warning' : 'neutral'} />
            <PlaybookCard title="Confluence grade" subtitle="Location + VWAP + EMA9" value={`${Number(confluence.score || 0)}/${Number(confluence.maximum_score || 3)} · ${humanize(confluence.grade, 'None')}`} detail={confluence.conflicted ? 'Evidence points in opposing directions.' : confluence.all_aligned ? `${humanize(confluence.side)} timing stack is aligned.` : 'The complete three-part stack is not present.'} tone={confluence.all_aligned ? 'positive' : confluence.conflicted ? 'negative' : Number(confluence.score || 0) > 0 ? 'warning' : 'neutral'} />
            <PlaybookCard title="Prior-session zones" subtitle="Confirmed rejection clusters" value={prior.available ? `${humanize(prior.nearest_level)} nearest` : 'No confirmed zone'} detail={prior.available ? `Support ${money(prior.support?.price)} · resistance ${money(prior.resistance?.price)}` : prior.reason || 'Waiting for enough prior-session structure.'} tone={prior.at_support || prior.at_resistance ? 'warning' : 'neutral'} />
            <PlaybookCard title="SPY / QQQ breadth" subtitle="5m + 15m structure" value={humanize(breadth.alignment, 'Unavailable')} detail={breadth.observation || breadth.reason || 'Fresh QQQ quote and completed bars are required.'} tone={breadth.alignment === 'FULL' ? 'positive' : breadth.alignment === 'DIVERGENT' ? 'negative' : breadth.alignment === 'PARTIAL' ? 'warning' : 'neutral'} />
            <PlaybookCard title="Pivot trendline" subtitle="ATR slope · completed close" value={trendlineBreak.confirmed ? `${humanize(trendlineBreak.side)} break` : 'Between active lines'} detail={trendline.observation || (trendline.available ? `Retest ${humanize(trendline.retest?.status)}` : trendline.reason || 'Insufficient completed bars.')} tone={trendlineBreak.confirmed ? 'positive' : 'neutral'} />
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="desk-read-title">
            <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-500" /><h2 id="desk-read-title" className="text-sm font-semibold">StrikePilot desk read</h2></div>
            <div className="mt-4 space-y-3">
              {deskRead.map((line, index) => (
                <div key={line} className="grid grid-cols-[1.25rem_1fr] gap-2 text-sm leading-6">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                  <p>{line}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-violet-500/20 bg-violet-500/[0.05] px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              This read is deterministic and replayable. Only an authoritative strategy lane can activate its own entry; shadow evidence cannot override blockers.
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="risk-title">
            <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-muted-foreground" /><h2 id="risk-title" className="text-sm font-semibold">Operator checks</h2></div>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2"><span className="text-muted-foreground">Runtime freshness</span><span className={runtimeHealthy ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'}>{runtimeHealthy ? 'Fresh' : 'Review'}</span></div>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2"><span className="text-muted-foreground">Entry permission</span><span className={isActionable ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'}>{isActionable ? 'Granted' : 'Locked'}</span></div>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2"><span className="text-muted-foreground">Shadow authority</span><span className="text-muted-foreground">None</span></div>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2"><span className="text-muted-foreground">Paper automation</span><span>{humanize(paper.data?.account?.automation_status, 'Unavailable')}</span></div>
            </div>
          </section>
        </aside>
      </div>

      <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="evidence-title">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <div className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-muted-foreground" /><h2 id="evidence-title" className="text-sm font-semibold">Replay evidence</h2></div>
            <p className="mt-1 text-xs text-muted-foreground">The latest persisted setups with the shadow context known at decision time.</p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /> New telemetry appears on setups created after this release.</div>
        </div>
        <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
          <div className="bg-card px-4 py-3"><div className="text-[9px] uppercase tracking-wider text-muted-foreground">Telemetry setups</div><div className="mt-1 font-mono text-base font-semibold">{telemetryEvidence.length}</div></div>
          <div className="bg-card px-4 py-3"><div className="text-[9px] uppercase tracking-wider text-muted-foreground">Closed sample</div><div className="mt-1 font-mono text-base font-semibold">{closedEvidence.length}</div></div>
          <div className="bg-card px-4 py-3"><div className="text-[9px] uppercase tracking-wider text-muted-foreground">Observed win rate</div><div className="mt-1 font-mono text-base font-semibold">{closedEvidence.length ? `${Math.round((evidenceWins / closedEvidence.length) * 100)}%` : '—'}</div></div>
          <div className="bg-card px-4 py-3"><div className="text-[9px] uppercase tracking-wider text-muted-foreground">Triple confluence</div><div className="mt-1 font-mono text-base font-semibold">{tripleConfluenceSetups}</div></div>
        </div>
        <p className="border-b border-border px-4 py-2 text-[10px] leading-4 text-muted-foreground sm:px-5">Descriptive recent sample only. It is not a backtest, expectancy estimate, or promotion signal.</p>
        {recentEvidence.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Crosshair className="mx-auto h-6 w-6 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold">No replayable setups yet</h3>
            <p className="mt-1 text-xs text-muted-foreground">The next persisted strategy setup will include compact shadow evidence.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {recentEvidence.map(setup => {
              const context = historyContext(setup);
              const grade = context.confluence?.grade;
              const recordedTrendline = setup.trendline_context || setup.option_details?.decision_telemetry?.trendline_context || {};
              const recordedFamily = historyFamilyContext(setup);
              const recordedOrb = recordedFamily.orb_index || {};
              const recordedVwapTrend = recordedFamily.vwap_trend || {};
              const recordedEma = context.ema_vwap?.event || {};
              const recordedRange = context.gex_range || {};
              const recordedWall = context.gex_wall_break || {};
              const recordedBreadth = context.cross_market || {};
              const recordedPrior = context.prior_session_levels || {};
              const pnl = setup.realized_pnl == null ? 'No closed P&L' : `${Number(setup.realized_pnl) >= 0 ? '+' : ''}${money(setup.realized_pnl)}`;
              return (
                <details key={setup.setup_id} className="group">
                  <summary className="grid cursor-pointer list-none gap-3 px-4 py-4 transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1.25fr)_repeat(3,minmax(7rem,0.55fr))_1rem] sm:items-center sm:px-5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className={setup.side === 'CALL' ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}>{setup.side}</Badge><span className="truncate text-sm font-semibold">{humanize(setup.strategy_name, 'Strategy setup')}</span></div>
                      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={setup.setup_id}>{compactTime(setup.created_at)} · {setup.setup_id}</div>
                      <div className="mt-1 text-[10px] font-medium text-violet-600 dark:text-violet-300 sm:hidden">Tap to review recorded evidence</div>
                    </div>
                    <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Confluence</div><div className="mt-1 text-xs font-semibold">{humanize(grade, 'Legacy record')}</div></div>
                    <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Lifecycle</div><div className="mt-1 text-xs font-semibold">{humanize(setup.lifecycle_status)}</div></div>
                    <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Outcome</div><div className={cn('mt-1 text-xs font-semibold', outcomeTone(setup) === 'positive' && 'text-emerald-600 dark:text-emerald-300', outcomeTone(setup) === 'negative' && 'text-rose-600 dark:text-rose-300')}>{pnl}</div></div>
                    <ChevronDown className="hidden h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180 sm:block" />
                  </summary>
                  <div className="border-t border-border bg-muted/[0.08] px-4 py-4 sm:px-5">
                    {Object.keys(context).length === 0 && Object.keys(recordedFamily).length === 0 ? (
                      <p className="text-xs text-muted-foreground">This setup predates compact shadow telemetry. Its lifecycle and outcome remain available above.</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <EvidenceFact label="GEX location" value={humanize(recordedRange.classification, 'Unavailable')} detail={recordedRange.available ? `${money(recordedRange.floor)} → ${money(recordedRange.ceiling)}` : recordedRange.reason} />
                        <EvidenceFact label="EMA / VWAP" value={recordedEma.side ? `${humanize(recordedEma.side)} ${String(recordedEma.line || '')}` : 'No event'} detail={recordedEma.timeframe ? `Completed ${recordedEma.timeframe} candle` : undefined} />
                        <EvidenceFact label="Wall break" value={humanize(recordedWall.break?.status, 'No break')} detail={recordedWall.retest?.status ? `Retest ${humanize(recordedWall.retest.status)}` : undefined} />
                        <EvidenceFact label="SPY / QQQ" value={humanize(recordedBreadth.alignment, 'Unavailable')} detail={recordedBreadth.reason || 'Shadow breadth at decision time'} />
                        <EvidenceFact label="Prior session" value={recordedPrior.available ? `${humanize(recordedPrior.nearest_level)} nearest` : 'Unavailable'} detail={recordedPrior.available ? `${money(recordedPrior.support?.price)} / ${money(recordedPrior.resistance?.price)}` : recordedPrior.reason} />
                        <EvidenceFact label="Trendline" value={recordedTrendline.break?.confirmed ? `${humanize(recordedTrendline.break.side)} break` : recordedTrendline.available ? 'No confirmed break' : 'Unavailable'} detail={recordedTrendline.retest?.status ? `Retest ${humanize(recordedTrendline.retest.status)}` : recordedTrendline.reason} />
                        <EvidenceFact label="ORB_INDEX" value={humanize(recordedOrb.status, 'Unavailable')} detail={recordedOrb.candidate?.side ? `${humanize(recordedOrb.candidate.side)} · ${recordedOrb.candidate.fresh ? 'fresh' : 'expired'}` : recordedOrb.reason} />
                        <EvidenceFact label="VWAP_TREND" value={humanize(recordedVwapTrend.status, 'Unavailable')} detail={(recordedVwapTrend.candidate || recordedVwapTrend.suppressed_candidate)?.side ? `${humanize((recordedVwapTrend.candidate || recordedVwapTrend.suppressed_candidate).side)} · ${Number(recordedVwapTrend.trend?.slope_bps || 0).toFixed(1)} bps` : recordedVwapTrend.reason} />
                        <EvidenceFact label="Lifecycle events" value={String(setup.lifecycle_events.length)} detail={`Final ${humanize(setup.lifecycle_status)}`} />
                        <EvidenceFact label="Decision authority" value="None" detail="Recorded evidence only; no entry override" />
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>

      <footer className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-muted/20 px-4 py-3 text-[11px] leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> Live state refreshes every 5 seconds; history every 15 seconds.</span>
        <span className="flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5" /> ORB and VWAP are primary; contextual overlays remain shadow-only.</span>
      </footer>
    </div>
  );
}
