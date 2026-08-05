import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowLeft, Loader2, RefreshCw, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type OptionType = 'CALL' | 'PUT';

const todayIso = new Date().toISOString().slice(0, 10);

const buildOsi = (symbol: string, optionType: OptionType, strike: string, expiration: string) => {
  const parts = expiration.split('-');
  const numericStrike = Number(strike);
  if (!symbol || parts.length !== 3 || !Number.isFinite(numericStrike)) return '';
  const side = optionType === 'CALL' ? 'C' : 'P';
  return `${symbol.toUpperCase()}${parts[0].slice(-2)}${parts[1].padStart(2, '0')}${parts[2].padStart(2, '0')}${side}${Math.round(numericStrike * 1000).toString().padStart(8, '0')}`;
};

export default function DevLiveExitTestPage() {
  const [provider, setProvider] = useState('ibkr');
  const [symbol, setSymbol] = useState('QQQ');
  const [optionType, setOptionType] = useState<OptionType>('CALL');
  const [strike, setStrike] = useState('');
  const [expiration, setExpiration] = useState(todayIso);
  const [bid, setBid] = useState('');
  const [ask, setAsk] = useState('');
  const [last, setLast] = useState('');
  const [underlyingPrice, setUnderlyingPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [orderType, setOrderType] = useState<'LIMIT' | 'MARKET'>('LIMIT');
  const [limitPrice, setLimitPrice] = useState('');
  const [liveOrderConfirmation, setLiveOrderConfirmation] = useState('');
  const [health, setHealth] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingOrders, setSyncingOrders] = useState(false);
  const [runningFullTest, setRunningFullTest] = useState(false);
  const [placingOrder, setPlacingOrder] = useState(false);

  const osi = useMemo(() => buildOsi(symbol, optionType, strike, expiration), [symbol, optionType, strike, expiration]);
  const quotePayload = { provider, symbol, optionType, strike, expiration, bid, ask, last, underlyingPrice };
  const canSendQuote = Boolean(osi && (bid || ask || last));
  const testOrderPayload = {
    symbol,
    optionType,
    strike,
    expiration,
    quantity,
    orderType,
    limitPrice,
    mark: last || (bid && ask ? ((Number(bid) + Number(ask)) / 2).toFixed(2) : ''),
    confirmation: liveOrderConfirmation
  };
  const canPlaceLiveOrder = Boolean(
    osi
    && Number(quantity) > 0
    && liveOrderConfirmation === 'PLACE LIVE ORDER'
    && (orderType === 'MARKET' || Number(limitPrice) > 0)
  );

  const loadHealth = async () => {
    setRefreshing(true);
    try {
      setHealth(await api.getServicesHealth());
    } catch (err: any) {
      setError(err.message || 'Failed to load service health');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadHealth();
  }, []);

  const submitQuote = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await api.injectDevQuote(quotePayload);
      setResult(response);
      await loadHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to inject quote');
    } finally {
      setLoading(false);
    }
  };

  const syncPendingOrders = async () => {
    setSyncingOrders(true);
    setError('');
    setResult(null);
    try {
      const response = await api.syncSnaptradePendingOrders();
      setResult(response);
      await loadHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to sync pending orders');
    } finally {
      setSyncingOrders(false);
    }
  };

  const runFullLiveExitTest = async () => {
    setRunningFullTest(true);
    setError('');
    setResult(null);
    try {
      const pendingSync = await api.syncSnaptradePendingOrders();
      const quoteInjection = await api.injectDevQuote(quotePayload);
      setResult({
        status: 'ok',
        test: 'sync-pending-orders-and-inject-quote',
        pendingSync,
        quoteInjection
      });
      await loadHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to run full live-exit test');
    } finally {
      setRunningFullTest(false);
    }
  };

  const placeSnaptradeTestOrder = async () => {
    setPlacingOrder(true);
    setError('');
    setResult(null);
    try {
      const response = await api.placeSnaptradeDevOptionOrder(testOrderPayload);
      setResult(response);
      await loadHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to place Wealthsimple test order');
    } finally {
      setPlacingOrder(false);
    }
  };

  const runCompleteSnaptradeTest = async () => {
    setRunningFullTest(true);
    setError('');
    setResult(null);
    try {
      const placedOrder = await api.placeSnaptradeDevOptionOrder(testOrderPayload);
      const pendingSync = await api.syncSnaptradePendingOrders();
      const quoteInjection = canSendQuote ? await api.injectDevQuote(quotePayload) : null;
      setResult({
        status: 'ok',
        test: 'place-snaptrade-order-sync-and-inject-quote',
        placedOrder,
        pendingSync,
        quoteInjection
      });
      await loadHealth();
    } catch (err: any) {
      setError(err.message || 'Failed to run complete SnapTrade test');
    } finally {
      setRunningFullTest(false);
    }
  };

  const monitor = health?.liveExitMonitor;
  const activeStream = health?.streams?.ibkr;

  return (
    <div className="mx-auto w-[95%] max-w-5xl py-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-3 gap-2">
            <Link to="/"><ArrowLeft className="h-4 w-4" />Dashboard</Link>
          </Button>
          <h1 className="text-2xl font-extrabold tracking-tight">Live exit test console</h1>
          <p className="text-sm text-muted-foreground mt-1">Inject one quote into the live-exit monitor for an already-open option position.</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={loadHealth} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh health
        </Button>
      </div>

      <div className="rounded border border-amber-500/30 bg-amber-950/20 p-3 flex gap-2 text-sm text-amber-100">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <p>This uses the real live-exit path. If the quote crosses a stop or target for an open live position, the app can attempt an exit order.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide">Quote input</h2>
            <Badge variant="outline">{osi || 'OSI pending'}</Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ibkr">IBKR</SelectItem>
                  <SelectItem value="wealthsimple">Wealthsimple/SnapTrade</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Symbol</Label>
              <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="QQQ" />
            </div>
            <div className="space-y-1.5">
              <Label>Side</Label>
              <Select value={optionType} onValueChange={(value) => setOptionType(value as OptionType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CALL">CALL</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Strike</Label>
              <Input value={strike} onChange={(e) => setStrike(e.target.value)} placeholder="485" inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label>Expiration</Label>
              <Input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Underlying price</Label>
              <Input value={underlyingPrice} onChange={(e) => setUnderlyingPrice(e.target.value)} placeholder="Optional" inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label>Bid</Label>
              <Input value={bid} onChange={(e) => setBid(e.target.value)} placeholder="1.20" inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label>Ask</Label>
              <Input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="1.30" inputMode="decimal" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Last trade</Label>
              <Input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Used if bid/ask are empty" inputMode="decimal" />
            </div>
          </div>

          <Button className="w-full gap-2" onClick={submitQuote} disabled={loading || !canSendQuote}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send test quote
          </Button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </section>

        <section className="rounded border border-border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-400" />
            <h2 className="text-sm font-bold uppercase tracking-wide">Monitor health</h2>
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">Monitor</div>
              <div className="font-bold">{monitor?.status || 'N/A'}</div>
            </div>
            <div className="rounded bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">Provider</div>
              <div className="font-bold">{monitor?.provider || 'none'}</div>
            </div>
            <div className="rounded bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">Quotes</div>
              <div className="font-bold">{monitor?.quotesProcessed ?? 0}</div>
            </div>
            <div className="rounded bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">Matches</div>
              <div className="font-bold">{monitor?.matchedUpdates ?? 0}</div>
            </div>
            <div className="rounded bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">Stream</div>
              <div className="font-bold">{activeStream?.connected ? 'connected' : 'not connected'}</div>
            </div>
            <div className="rounded bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">Subscriptions</div>
              <div className="font-bold">{activeStream?.activeSubscriptions ?? 0}</div>
            </div>
          </div>

          <div className="rounded border border-red-500/30 bg-red-950/10 p-3 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-red-100">Place Wealthsimple test order</h3>
              <p className="text-xs text-muted-foreground mt-1">Submits a real SnapTrade BUY_TO_OPEN order using the selected Wealthsimple account in settings.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Contracts</Label>
                <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label>Order</Label>
                <Select value={orderType} onValueChange={(value) => setOrderType(value as 'LIMIT' | 'MARKET')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LIMIT">LIMIT</SelectItem>
                    <SelectItem value="MARKET">MARKET</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Limit</Label>
                <Input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder="Required for limit" inputMode="decimal" disabled={orderType === 'MARKET'} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Confirmation</Label>
              <Input value={liveOrderConfirmation} onChange={(e) => setLiveOrderConfirmation(e.target.value)} placeholder="Type PLACE LIVE ORDER" />
            </div>
            <Button variant="destructive" className="w-full gap-2" onClick={placeSnaptradeTestOrder} disabled={placingOrder || !canPlaceLiveOrder}>
              {placingOrder ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Place Wealthsimple order
            </Button>
            <Button className="w-full gap-2" onClick={runCompleteSnaptradeTest} disabled={runningFullTest || !canPlaceLiveOrder || !canSendQuote}>
              {runningFullTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Place order + sync + send quote
            </Button>
          </div>

          <div className="rounded border border-border bg-muted/30 p-3 space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Wealthsimple order sync</h3>
              <p className="text-xs text-muted-foreground mt-1">Checks recent SnapTrade orders and moves filled pending app orders to open positions.</p>
            </div>
            <Button variant="outline" className="w-full gap-2" onClick={syncPendingOrders} disabled={syncingOrders}>
              {syncingOrders ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync pending orders
            </Button>
            <Button className="w-full gap-2" onClick={runFullLiveExitTest} disabled={runningFullTest || !canSendQuote}>
              {runningFullTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Sync orders + send quote
            </Button>
          </div>

          {result && (
            <div className="rounded bg-zinc-950 text-zinc-100 p-3 overflow-auto text-xs font-mono max-h-72">
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
