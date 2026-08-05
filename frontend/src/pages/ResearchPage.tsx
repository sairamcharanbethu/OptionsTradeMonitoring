import { useMemo, useState } from 'react';
import { AlertTriangle, Beaker, CheckCircle2, FlaskConical, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { api, SignalReplayResponse, SignalReplayScenario } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const dateInNewYork = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(date);

const dateDaysAgo = (days: number) => {
  const date = new Date(`${dateInNewYork()}T12:00:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

const currency = (value: number | null | undefined) => {
  const number = Number(value || 0);
  return `${number < 0 ? '-' : ''}$${Math.abs(number).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};

const percent = (value: number | null | undefined) => `${Number(value || 0).toFixed(2)}%`;

const signedCurrency = (value: number | null | undefined) => {
  const number = Number(value || 0);
  return `${number >= 0 ? '+' : ''}${currency(number)}`;
};

const signedPercent = (value: number | null | undefined) => {
  const number = Number(value || 0);
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
};

const numberTone = (value: number | null | undefined, positive = 'text-emerald-500') => Number(value || 0) >= 0 ? positive : 'text-red-500';

function Metric({ label, value, detail, tone = 'text-foreground' }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${tone}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function scenarioLabel(name: string) {
  return name === 'vix_contango' ? 'VIX contango' : name.replace(/_/g, ' ');
}

function blockerLabel(category: string) {
  return category.replace(/_/g, ' ');
}

function ScenarioRow({ scenario }: { scenario: SignalReplayScenario }) {
  return (
    <div className="grid gap-2 border-t border-border py-3 text-sm md:grid-cols-[1.2fr_repeat(5,minmax(0,1fr))] md:items-center">
      <div className="min-w-0">
        <div className="font-medium capitalize">{scenarioLabel(scenario.name)}</div>
        <div className="mt-1 break-words text-xs text-muted-foreground">{scenario.description}</div>
      </div>
      <div><div className="text-xs text-muted-foreground">Trades</div><div className="font-mono">{scenario.summary.trades}</div></div>
      <div><div className="text-xs text-muted-foreground">Win rate</div><div className="font-mono">{percent(scenario.summary.winRate)}</div></div>
      <div><div className="text-xs text-muted-foreground">Raw P&amp;L</div><div className={`font-mono ${numberTone(scenario.summary.totalPnl)}`}>{currency(scenario.summary.totalPnl)}</div></div>
      <div><div className="text-xs text-muted-foreground">Realistic P&amp;L</div><div className={`font-mono ${numberTone(scenario.fillRealism.realisticTotalPnl)}`}>{currency(scenario.fillRealism.realisticTotalPnl)}</div></div>
      <div><div className="text-xs text-muted-foreground">Skipped</div><div className="font-mono">{scenario.skippedSignals}</div></div>
    </div>
  );
}

export default function ResearchPage() {
  const [symbols, setSymbols] = useState('SPY,QQQ');
  const [startDate, setStartDate] = useState(dateDaysAgo(30));
  const [endDate, setEndDate] = useState(dateInNewYork());
  const [interval, setInterval] = useState<'1m' | '5m' | '15m' | '1h' | '1d'>('5m');
  const [maxSignals, setMaxSignals] = useState('250');
  const [report, setReport] = useState<SignalReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runReplay = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.runSignalReplay({
        symbols: symbols.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
        startDate,
        endDate,
        interval,
        maxSignals: Math.min(Math.max(Number(maxSignals) || 250, 1), 1000)
      });
      setReport(result);
    } catch (err: any) {
      setError(err.message || 'Signal replay failed');
    } finally {
      setLoading(false);
    }
  };

  const candidate = useMemo(() => report?.scenarios.find((scenario) => scenario.name === 'vix_contango'), [report]);
  const statusReady = report?.research.status === 'READY_FOR_REVIEW';

  return (
    <div className="mx-auto w-full max-w-[1500px] px-3 py-4 sm:w-[95%] sm:px-0">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">Strategy Research</h2>
              <Badge variant="outline" className="gap-1"><FlaskConical className="h-3 w-3" /> Hermes lab</Badge>
            </div>
            <p className="break-words text-sm text-muted-foreground">Replay stored signals against realistic IBKR option and signal-time macro history, testing one change at a time.</p>
          </div>
        </div>
        <Button type="button" variant="outline" className="w-full gap-2 sm:w-auto" onClick={runReplay} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {loading ? 'Running replay' : 'Run replay'}
        </Button>
      </div>

      <div className="mb-4 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Research only. This page does not change scanner settings, approve a strategy, or place trades. A candidate needs enough stored evidence before it is reviewable.</p>
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-4"><CardTitle className="text-base">Replay setup</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs font-medium text-muted-foreground lg:col-span-1">Symbols<input value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="SPY,QQQ" className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" /></label>
          <label className="text-xs font-medium text-muted-foreground">Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" /></label>
          <label className="text-xs font-medium text-muted-foreground">End date<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" /></label>
          <label className="text-xs font-medium text-muted-foreground">Bar interval<select value={interval} onChange={(event) => setInterval(event.target.value as typeof interval)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"><option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="1d">1 day</option></select></label>
          <label className="text-xs font-medium text-muted-foreground">Max signals<input type="number" min="1" max="1000" value={maxSignals} onChange={(event) => setMaxSignals(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" /></label>
        </CardContent>
      </Card>

      {error && <div className="mb-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-500"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

      {!report && !loading && !error && (
        <Card className="border-dashed">
          <CardContent className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
            <Beaker className="mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="font-semibold">Run a controlled experiment</h3>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">The first experiment compares every usable stored signal with the same signal set filtered to stored or signal-time IBKR VIX3M/VIX contango at or above 1.05.</p>
          </CardContent>
        </Card>
      )}

      {loading && <Card><CardContent className="flex min-h-[260px] items-center justify-center gap-3 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Fetching historical option bars from IBKR and replaying scenarios…</CardContent></Card>}

      {report && !loading && (
        <div className="space-y-4">
          <div className={`flex items-start gap-3 rounded-md border p-4 ${statusReady ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
            {statusReady ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />}
            <div className="min-w-0"><div className="font-semibold">{statusReady ? 'Candidate is ready for human review' : 'Not enough comparable evidence yet'}</div><div className="mt-1 break-words text-sm">{report.research.notes[report.research.notes.length - 1]}</div></div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Signals loaded" value={String(report.signalsLoaded)} detail={`${report.generatedSignalsLoaded} generated · ${report.blockedSignalsLoaded} blocked`} />
            <Metric label="Term structure coverage" value={`${report.research.signalsWithTermStructure}/${report.generatedSignalsLoaded}`} detail={`${report.research.signalsBackfilledFromIbkr} backfilled from IBKR; ${report.research.signalsUnavailableForBackfill} unavailable`} />
            <Metric label="Contango floor" value={`${report.research.minimumRatio.toFixed(2)}x`} detail="VIX3M ÷ VIX" />
            <Metric label="Candidate trades" value={String(report.research.candidate.trades)} detail={`Minimum review sample ${report.research.minimumComparableTrades}`} />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">Blocked trade counterfactual replay</CardTitle>
                <Badge variant="outline">Research only</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">Hermes replays the contract that was available when the scanner blocked the setup. This evidence does not approve trades or change live gates.</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <Metric label="Blocked scans" value={String(report.blockedReplay.blockedSignals)} />
                <Metric label="Replayed trades" value={String(report.blockedReplay.replayedTrades)} detail={`${report.blockedReplay.missingPriceHistory} missing price history`} />
                <Metric label="Win rate" value={percent(report.blockedReplay.winRate)} />
                <Metric label="Counterfactual P&L" value={currency(report.blockedReplay.totalPnl)} tone={numberTone(report.blockedReplay.totalPnl)} />
                <Metric label="AI verdict" value={report.blockedReplay.ai.verdict || report.blockedReplay.ai.status.replace(/_/g, ' ')} />
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1.4fr]">
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="text-xs font-semibold text-muted-foreground">Blocker attribution</div>
                  <div className="mt-2 space-y-1 text-sm">
                    {report.blockedReplay.attribution.length === 0 && <div className="text-muted-foreground">No blocked evidence in this range.</div>}
                    {report.blockedReplay.attribution.map((item) => <div key={item.category} className="flex items-center justify-between gap-3"><span className="capitalize text-muted-foreground">{blockerLabel(item.category)}</span><span className="font-mono">{item.replayedTrades}/{item.blockedSignals} · {percent(item.winRate)} · {currency(item.totalPnl)}</span></div>)}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="text-xs font-semibold text-muted-foreground">AI research readout</div>
                  <div className="mt-2 text-sm text-muted-foreground">{report.blockedReplay.ai.analysis || (report.blockedReplay.ai.status === 'INSUFFICIENT_EVIDENCE' ? 'No blocked trade had both a usable contract and replayable option history.' : 'AI readout unavailable; use the blocker attribution and replay totals.')}</div>
                  {report.blockedReplay.ai.recommendations.length > 0 && <ul className="mt-2 space-y-1 text-sm text-muted-foreground">{report.blockedReplay.ai.recommendations.map((recommendation) => <li key={recommendation} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" /><span>{recommendation}</span></li>)}</ul>}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Baseline vs VIX contango</CardTitle></CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-border bg-muted/20 p-4"><div className="mb-3 flex items-center justify-between"><span className="font-semibold">Baseline</span><Badge variant="outline">All usable signals</Badge></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><Metric label="Trades" value={String(report.research.baseline.trades)} /><Metric label="Win rate" value={percent(report.research.baseline.winRate)} /><Metric label="P&L" value={currency(report.research.baseline.totalPnl)} tone={numberTone(report.research.baseline.totalPnl)} /><Metric label="Profit factor" value={report.research.baseline.profitFactor.toFixed(2)} /><Metric label="Max drawdown" value={currency(report.research.baseline.maxDrawdown)} tone="text-red-500" /></div></div>
                <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-4"><div className="mb-3 flex items-center justify-between"><span className="font-semibold">VIX contango</span><Badge variant="outline">Ratio ≥ {report.research.minimumRatio.toFixed(2)}</Badge></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><Metric label="Trades" value={String(report.research.candidate.trades)} /><Metric label="Win rate" value={percent(report.research.candidate.winRate)} /><Metric label="P&L" value={currency(report.research.candidate.totalPnl)} tone={numberTone(report.research.candidate.totalPnl)} /><Metric label="Profit factor" value={report.research.candidate.profitFactor.toFixed(2)} /><Metric label="Max drawdown" value={currency(report.research.candidate.maxDrawdown)} tone="text-red-500" /></div></div>
              </div>
              <div className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-4"><Metric label="Trade delta" value={`${report.research.delta.trades >= 0 ? '+' : ''}${report.research.delta.trades}`} /><Metric label="Win-rate delta" value={signedPercent(report.research.delta.winRate)} tone={numberTone(report.research.delta.winRate)} /><Metric label="P&L delta" value={signedCurrency(report.research.delta.totalPnl)} tone={numberTone(report.research.delta.totalPnl)} /><Metric label="Drawdown delta" value={signedCurrency(report.research.delta.maxDrawdown)} tone={report.research.delta.maxDrawdown <= 0 ? 'text-emerald-500' : 'text-red-500'} /></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Scenario ledger</CardTitle></CardHeader>
            <CardContent className="pt-0"><div className="hidden border-b border-border pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground md:grid md:grid-cols-[1.2fr_repeat(5,minmax(0,1fr))] md:gap-2"><div>Scenario</div><div>Trades</div><div>Win rate</div><div>Raw P&amp;L</div><div>Realistic P&amp;L</div><div>Skipped</div></div>{report.scenarios.map((scenario) => <ScenarioRow key={scenario.name} scenario={scenario} />)}</CardContent>
          </Card>

          {candidate && <Card><CardHeader className="pb-3"><CardTitle className="text-base">Candidate coverage</CardTitle></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-md border border-border bg-muted/20 p-3"><div className="text-xs font-semibold text-muted-foreground">Why signals were excluded</div><div className="mt-2 space-y-1 text-sm">{Object.entries(candidate.skippedReasons).map(([reason, count]) => <div key={reason} className="flex justify-between gap-3"><span className="break-words text-muted-foreground">{reason.replace(/_/g, ' ')}</span><span className="font-mono">{count}</span></div>)}</div></div><div className="rounded-md border border-border bg-muted/20 p-3"><div className="text-xs font-semibold text-muted-foreground">Research notes</div><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{report.research.notes.map((note) => <li key={note} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" /><span>{note}</span></li>)}</ul></div></div></CardContent></Card>}
        </div>
      )}
    </div>
  );
}
