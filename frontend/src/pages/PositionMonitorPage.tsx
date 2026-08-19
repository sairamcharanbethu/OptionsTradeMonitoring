import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, RefreshCw, Target } from 'lucide-react';
import { api, PositionMonitorRow, KillSwitchResponse } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : num.format(value));
const opSymbol = (op: 'ge' | 'le') => (op === 'ge' ? '≥' : '≤');

export default function PositionMonitorPage() {
  const [rows, setRows] = useState<PositionMonitorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // positionId -> timestamp of most recent POSITION_TARGET_HIT (drives the flash highlight)
  const [flashes, setFlashes] = useState<Record<number, number>>({});
  const [killSwitch, setKillSwitch] = useState<KillSwitchResponse | null>(null);
  const { lastMessage } = useWebSocket();

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const [monitorRows, ks] = await Promise.all([
        api.getPositionMonitor(),
        api.getKillSwitch().catch(() => null)
      ]);
      setRows(monitorRows);
      setKillSwitch(ks);
      setError(null);
    } catch (cause: any) {
      setError(cause?.message || 'Position monitor is unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // React to live take-profit hits: highlight the row and refresh immediately.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (lastMessage?.type !== 'POSITION_TARGET_HIT') return;
    const positionId = Number(lastMessage.data?.positionId);
    if (!Number.isFinite(positionId)) return;
    setFlashes((prev) => ({ ...prev, [positionId]: Date.now() }));
    void loadRef.current();
  }, [lastMessage]);

  const sorted = useMemo(() => {
    // Hit targets first, then closest-to-target, then the rest.
    return [...rows].sort((a, b) => {
      if (a.hit !== b.hit) return a.hit ? -1 : 1;
      const da = a.distancePct == null ? Infinity : Math.abs(a.distancePct);
      const db = b.distancePct == null ? Infinity : Math.abs(b.distancePct);
      return da - db;
    });
  }, [rows]);

  const withTargets = sorted.filter((row) => row.target != null);
  const withoutTargets = sorted.filter((row) => row.target == null);
  const hitCount = rows.filter((row) => row.hit).length;

  return (
    <main className="mx-auto w-full max-w-[1440px] space-y-5 px-3 py-4 sm:px-0 sm:py-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><Target className="h-5 w-5 text-primary" /><h1 className="text-2xl font-semibold">Position Monitor</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">
            Watches each open position's underlying spot against its take-profit target. Alerts fire once per position — in-app here and via Discord.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </header>

      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {killSwitch && (killSwitch.live.halted || killSwitch.paper.halted) && (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-semibold text-destructive">
            🛑 Daily-loss kill-switch active — new entries halted
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {killSwitch.live.halted && <li>Live: realized {killSwitch.live.dayRealizedPnl.toFixed(2)} ≤ −{killSwitch.live.limit.toFixed(2)} today.</li>}
            {killSwitch.paper.halted && <li>Paper: realized {killSwitch.paper.dayRealizedPnl.toFixed(2)} ≤ −{killSwitch.paper.limit.toFixed(2)} today.</li>}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Take-profit targets</CardTitle>
          <Badge variant="outline" className={hitCount > 0 ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'}>
            {hitCount} hit · {withTargets.length} watched
          </Badge>
        </CardHeader>
        <CardContent>
          {withTargets.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No open positions with a take-profit target. Targets come from each position's analyzed take-profit level.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Position</th>
                    <th className="py-2 pr-3 font-medium">Qty</th>
                    <th className="py-2 pr-3 font-medium text-right">Spot</th>
                    <th className="py-2 pr-3 font-medium text-right">Target</th>
                    <th className="py-2 pr-3 font-medium text-right">Distance</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {withTargets.map((row) => {
                    const flashed = flashes[row.positionId] && Date.now() - flashes[row.positionId] < 15_000;
                    return (
                      <tr
                        key={row.positionId}
                        className={`border-b border-border/60 transition-colors ${row.hit ? 'bg-emerald-500/10' : flashed ? 'bg-amber-500/10' : ''}`}
                      >
                        <td className="py-2 pr-3">
                          <span className="font-medium">{row.symbol}</span>{' '}
                          <span className="text-muted-foreground">{row.optionType} {fmt(row.strike)}</span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{row.quantity}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmt(row.underlyingPrice)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{opSymbol(row.op)} {fmt(row.target)}</td>
                        <td className={`py-2 pr-3 text-right tabular-nums ${row.distancePct != null && Math.abs(row.distancePct) < 0.5 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                          {row.distancePct == null ? '—' : `${row.distancePct > 0 ? '+' : ''}${row.distancePct.toFixed(2)}%`}
                        </td>
                        <td className="py-2 pr-3">
                          {row.hit ? (
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-300">
                              <Crosshair className="mr-1 h-3 w-3" />Target hit
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">Waiting</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {withoutTargets.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {withoutTargets.length} open position{withoutTargets.length === 1 ? '' : 's'} without an analyzed take-profit target {withoutTargets.length === 1 ? 'is' : 'are'} not monitored.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
