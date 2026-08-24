import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BarChart3, Bell, RefreshCw, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react';
import { api, TradeAlertsResponse, TradeReportResponse, PerformanceMetrics } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

// Frozen out-of-sample benchmark (90 sessions, 2026-04-14..08-20, live exit
// policy simulated; docs/uw-backtest-2026-04-14-to-08-20.md). Deliberately
// hardcoded: it is the fixed reference the paper proving period is judged
// against — it must not drift with live data.
const BENCHMARK_BY_STRATEGY: Record<string, { trades: number; winRate: number; avgPnl: number }> = {
  CONTINUATION: { trades: 31, winRate: 0.48, avgPnl: 9.84 },
  GEX_WALL_REJECTION: { trades: 9, winRate: 0.56, avgPnl: 35.0 },
  GEX_WALL_BREAK_FAIL: { trades: 14, winRate: 0.57, avgPnl: 3.03 },
  MTF_TREND_BREAK: { trades: 39, winRate: 0.41, avgPnl: -5.21 },
  ORB_INDEX: { trades: 9, winRate: 0.22, avgPnl: -57.28 },
  VWAP_TREND: { trades: 25, winRate: 0.36, avgPnl: -2.99 },
};

const SCOPE_OPTIONS = [
  { value: 'paper', label: 'Paper account' },
  { value: 'live', label: 'Live account' },
];

const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Past week' },
  { value: '30d', label: 'Past month' },
  { value: '90d', label: 'Past 3 months' },
  { value: 'ytd', label: 'YTD' },
  { value: '1y', label: 'Past year' }
];

const currency = (value?: number | null) => {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
};

const compactDate = (value?: string | null) => {
  if (!value) return '-';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
};

const contractLabel = (trade: any) => {
  const expiry = String(trade.expiration_date || '').split('T')[0];
  return `${trade.symbol} ${expiry} ${trade.option_type} ${Number(trade.strike_price).toFixed(0)}`;
};

const alertTone = (severity: string) => {
  if (severity === 'critical') return 'border-red-500/30 bg-red-500/10 text-red-600';
  if (severity === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  return 'border-blue-500/30 bg-blue-500/10 text-blue-600';
};

function MetricTile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'green' | 'red' | 'amber' }) {
  const toneClass = tone === 'green' ? 'text-emerald-500' : tone === 'red' ? 'text-red-500' : tone === 'amber' ? 'text-amber-500' : '';
  return (
    <div className="rounded-md border border-border bg-card p-3 sm:p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 break-words font-mono text-lg font-semibold sm:text-xl ${toneClass}`}>{value}</div>
      {detail && <div className="mt-2 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, detail }: { icon: any; title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-start gap-1.5 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </div>
  );
}

export default function TradeIntelligencePage() {
  const [range, setRange] = useState('30d');
  const [scope, setScope] = useState<'paper' | 'live'>('paper');
  const [report, setReport] = useState<TradeReportResponse | null>(null);
  const [alerts, setAlerts] = useState<TradeAlertsResponse | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const daysForRange = (r: string): number => {
    if (r === 'ytd') {
      const now = new Date();
      const jan1 = new Date(now.getFullYear(), 0, 1);
      return Math.max(1, Math.ceil((now.getTime() - jan1.getTime()) / 86_400_000));
    }
    return ({ today: 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365 } as Record<string, number>)[r] || 30;
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [reportData, alertData, metricsData] = await Promise.all([
        api.getTradeReport(range),
        api.getTradeAlerts(),
        api.getPerformanceMetrics(scope, daysForRange(range)).catch(() => null)
      ]);
      setReport(reportData);
      setAlerts(alertData);
      setMetrics(metricsData);
    } catch (err: any) {
      setError(err.message || 'Failed to load trade intelligence');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [range, scope]);

  const summary = report?.summary;
  const netTone = (summary?.totalPnl ?? 0) >= 0 ? 'green' : 'red';
  const topAlerts = useMemo(() => alerts?.alerts.slice(0, 8) || [], [alerts]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:w-[95%] sm:px-0">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">Trade Intelligence</h2>
              <Badge variant="outline" className="gap-1">
                <BarChart3 className="h-3 w-3" />
                Outcomes and alerts
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">Review why trades worked, failed, or were skipped across the selected window.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={scope} onValueChange={(value) => setScope(value as 'paper' | 'live')}>
            <SelectTrigger className="w-full sm:w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="w-full sm:w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" className="h-11 gap-2 sm:h-10" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label="Closed trades" value={String(summary?.total ?? 0)} detail={`${summary?.wins ?? 0} wins / ${summary?.losses ?? 0} losses`} />
        <MetricTile label="Net P&L" value={currency(summary?.totalPnl ?? 0)} tone={netTone} detail={`Avg ${currency(summary?.averagePnl ?? 0)}`} />
        <MetricTile label="Win rate" value={`${summary?.winRate ?? 0}%`} detail={`Profit factor ${summary?.profitFactor ?? '-'}`} />
        <MetricTile label="Open alerts" value={String(alerts?.summary.total ?? 0)} tone={(alerts?.summary.critical ?? 0) > 0 ? 'red' : (alerts?.summary.warning ?? 0) > 0 ? 'amber' : undefined} detail={`${alerts?.summary.critical ?? 0} critical / ${alerts?.summary.warning ?? 0} warning`} />
      </div>

      {metrics && metrics.overall.trades > 0 && (
        <div className="mt-4 overflow-hidden rounded-md border border-border bg-card">
          <SectionHeader icon={BarChart3} title="Edge Analytics" detail={`${scope === 'paper' ? 'Paper' : 'Live'} · last ${metrics.days}d · ${metrics.overall.trades} closed`} />
          <div className="grid gap-3 p-3 sm:p-4 md:grid-cols-3">
            <MetricTile
              label="Expectancy / trade"
              value={currency(metrics.overall.expectancy)}
              tone={metrics.overall.expectancy >= 0 ? 'green' : 'red'}
              detail={`Win ${(metrics.overall.winRate * 100).toFixed(0)}% · PF ${metrics.overall.profitFactor == null ? '-' : metrics.overall.profitFactor.toFixed(2)}`}
            />
            <MetricTile
              label="Avg win / avg loss"
              value={`${currency(metrics.overall.avgWin)} / ${currency(metrics.overall.avgLoss)}`}
              detail={`${metrics.overall.wins}W / ${metrics.overall.losses}L`}
            />
            {metrics.slippage ? (
              <MetricTile
                label="Entry slippage vs mid"
                value={currency(metrics.slippage.avgVsMid)}
                tone={metrics.slippage.avgVsMid > 0 ? 'red' : 'green'}
                detail={`${metrics.slippage.fills} fills · vs limit ${currency(metrics.slippage.avgVsLimit)}`}
              />
            ) : (
              <MetricTile label="Entry slippage" value="-" detail="Paper scope only" />
            )}
          </div>
          {(metrics.byStrategy || []).length > 0 && (
            <div className="border-t border-border p-3 sm:p-4">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Performance by strategy</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-3 font-medium">Strategy</th>
                      <th className="py-1 pr-3 font-medium">Trades</th>
                      <th className="py-1 pr-3 font-medium">Win %</th>
                      <th className="py-1 pr-3 font-medium">Total P&L</th>
                      <th className="py-1 pr-3 font-medium">Avg / trade</th>
                      <th className="py-1 font-medium text-muted-foreground" title="Frozen 90-session out-of-sample benchmark (Apr 14 - Aug 20). Fixed reference; does not update.">Benchmark avg (n)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.byStrategy.map((row) => (
                      <tr key={row.strategy} className="border-t border-border/50">
                        <td className="py-1.5 pr-3 font-medium">{row.strategy.replace(/_/g, ' ')}</td>
                        <td className="py-1.5 pr-3">{row.trades}</td>
                        <td className="py-1.5 pr-3">{(row.winRate * 100).toFixed(0)}%</td>
                        <td className={`py-1.5 pr-3 font-semibold ${row.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                          {currency(row.totalPnl)}
                        </td>
                        <td className={`pr-3 ${row.avgPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                          {currency(row.avgPnl)}
                        </td>
                        <td className="text-muted-foreground">
                          {BENCHMARK_BY_STRATEGY[row.strategy]
                            ? `${currency(BENCHMARK_BY_STRATEGY[row.strategy].avgPnl)} (${BENCHMARK_BY_STRATEGY[row.strategy].trades})`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {metrics.byHour.length > 0 && (
            <div className="border-t border-border p-3 sm:p-4">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Performance by ET hour</div>
              <div className="flex flex-wrap gap-2">
                {metrics.byHour.map((h) => (
                  <div
                    key={h.hourEt}
                    className={`rounded-md border px-2.5 py-1.5 text-xs ${h.totalPnl >= 0 ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-red-500/30 bg-red-500/10'}`}
                    title={`${h.trades} trades, ${(h.winRate * 100).toFixed(0)}% win`}
                  >
                    <span className="font-semibold">{String(h.hourEt).padStart(2, '0')}:00</span>{' '}
                    <span className="text-muted-foreground">{currency(h.totalPnl)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-md border border-border bg-card">
            <SectionHeader icon={BarChart3} title="Outcome Drivers" detail={report ? `Updated ${compactDate(report.generatedAt)}` : undefined} />
            <div className="grid grid-cols-2 gap-3 p-3 sm:p-4 lg:grid-cols-4">
              <MetricTile label="Take profit exits" value={String(summary?.takeProfitExits ?? 0)} tone="green" />
              <MetricTile label="Stop-loss exits" value={String(summary?.stopLossExits ?? 0)} tone="red" />
              <MetricTile label="Superseded exits" value={String(summary?.supersededExits ?? 0)} />
              <MetricTile label="Trimmed winners" value={String(summary?.trimmedTrades ?? 0)} tone="green" />
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-card">
            <SectionHeader icon={TrendingUp} title="Symbol Performance" />
            <div className="divide-y divide-border sm:hidden">
              {(report?.bySymbol || []).length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">No closed trades in this range.</div>
              ) : report!.bySymbol.map((row) => (
                <div key={`mobile-${row.symbol}`} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div><div className="font-semibold">{row.symbol}</div><div className="text-xs text-muted-foreground">{row.total} trades · {row.winRate}% win rate</div></div>
                    <div className={`font-mono font-semibold ${row.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(row.totalPnl)}</div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">Average P&amp;L <span className={`font-mono ${row.averagePnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(row.averagePnl)}</span></div>
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left">Symbol</th>
                    <th className="px-4 py-2 text-right">Trades</th>
                    <th className="px-4 py-2 text-right">Win rate</th>
                    <th className="px-4 py-2 text-right">Avg P&L</th>
                    <th className="px-4 py-2 text-right">Net P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {(report?.bySymbol || []).length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No closed trades in this range.</td></tr>
                  ) : report!.bySymbol.map((row) => (
                    <tr key={row.symbol} className="border-t border-border">
                      <td className="px-4 py-2 font-semibold">{row.symbol}</td>
                      <td className="px-4 py-2 text-right font-mono">{row.total}</td>
                      <td className="px-4 py-2 text-right font-mono">{row.winRate}%</td>
                      <td className={`px-4 py-2 text-right font-mono ${row.averagePnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(row.averagePnl)}</td>
                      <td className={`px-4 py-2 text-right font-mono ${row.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(row.totalPnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-card">
            <SectionHeader icon={TrendingDown} title="Recent Closed Trade Review" />
            <div className="divide-y divide-border sm:hidden">
              {(report?.recentOutcomes || []).length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">No closed trade outcomes to review.</div>
              ) : report!.recentOutcomes.map((trade) => (
                <article key={`mobile-${trade.id}`} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><Link to={`/trades/${trade.id}/command`} className="font-semibold">{contractLabel(trade)}</Link><div className="mt-1 text-xs text-muted-foreground">{trade.outcomeDriver}</div></div>
                    <div className={`shrink-0 font-mono font-semibold ${(trade.realized_pnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(trade.realized_pnl)}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-xs">
                    <div><div className="text-muted-foreground">Entry</div><div className="font-mono">{currency(trade.entry_price)}</div></div>
                    <div><div className="text-muted-foreground">Exit</div><div className="font-mono">{currency(trade.exit_price)}</div></div>
                    <div><div className="text-muted-foreground">Closed</div><div>{compactDate(trade.updated_at)}</div></div>
                  </div>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left">Contract</th>
                    <th className="px-4 py-2 text-right">Entry</th>
                    <th className="px-4 py-2 text-right">Exit</th>
                    <th className="px-4 py-2 text-right">P&L</th>
                    <th className="px-4 py-2 text-left">Driver</th>
                    <th className="px-4 py-2 text-left">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {(report?.recentOutcomes || []).length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No closed trade outcomes to review.</td></tr>
                  ) : report!.recentOutcomes.map((trade) => (
                    <tr key={trade.id} className="border-t border-border">
                      <td className="px-4 py-2">
                        <Link to={`/trades/${trade.id}/command`} className="font-semibold hover:underline">{contractLabel(trade)}</Link>
                        <div className="text-xs text-muted-foreground">{trade.exit_reason || trade.execution_status || 'Closed'}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{currency(trade.entry_price)}</td>
                      <td className="px-4 py-2 text-right font-mono">{currency(trade.exit_price)}</td>
                      <td className={`px-4 py-2 text-right font-mono ${(trade.realized_pnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(trade.realized_pnl)}</td>
                      <td className="px-4 py-2">{trade.outcomeDriver}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{compactDate(trade.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-md border border-border bg-card">
            <SectionHeader icon={Bell} title="Lifecycle Alerts" detail={alerts ? `Updated ${compactDate(alerts.generatedAt)}` : undefined} />
            <div className="divide-y divide-border">
              {topAlerts.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">No skipped-entry, stale-exit, or broker freshness alerts.</div>
              ) : topAlerts.map((alert) => (
                <div key={alert.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={alertTone(alert.severity)}>{alert.severity}</Badge>
                        <span className="text-sm font-semibold">{alert.title}</span>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{alert.message}</p>
                      <div className="mt-2 text-xs text-muted-foreground">{compactDate(alert.createdAt)}</div>
                    </div>
                    {alert.tradeId && (
                      <Button asChild variant="outline" size="sm">
                        <Link to={`/trades/${alert.tradeId}/command`}>Review</Link>
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-card">
            <SectionHeader icon={ShieldAlert} title="Skipped Entry Review" />
            <div className="divide-y divide-border">
              {(report?.skippedExecutions || []).length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">No skipped executions in this range.</div>
              ) : report!.skippedExecutions.slice(0, 12).map((item) => (
                <div key={`${item.signal_id}-${item.updated_at}`} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-sm font-semibold">{item.symbol || 'Signal'} #{item.signal_id}</div>
                    <Badge variant="outline">{item.setup_grade || 'N/A'}</Badge>
                  </div>
                  <div className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{item.execution_error || item.no_trade_reasons?.join(', ') || 'Skipped by execution filters'}</span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">{compactDate(item.updated_at)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
