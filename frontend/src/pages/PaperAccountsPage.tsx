import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, WalletCards } from 'lucide-react';
import { api, PaperAccountSummary } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type StrategyFilter = 'ALL' | 'DAY_TRADING' | 'WALL_REACTION';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const strategyLabel = (value: unknown) => String(value) === 'WALL_REACTION' ? 'Wall Reaction' : 'Day Trading';

function StrategyBadge({ strategy }: { strategy: unknown }) {
  const wall = strategy === 'WALL_REACTION';
  return <Badge variant="outline" className={wall ? 'border-sky-500/40 text-sky-600 dark:text-sky-300' : 'border-violet-500/40 text-violet-600 dark:text-violet-300'}>{strategyLabel(strategy)}</Badge>;
}

export default function PaperAccountsPage() {
  const [summary, setSummary] = useState<PaperAccountSummary | null>(null);
  const [filter, setFilter] = useState<StrategyFilter>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      setSummary(await api.getPaperAccount());
      setError(null);
    } catch (cause: any) {
      setError(cause.message || 'Shared paper account is unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const matches = useCallback((record: Record<string, any>) => filter === 'ALL' || record.strategy_name === filter || record.paper_strategy === filter, [filter]);
  const positions = useMemo(() => (summary?.openPositions || []).filter(matches), [summary, matches]);
  const orders = useMemo(() => (summary?.recentOrders || []).filter(matches), [summary, matches]);
  const events = useMemo(() => (summary?.journal || []).filter(matches), [summary, matches]);
  const availableCash = summary ? Number(summary.account.cash_balance) - Number(summary.account.reserved_cash) : 0;

  return (
    <main className="mx-auto w-full max-w-[1440px] space-y-5 px-3 py-4 sm:px-0 sm:py-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><WalletCards className="h-5 w-5 text-primary" /><h1 className="text-2xl font-semibold">Shared Paper Account</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">One $100,000 simulated cash balance for Day Trading and Wall Reaction. Every record remains strategy-labelled.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>
      </header>

      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="pt-5"><div className="text-xs text-muted-foreground">Equity</div><div className="mt-1 text-xl font-semibold tabular-nums">{summary ? money.format(Number(summary.account.equity)) : '—'}</div></CardContent></Card>
        <Card><CardContent className="pt-5"><div className="text-xs text-muted-foreground">Available cash</div><div className="mt-1 text-xl font-semibold tabular-nums">{summary ? money.format(availableCash) : '—'}</div></CardContent></Card>
        <Card><CardContent className="pt-5"><div className="text-xs text-muted-foreground">Reserved for entries</div><div className="mt-1 text-xl font-semibold tabular-nums">{summary ? money.format(Number(summary.account.reserved_cash)) : '—'}</div></CardContent></Card>
        <Card><CardContent className="pt-5"><div className="text-xs text-muted-foreground">Open positions</div><div className="mt-1 text-xl font-semibold tabular-nums">{summary?.openPositions.length ?? '—'}</div></CardContent></Card>
      </section>

      <section className="flex flex-wrap items-center gap-2 border-y py-3">
        <span className="mr-1 text-sm font-medium">Show</span>
        {(['ALL', 'DAY_TRADING', 'WALL_REACTION'] as StrategyFilter[]).map((value) => (
          <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>{value === 'ALL' ? 'All strategies' : strategyLabel(value)}</Button>
        ))}
        {summary?.strategyControls.map((control) => <Badge key={control.strategy_name} variant="secondary">{strategyLabel(control.strategy_name)} entries {control.automation_status.toLowerCase()}</Badge>)}
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">Open positions</CardTitle></CardHeader>
        <CardContent>{positions.length === 0 ? <p className="text-sm text-muted-foreground">No open positions for this filter.</p> : <div className="space-y-2">{positions.map((position) => {
          const pnl = (Number(position.current_price) - Number(position.entry_price)) * Number(position.quantity) * 100;
          return <div key={position.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"><div><div className="flex flex-wrap items-center gap-2 font-medium"><span>{position.symbol} {position.option_type} {Number(position.strike_price).toFixed(0)}</span><StrategyBadge strategy={position.paper_strategy || (position as any).strategy_name} /></div><div className="mt-1 text-xs text-muted-foreground">{position.quantity} contract{Number(position.quantity) === 1 ? '' : 's'} · {String(position.expiration_date).slice(0, 10)} · entry {money.format(Number(position.entry_price))}</div></div><div className={`font-mono font-semibold ${pnl >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}`}>{pnl >= 0 ? '+' : ''}{money.format(pnl)}</div></div>;
        })}</div>}</CardContent>
      </Card>

      <section className="grid gap-5 xl:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">Orders</CardTitle></CardHeader><CardContent className="space-y-2">{orders.slice(0, 20).map((order) => <div key={order.id} className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm"><div><div className="flex flex-wrap items-center gap-2 font-medium"><span>{order.intent.replaceAll('_', ' ')} · {order.osi_ticker}</span><StrategyBadge strategy={(order as any).strategy_name} /></div><div className="mt-1 text-xs text-muted-foreground">{order.status} · {order.quantity} contract{Number(order.quantity) === 1 ? '' : 's'} · {new Date(order.filled_at || order.created_at).toLocaleString()}</div></div><span className="font-mono">{order.fill_price ? money.format(Number(order.fill_price)) : '—'}</span></div>)}{orders.length === 0 && <p className="text-sm text-muted-foreground">No orders for this filter.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />Transaction events</CardTitle></CardHeader><CardContent className="space-y-2">{events.slice(0, 20).map((event) => <div key={event.id} className="rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center gap-2 font-medium"><span>{event.event_type.replaceAll('_', ' ')}</span><StrategyBadge strategy={(event as any).strategy_name} /></div><p className="mt-1 text-xs text-muted-foreground">{event.message}</p><time className="mt-1 block text-[11px] text-muted-foreground">{new Date(event.created_at).toLocaleString()}</time></div>)}{events.length === 0 && <p className="text-sm text-muted-foreground">No events for this filter.</p>}</CardContent></Card>
      </section>
    </main>
  );
}
