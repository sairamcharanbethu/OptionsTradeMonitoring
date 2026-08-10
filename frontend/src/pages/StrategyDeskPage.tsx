import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Clock3,
  Crosshair,
  Layers3,
  Radar,
  RefreshCw,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { usePaperAccount, useStrategyHistory, useStrategyState } from '@/hooks/useDashboardData';
import type { ShadowEntryStructureContext, StrategyHistorySetup } from '@/lib/api';
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

function historyContext(setup: StrategyHistorySetup): ShadowEntryStructureContext {
  return setup.entry_structure_context
    || setup.option_details?.decision_telemetry?.entry_structure_context
    || {};
}

function outcomeTone(setup: StrategyHistorySetup): Tone {
  if (setup.realized_pnl == null) return 'neutral';
  return Number(setup.realized_pnl) >= 0 ? 'positive' : 'negative';
}

export default function StrategyDeskPage() {
  const strategy = useStrategyState(5000);
  const history = useStrategyHistory(15000);
  const paper = usePaperAccount(10000);
  const loading = strategy.isLoading && !strategy.data;
  const refreshing = strategy.isFetching || history.isFetching || paper.isFetching;
  const signal = strategy.data?.signal || {};
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
  const lifecycle = signal.lifecycle || {};
  const side = signal.favoring === 'calls' ? 'CALL' : signal.favoring === 'puts' ? 'PUT' : 'WAIT';
  const isActionable = lifecycle.entry_allowed === true;
  const runtimeHealthy = !strategy.data?.error && (strategy.data?.ageSeconds == null || strategy.data.ageSeconds <= 15);
  const breakEvent = wallBreak.break || {};
  const trendlineBreak = trendline.break || {};
  const recentEvidence = (history.data || []).slice(0, 6);
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

  const refresh = () => Promise.all([strategy.refetch(), history.refetch(), paper.refetch()]);

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

      {(strategy.error || history.error || paper.error) && (
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
              This read is deterministic and replayable. Only the authoritative lifecycle can activate an entry; shadow evidence cannot override blockers.
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
              const pnl = setup.realized_pnl == null ? 'No closed P&L' : `${Number(setup.realized_pnl) >= 0 ? '+' : ''}${money(setup.realized_pnl)}`;
              return (
                <article key={setup.setup_id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1.25fr)_repeat(3,minmax(7rem,0.55fr))] sm:items-center sm:px-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className={setup.side === 'CALL' ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}>{setup.side}</Badge><span className="truncate text-sm font-semibold">{humanize(setup.strategy_name, 'Strategy setup')}</span></div>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">{compactTime(setup.created_at)} · {setup.setup_id}</div>
                  </div>
                  <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Confluence</div><div className="mt-1 text-xs font-semibold">{humanize(grade, 'Legacy record')}</div></div>
                  <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Lifecycle</div><div className="mt-1 text-xs font-semibold">{humanize(setup.lifecycle_status)}</div></div>
                  <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Outcome</div><div className={cn('mt-1 text-xs font-semibold', outcomeTone(setup) === 'positive' && 'text-emerald-600 dark:text-emerald-300', outcomeTone(setup) === 'negative' && 'text-rose-600 dark:text-rose-300')}>{pnl}</div></div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-muted/20 px-4 py-3 text-[11px] leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> Live state refreshes every 5 seconds; history every 15 seconds.</span>
        <span className="flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5" /> Shadow observations require forward paper evidence before promotion.</span>
      </footer>
    </div>
  );
}
