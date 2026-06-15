import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeDollarSign, CalendarDays, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, ClosedTradesResponse, Position } from '../lib/api';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';

const currency = (value?: number | null) => {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return `$${Number(value).toFixed(2)}`;
};

const compactDate = (value?: string) => {
  if (!value) return '-';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const contractLabel = (trade: Position) => {
  const expiry = String(trade.expiration_date || '').split('T')[0];
  return `${trade.symbol} ${Number(trade.strike_price).toFixed(0)}${trade.option_type === 'CALL' ? 'C' : 'P'} ${expiry}`;
};

const livePnl = (trade: Position) => {
  const current = Number(trade.current_price || trade.entry_price || 0);
  const entry = Number(trade.entry_price || 0);
  return (current - entry) * Number(trade.quantity || 1) * 100;
};

function SummaryTile({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/80 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${tone === 'green' ? 'text-emerald-500' : tone === 'red' ? 'text-red-500' : ''}`}>
        {value}
      </div>
    </div>
  );
}

export default function TradesPage() {
  const [openTrades, setOpenTrades] = useState<Position[]>([]);
  const [closedData, setClosedData] = useState<ClosedTradesResponse | null>(null);
  const [loadingOpen, setLoadingOpen] = useState(true);
  const [loadingClosed, setLoadingClosed] = useState(true);
  const [closingTrade, setClosingTrade] = useState<Position | null>(null);
  const [submittingClose, setSubmittingClose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    symbol: '',
    result: 'all' as 'all' | 'win' | 'loss',
  });

  const refreshOpen = async () => {
    setError(null);
    const trades = await api.getOpenTrades();
    setOpenTrades(trades);
    setLoadingOpen(false);
  };

  const refreshClosed = async () => {
    setError(null);
    const data = await api.getClosedTrades({
      ...filters,
      symbol: filters.symbol.trim().toUpperCase(),
      limit: 50
    });
    setClosedData(data);
    setLoadingClosed(false);
  };

  useEffect(() => {
    refreshOpen().catch((err) => {
      setError(err.message);
      setLoadingOpen(false);
    });
    const timer = window.setInterval(() => {
      refreshOpen().catch((err) => setError(err.message));
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshClosed().catch((err) => {
      setError(err.message);
      setLoadingClosed(false);
    });
  }, [filters.result]);

  const openSummary = useMemo(() => {
    const totalPnl = openTrades.reduce((sum, trade) => sum + livePnl(trade), 0);
    const pendingExits = openTrades.filter((trade) => trade.execution_status === 'PENDING_EXIT').length;
    const openCount = openTrades.filter((trade) => trade.status === 'OPEN').length;
    return { totalPnl, pendingExits, openCount };
  }, [openTrades]);

  const submitClose = async () => {
    if (!closingTrade) return;
    setSubmittingClose(true);
    setError(null);
    try {
      await api.closeWealthsimpleTrade(closingTrade.id, closingTrade.quantity);
      setClosingTrade(null);
      await refreshOpen();
    } catch (err: any) {
      setError(err.message || 'Failed to close trade');
    } finally {
      setSubmittingClose(false);
    }
  };

  return (
    <div className="mx-auto w-[95%] max-w-[1600px] py-4">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="rounded-full">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">Wealthsimple Trades</h2>
              <Badge variant="outline" className="gap-1">
                <ShieldCheck className="h-3 w-3" />
                SnapTrade only
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">Alpaca is used only for live option pricing and stream updates.</p>
          </div>
        </div>
        <Button variant="outline" className="gap-2" onClick={() => { refreshOpen(); refreshClosed(); }}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <Tabs defaultValue="open" className="space-y-4">
        <TabsList>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryTile label="Open Trades" value={String(openSummary.openCount)} />
            <SummaryTile label="Live P&L" value={currency(openSummary.totalPnl)} tone={openSummary.totalPnl >= 0 ? 'green' : 'red'} />
            <SummaryTile label="Pending Exits" value={String(openSummary.pendingExits)} />
          </div>

          <div className="overflow-hidden rounded-md border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1050px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 text-left">Contract</th>
                    <th className="px-3 py-3 text-right">Qty</th>
                    <th className="px-3 py-3 text-right">Entry</th>
                    <th className="px-3 py-3 text-right">Live</th>
                    <th className="px-3 py-3 text-right">P&L</th>
                    <th className="px-3 py-3 text-right">SL</th>
                    <th className="px-3 py-3 text-right">TP</th>
                    <th className="px-3 py-3 text-right">Underlying</th>
                    <th className="px-3 py-3 text-left">State</th>
                    <th className="px-3 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingOpen ? (
                    <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">Loading Wealthsimple trades...</td></tr>
                  ) : openTrades.length === 0 ? (
                    <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">No open Wealthsimple trades.</td></tr>
                  ) : openTrades.map((trade) => {
                    const pnl = livePnl(trade);
                    const closeDisabled = trade.status !== 'OPEN' || trade.execution_status === 'PENDING_EXIT';
                    return (
                      <tr key={trade.id} className="border-t border-border/70">
                        <td className="px-3 py-3">
                          <div className="font-medium">{contractLabel(trade)}</div>
                          <div className="text-xs text-muted-foreground">{trade.broker_order_id || '-'}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-mono">{trade.quantity}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.entry_price)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.current_price)}</td>
                        <td className={`px-3 py-3 text-right font-mono font-semibold ${pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(pnl)}</td>
                        <td className="px-3 py-3 text-right font-mono text-red-500">{currency(trade.stop_loss_trigger)}</td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-500">{currency(trade.take_profit_trigger)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.underlying_price)}</td>
                        <td className="px-3 py-3">
                          <Badge variant={trade.execution_status === 'EXIT_FAILED' ? 'destructive' : 'outline'}>
                            {trade.execution_status || trade.status}
                          </Badge>
                          {trade.execution_error && <div className="mt-1 max-w-[220px] truncate text-xs text-red-500">{trade.execution_error}</div>}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Button size="sm" variant="destructive" disabled={closeDisabled} onClick={() => setClosingTrade(trade)}>
                            Close
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="closed" className="space-y-4">
          <div className="grid gap-3 md:grid-cols-5">
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Symbol</Label>
              <Input value={filters.symbol} onChange={(e) => setFilters({ ...filters, symbol: e.target.value.toUpperCase() })} placeholder="QQQ" />
            </div>
            <div>
              <Label className="text-xs">Result</Label>
              <Select value={filters.result} onValueChange={(value: 'all' | 'win' | 'loss') => setFilters({ ...filters, result: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="win">Wins</SelectItem>
                  <SelectItem value="loss">Losses</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button className="w-full gap-2" onClick={refreshClosed}>
                <Search className="h-4 w-4" />
                Apply
              </Button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <SummaryTile label="Realized P&L" value={currency(closedData?.summary.totalPnl || 0)} tone={(closedData?.summary.totalPnl || 0) >= 0 ? 'green' : 'red'} />
            <SummaryTile label="Closed Trades" value={String(closedData?.summary.total || 0)} />
            <SummaryTile label="Win Rate" value={`${closedData?.summary.winRate || 0}%`} />
            <SummaryTile label="Average P&L" value={currency(closedData?.summary.averagePnl || 0)} />
          </div>

          <div className="overflow-hidden rounded-md border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 text-left">Closed</th>
                    <th className="px-3 py-3 text-left">Contract</th>
                    <th className="px-3 py-3 text-right">Qty</th>
                    <th className="px-3 py-3 text-right">Entry</th>
                    <th className="px-3 py-3 text-right">Exit</th>
                    <th className="px-3 py-3 text-right">P&L</th>
                    <th className="px-3 py-3 text-left">Reason</th>
                    <th className="px-3 py-3 text-left">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingClosed ? (
                    <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">Loading closed trades...</td></tr>
                  ) : !closedData || closedData.trades.length === 0 ? (
                    <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No closed Wealthsimple trades match the filters.</td></tr>
                  ) : closedData.trades.map((trade) => (
                    <tr key={trade.id} className="border-t border-border/70">
                      <td className="px-3 py-3 text-muted-foreground">{compactDate(trade.updated_at)}</td>
                      <td className="px-3 py-3 font-medium">{contractLabel(trade)}</td>
                      <td className="px-3 py-3 text-right font-mono">{trade.quantity}</td>
                      <td className="px-3 py-3 text-right font-mono">{currency(trade.entry_price)}</td>
                      <td className="px-3 py-3 text-right font-mono">{currency(trade.exit_price || trade.current_price)}</td>
                      <td className={`px-3 py-3 text-right font-mono font-semibold ${(trade.realized_pnl || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(trade.realized_pnl)}</td>
                      <td className="px-3 py-3">
                        <Badge variant="outline">{trade.exit_reason || trade.execution_status || 'CLOSED'}</Badge>
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{trade.broker_exit_order_id || trade.broker_order_id || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!closingTrade} onOpenChange={(open) => !open && setClosingTrade(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              Close Wealthsimple Trade
            </DialogTitle>
            <DialogDescription>
              This submits a live MARKET SELL_TO_CLOSE through SnapTrade. The trade stays open as PENDING_EXIT until Wealthsimple confirms the fill.
            </DialogDescription>
          </DialogHeader>
          {closingTrade && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Contract</span>
                <span className="font-medium">{contractLabel(closingTrade)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-muted-foreground">Quantity</span>
                <span className="font-mono">{closingTrade.quantity}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-muted-foreground">Last app price</span>
                <span className="font-mono">{currency(closingTrade.current_price)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingTrade(null)}>Cancel</Button>
            <Button variant="destructive" className="gap-2" onClick={submitClose} disabled={submittingClose}>
              {submittingClose ? <RefreshCw className="h-4 w-4 animate-spin" /> : <BadgeDollarSign className="h-4 w-4" />}
              Submit Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
