import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeDollarSign, Clock, ExternalLink, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, ClosedTradesResponse, Position } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
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

const takeProfitLabel = (trade: Position) => {
  if (trade.take_profit_trigger !== undefined && trade.take_profit_trigger !== null) {
    return currency(trade.take_profit_trigger);
  }
  return 'Suggested';
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

const trimPnl = (trade: Position) => {
  if (!trade.profit_trim_quantity || !trade.profit_trim_price) return 0;
  return (Number(trade.profit_trim_price) - Number(trade.entry_price || 0)) * Number(trade.profit_trim_quantity) * 100;
};

const dteLabel = (trade: Position) => {
  const expiry = String(trade.expiration_date || '').split('T')[0];
  if (!expiry) return '-';
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [year, month, day] = expiry.split('-').map(Number);
  const expiryUtc = Date.UTC(year, month - 1, day);
  const days = Math.ceil((expiryUtc - todayUtc) / 86400000);
  if (days < 0) return 'Expired';
  return `${days}DTE`;
};

const isWorkingOrder = (trade: Position) => {
  const status = String(trade.execution_status || '');
  return ['PENDING_EXIT', 'PENDING_TRIM'].includes(status) || status.startsWith('EXIT_');
};

const actionLabel = (trade: Position) => {
  const status = String(trade.execution_status || trade.status || '');
  if (status === 'PENDING_TRIM') return 'Trim pending';
  if (status === 'PENDING_EXIT') return 'Close pending';
  if (status === 'EXIT_STALE') return 'Verify broker';
  if (status === 'EXIT_REJECTED' || status === 'EXIT_FAILED') return 'Sync required';
  if (status.startsWith('EXIT_')) return 'Broker check';
  return 'Close';
};

const stateLabel = (trade: Position) => {
  const raw = String(trade.exit_reason || trade.execution_status || trade.status || 'OPEN');
  const labels: Record<string, string> = {
    PENDING_EXIT: 'Close pending',
    PENDING_TRIM: 'Trim pending',
    EXIT_STALE: 'Verify broker',
    EXIT_REJECTED: 'Exit rejected',
    EXIT_FAILED: 'Exit failed',
    STOP_LOSS: 'Stop loss',
    TAKE_PROFIT: 'Take profit',
    PROFIT_TRIM: 'Profit trim',
    MANUAL: 'Manual',
    BROKER_CONFIRMED: 'Broker confirmed',
    FILLED: 'Filled',
    CLOSED: 'Closed',
    OPEN: 'Open'
  };
  return labels[raw] || raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
};

const stateTone = (trade: Position): 'default' | 'destructive' | 'outline' | 'secondary' => {
  const status = String(trade.execution_status || '');
  if (status.includes('REJECTED') || status.includes('FAILED') || status === 'EXIT_STALE') return 'destructive';
  if (status === 'PENDING_EXIT' || status === 'PENDING_TRIM') return 'secondary';
  return 'outline';
};

const isBreakevenStop = (trade: Position) =>
  trade.profit_trim_status === 'DONE'
  && trade.stop_loss_trigger !== undefined
  && Number(trade.stop_loss_trigger) >= Number(trade.entry_price);

const activeOrderId = (trade: Position) =>
  trade.broker_exit_order_id || trade.profit_trim_order_id || trade.broker_order_id || '-';

const canRetryClose = (trade: Position) =>
  ['EXIT_REJECTED', 'EXIT_FAILED', 'EXIT_CANCELED', 'EXIT_CANCELLED', 'EXIT_EXPIRED', 'EXIT_STALE'].includes(String(trade.execution_status || ''))
  && trade.status === 'OPEN'
  && !!trade.broker_exit_order_id;

type ClosedTradeRange = 'today' | 'past-day' | 'past-week' | 'past-month' | 'past-6-months' | 'past-year' | 'ytd';

const CLOSED_TRADE_RANGES: Array<{ value: ClosedTradeRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'past-day', label: 'Past day' },
  { value: 'past-week', label: 'Past 1 week' },
  { value: 'past-month', label: 'Past month' },
  { value: 'past-6-months', label: 'Past 6 months' },
  { value: 'past-year', label: 'Past 1 year' },
  { value: 'ytd', label: 'YTD' },
];

const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const closedTradeDateRange = (range: ClosedTradeRange) => {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (range === 'past-day') from.setDate(from.getDate() - 1);
  if (range === 'past-week') from.setDate(from.getDate() - 7);
  if (range === 'past-month') from.setMonth(from.getMonth() - 1);
  if (range === 'past-6-months') from.setMonth(from.getMonth() - 6);
  if (range === 'past-year') from.setFullYear(from.getFullYear() - 1);
  if (range === 'ytd') from.setMonth(0, 1);

  return {
    from: formatLocalDate(from),
    to: formatLocalDate(today),
  };
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
  const { lastMessage } = useWebSocket();
  const [openTrades, setOpenTrades] = useState<Position[]>([]);
  const [closedData, setClosedData] = useState<ClosedTradesResponse | null>(null);
  const [loadingOpen, setLoadingOpen] = useState(true);
  const [loadingClosed, setLoadingClosed] = useState(true);
  const [closingTrade, setClosingTrade] = useState<Position | null>(null);
  const [submittingClose, setSubmittingClose] = useState(false);
  const [syncingOrders, setSyncingOrders] = useState(false);
  const [syncingTradeId, setSyncingTradeId] = useState<number | null>(null);
  const [retryingTradeId, setRetryingTradeId] = useState<number | null>(null);
  const [brokerHealth, setBrokerHealth] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    range: 'today' as ClosedTradeRange,
    symbol: '',
    result: 'all' as 'all' | 'win' | 'loss',
  });

  const refreshOpen = async (syncPending = true) => {
    setError(null);
    if (syncPending) {
      setSyncingOrders(true);
      try {
        await api.syncSnaptradePendingOrders();
      } catch (err: any) {
        setError(err.message || 'Failed to sync Wealthsimple orders');
      } finally {
        setSyncingOrders(false);
      }
    }
    const trades = await api.getOpenTrades();
    setOpenTrades(trades);
    await loadBrokerHealth();
    setLoadingOpen(false);
  };

  const loadBrokerHealth = async () => {
    try {
      const health = await api.getServicesHealth();
      setBrokerHealth(health.snaptradePendingOrders || null);
    } catch {
      setBrokerHealth(null);
    }
  };

  const refreshClosed = async () => {
    setError(null);
    setLoadingClosed(true);
    const dateRange = closedTradeDateRange(filters.range);
    const data = await api.getClosedTrades({
      ...dateRange,
      symbol: filters.symbol.trim().toUpperCase(),
      result: filters.result,
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
      refreshOpen(false).catch((err) => setError(err.message));
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshClosed().catch((err) => {
      setError(err.message);
      setLoadingClosed(false);
    });
  }, [filters.range, filters.result]);

  useEffect(() => {
    if (lastMessage?.type !== 'TRADES_UPDATED') return;
    refreshOpen(false).catch((err) => setError(err.message));
  }, [lastMessage]);

  const openSummary = useMemo(() => {
    const activeTrades = openTrades.filter((trade) => trade.status === 'OPEN' && !isWorkingOrder(trade));
    const totalPnl = activeTrades.reduce((sum, trade) => sum + livePnl(trade), 0);
    const workingOrders = openTrades.filter(isWorkingOrder).length;
    return { totalPnl, workingOrders, openCount: activeTrades.length };
  }, [openTrades]);

  const workingOrders = useMemo(() => openTrades.filter(isWorkingOrder), [openTrades]);
  const activeOpenTrades = useMemo(() => openTrades.filter((trade) => !isWorkingOrder(trade)), [openTrades]);

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

  const syncTradeStatus = async (tradeId?: number) => {
    setSyncingTradeId(tradeId || null);
    if (!tradeId) setSyncingOrders(true);
    setError(null);
    try {
      if (tradeId) {
        const result = await api.refreshWealthsimpleTradeOrderStatus(tradeId);
        setOpenTrades((trades) => (
          result.trade.status === 'CLOSED'
            ? trades.filter((trade) => trade.id !== tradeId)
            : trades.map((trade) => trade.id === tradeId ? result.trade : trade)
        ));
        if (result.trade.status === 'CLOSED') refreshClosed().catch((err) => setError(err.message));
      } else {
        await api.syncSnaptradePendingOrders();
        await refreshOpen(false);
      }
      await loadBrokerHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to sync Wealthsimple order status');
    } finally {
      setSyncingTradeId(null);
      if (!tradeId) setSyncingOrders(false);
    }
  };

  const retryClose = async (trade: Position) => {
    setRetryingTradeId(trade.id);
    setError(null);
    try {
      const updated = await api.retryWealthsimpleClose(trade.id, trade.quantity);
      setOpenTrades((trades) => trades.map((item) => item.id === trade.id ? updated : item));
      await loadBrokerHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to retry Wealthsimple close');
    } finally {
      setRetryingTradeId(null);
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
          <RefreshCw className={`h-4 w-4 ${syncingOrders ? 'animate-spin' : ''}`} />
          {syncingOrders ? 'Syncing Orders' : 'Refresh'}
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
            <SummaryTile label="Working Orders" value={String(openSummary.workingOrders)} />
          </div>

          {brokerHealth && (
            <div className="grid gap-3 md:grid-cols-4">
              <SummaryTile label="Broker Sync" value={brokerHealth.status || 'N/A'} tone={brokerHealth.status === 'UP' ? 'green' : brokerHealth.status === 'DOWN' ? 'red' : undefined} />
              <SummaryTile label="Last Broker Check" value={brokerHealth.lastRunAt ? compactDate(brokerHealth.lastRunAt) : '-'} />
              <SummaryTile label="Pending Checked" value={String(brokerHealth.lastResult?.checked ?? 0)} />
              <SummaryTile label="Watchdog Stale Entries" value={String(brokerHealth.lastWatchdogResult?.entryStale ?? 0)} tone={(brokerHealth.lastWatchdogResult?.entryStale ?? 0) > 0 ? 'red' : undefined} />
              {brokerHealth.lastError && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500 md:col-span-4">
                  {brokerHealth.lastError}
                </div>
              )}
            </div>
          )}

          {workingOrders.length > 0 && (
            <div className="overflow-hidden rounded-md border border-amber-500/30 bg-amber-500/5">
              <div className="flex items-center justify-between border-b border-amber-500/20 px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-600">
                  <Clock className="h-4 w-4" />
                  Working Orders
                </div>
                <Button variant="outline" size="sm" className="h-7 gap-2" onClick={() => syncTradeStatus()} disabled={syncingOrders || syncingTradeId !== null}>
                  <RefreshCw className={`h-3.5 w-3.5 ${syncingOrders || syncingTradeId !== null ? 'animate-spin' : ''}`} />
                  Sync
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Contract</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Live</th>
                      <th className="px-3 py-2 text-left">Order State</th>
                      <th className="px-3 py-2 text-left">Exit Order</th>
                      <th className="px-3 py-2 text-left">Broker Check</th>
                      <th className="px-3 py-2 text-left">Requested</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workingOrders.map((trade) => (
                      <tr key={`working-${trade.id}`} className="border-t border-amber-500/10">
                        <td className="px-3 py-2">
                          <div className="font-medium">{contractLabel(trade)}</div>
                          <div className="text-xs text-muted-foreground">{dteLabel(trade)}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{trade.quantity}</td>
                        <td className="px-3 py-2 text-right font-mono">{currency(trade.current_price)}</td>
                        <td className="px-3 py-2">
                          <Badge variant={stateTone(trade)}>{stateLabel(trade)}</Badge>
                          {trade.execution_error && <div className="mt-1 max-w-[260px] truncate text-xs text-red-500">{trade.execution_error}</div>}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{activeOrderId(trade)}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          <div>{trade.last_broker_order_status || '-'}</div>
                          <div>{compactDate(trade.last_broker_sync_at)}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{compactDate(trade.exit_requested_at)}</td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" className="h-7 gap-2" onClick={() => syncTradeStatus(trade.id)} disabled={syncingTradeId === trade.id || retryingTradeId === trade.id}>
                              <RefreshCw className={`h-3.5 w-3.5 ${syncingTradeId === trade.id ? 'animate-spin' : ''}`} />
                              Refresh
                            </Button>
                            <Button asChild variant="outline" size="sm" className="h-7 gap-2">
                              <Link to={`/trades/${trade.id}/command`}>
                                <ExternalLink className="h-3.5 w-3.5" />
                                Command
                              </Link>
                            </Button>
                            {canRetryClose(trade) && (
                              <Button variant="destructive" size="sm" className="h-7 gap-2" onClick={() => retryClose(trade)} disabled={syncingTradeId === trade.id || retryingTradeId === trade.id}>
                                <BadgeDollarSign className={`h-3.5 w-3.5 ${retryingTradeId === trade.id ? 'animate-pulse' : ''}`} />
                                Retry {Number(trade.exit_retry_count || 0)}/2
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1220px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 text-left">Contract</th>
                    <th className="px-3 py-3 text-center">DTE</th>
                    <th className="px-3 py-3 text-right">Qty</th>
                    <th className="px-3 py-3 text-right">Entry</th>
                    <th className="px-3 py-3 text-right">Live</th>
                    <th className="px-3 py-3 text-right">P&L</th>
                    <th className="px-3 py-3 text-right">SL</th>
                    <th className="px-3 py-3 text-right">TP</th>
                    <th className="px-3 py-3 text-right">Underlying</th>
                    <th className="px-3 py-3 text-left">Order</th>
                    <th className="px-3 py-3 text-left">Broker Check</th>
                    <th className="px-3 py-3 text-left">State</th>
                    <th className="px-3 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingOpen ? (
                    <tr><td colSpan={13} className="px-3 py-8 text-center text-muted-foreground">Loading Wealthsimple trades...</td></tr>
                  ) : activeOpenTrades.length === 0 ? (
                    <tr><td colSpan={13} className="px-3 py-8 text-center text-muted-foreground">No active open Wealthsimple positions.</td></tr>
                  ) : activeOpenTrades.map((trade) => {
                    const pnl = livePnl(trade);
                    const realizedTrimPnl = trimPnl(trade);
                    const closeDisabled = trade.status !== 'OPEN'
                      || ['PENDING_EXIT', 'PENDING_TRIM'].includes(String(trade.execution_status || ''))
                      || String(trade.execution_status || '').startsWith('EXIT_');
                    return (
                      <tr key={trade.id} className="border-t border-border/70">
                        <td className="px-3 py-3">
                          <div className="font-medium">{contractLabel(trade)}</div>
                          <div className="text-xs text-muted-foreground">Entry {trade.broker_order_id || '-'}</div>
                        </td>
                        <td className="px-3 py-3 text-center"><Badge variant="outline">{dteLabel(trade)}</Badge></td>
                        <td className="px-3 py-3 text-right font-mono">{trade.quantity}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.entry_price)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.current_price)}</td>
                        <td className="px-3 py-3 text-right">
                          <div className={`font-mono font-semibold ${pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(pnl)}</div>
                          {realizedTrimPnl !== 0 && (
                            <div className="text-[11px] text-muted-foreground">Trim {currency(realizedTrimPnl)}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-red-500">{currency(trade.stop_loss_trigger)}</td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-500">{takeProfitLabel(trade)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.underlying_price)}</td>
                        <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{activeOrderId(trade)}</td>
                        <td className="px-3 py-3 text-xs text-muted-foreground">
                          {trade.last_broker_order_status && <div>Broker {trade.last_broker_order_status}</div>}
                          {trade.last_broker_sync_at && <div>{compactDate(trade.last_broker_sync_at)}</div>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant={stateTone(trade)}>{stateLabel(trade)}</Badge>
                            {trade.profit_trim_status === 'DONE' && <Badge variant="secondary">Trim done</Badge>}
                            {isBreakevenStop(trade) && <Badge variant="outline">Breakeven stop</Badge>}
                            {trade.take_profit_trigger && <Badge variant="outline">TP live</Badge>}
                          </div>
                          {trade.execution_error && <div className="mt-1 max-w-[220px] truncate text-xs text-red-500">{trade.execution_error}</div>}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button asChild size="sm" variant="outline" className="gap-2">
                              <Link to={`/trades/${trade.id}/command`}>
                                <ExternalLink className="h-3.5 w-3.5" />
                                Command
                              </Link>
                            </Button>
                            <Button size="sm" variant="destructive" disabled={closeDisabled} onClick={() => setClosingTrade(trade)}>
                              {actionLabel(trade)}
                            </Button>
                          </div>
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
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <Label className="text-xs">Range</Label>
              <Select value={filters.range} onValueChange={(value: ClosedTradeRange) => setFilters({ ...filters, range: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLOSED_TRADE_RANGES.map((range) => (
                    <SelectItem key={range.value} value={range.value}>{range.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                    <th className="px-3 py-3 text-center">DTE</th>
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
                    <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Loading closed trades...</td></tr>
                  ) : !closedData || closedData.trades.length === 0 ? (
                    <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">No closed Wealthsimple trades match the filters.</td></tr>
                  ) : closedData.trades.map((trade) => {
                    const realizedTrimPnl = trimPnl(trade);
                    return (
                      <tr key={trade.id} className="border-t border-border/70">
                        <td className="px-3 py-3 text-muted-foreground">{compactDate(trade.updated_at)}</td>
                        <td className="px-3 py-3 font-medium">{contractLabel(trade)}</td>
                        <td className="px-3 py-3 text-center"><Badge variant="outline">{dteLabel(trade)}</Badge></td>
                        <td className="px-3 py-3 text-right font-mono">{trade.quantity}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.entry_price)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.exit_price || trade.current_price)}</td>
                        <td className={`px-3 py-3 text-right font-mono font-semibold ${(trade.realized_pnl || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                          <div>{currency(trade.realized_pnl)}</div>
                          {realizedTrimPnl !== 0 && <div className="text-[11px] font-normal text-muted-foreground">Trim {currency(realizedTrimPnl)}</div>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="outline">{stateLabel(trade)}</Badge>
                            {trade.profit_trim_status === 'DONE' && <Badge variant="secondary">Profit trim</Badge>}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{activeOrderId(trade)}</span>
                            <Button asChild variant="outline" size="sm" className="h-7 gap-2">
                              <Link to={`/trades/${trade.id}/command`}>
                                <ExternalLink className="h-3.5 w-3.5" />
                                Command
                              </Link>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
              This submits a live MARKET SELL_TO_CLOSE through SnapTrade. The trade stays open while Wealthsimple confirms the exit.
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
              <div className="mt-2 flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Order</span>
                <span className="truncate font-mono text-xs">{activeOrderId(closingTrade)}</span>
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
