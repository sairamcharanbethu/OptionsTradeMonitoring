import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeDollarSign, RefreshCw, Radio, Save, Send, XCircle } from 'lucide-react';
import { api, ManualEntryChain, ManualEntryQuote, ManualEntrySettings, Position } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const DEFAULT_SETTINGS: ManualEntrySettings = {
  defaultTicker: 'QQQ',
  contracts: 1,
  slippagePct: 3,
  orderType: 'LIMIT',
  takeProfitPct: null,
  stopLossPct: null
};

function currency(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `$${Number(value).toFixed(2)}`;
}

function compactDate(value?: string | null) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).split('T')[0] || '-';
  return parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function contractLabel(trade: Position) {
  return `${trade.symbol} ${Number(trade.strike_price).toLocaleString()} ${trade.option_type} ${String(trade.expiration_date).split('T')[0]}`;
}

function isExitPending(trade: Position) {
  const status = String(trade.execution_status || '');
  return ['PENDING_EXIT', 'PENDING_TRIM'].includes(status) || status.startsWith('EXIT_');
}

function quoteMark(quote: ManualEntryQuote | null) {
  return quote?.mark ?? null;
}

function quoteTicker(symbol: string, optionType: 'CALL' | 'PUT', strike: number | null, expiration: string) {
  if (!symbol || !strike || !expiration) return '';
  const [year, month, day] = expiration.split('-');
  const side = optionType === 'CALL' ? 'C' : 'P';
  return `${symbol.toUpperCase()}${year.slice(-2)}${month}${day}${side}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
}

function getManualEntryData(trade: Position) {
  const raw = trade.analysis_data;
  const parsed = typeof raw === 'string'
    ? (() => {
        try { return JSON.parse(raw); } catch { return null; }
      })()
    : raw;
  return parsed?.manualEntry || null;
}

function isManualEntryTrade(trade: Position) {
  return Boolean(getManualEntryData(trade)?.enabled) || String(trade.notes || '').includes('[Manual Entry]');
}

export default function ManualEntryPage() {
  const { isConnected, lastMessage, sendMessage } = useWebSocket();
  const [settings, setSettings] = useState<ManualEntrySettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<ManualEntrySettings>(DEFAULT_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [symbol, setSymbol] = useState('QQQ');
  const [optionType, setOptionType] = useState<'CALL' | 'PUT'>('CALL');
  const [dte, setDte] = useState<0 | 1 | 2>(0);
  const [chain, setChain] = useState<ManualEntryChain | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [quote, setQuote] = useState<ManualEntryQuote | null>(null);
  const [quoteState, setQuoteState] = useState<'Snapshot' | 'Live' | 'Waiting'>('Snapshot');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('LIMIT');
  const [quantity, setQuantity] = useState(1);
  const [limitPrice, setLimitPrice] = useState('');
  const [limitEdited, setLimitEdited] = useState(false);
  const [openTrades, setOpenTrades] = useState<Position[]>([]);
  const [loadingChain, setLoadingChain] = useState(false);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expiration = chain?.expiration || '';
  const selectedTicker = useMemo(
    () => quoteTicker(symbol, optionType, selectedStrike, expiration),
    [symbol, optionType, selectedStrike, expiration]
  );
  const manualTrades = useMemo(
    () => openTrades.filter(isManualEntryTrade),
    [openTrades]
  );

  const refreshTrades = async (syncBroker = false, showSpinner = true) => {
    if (showSpinner) setLoadingTrades(true);
    try {
      if (syncBroker) {
        try {
          await api.syncSnaptradePendingOrders();
        } catch (err: any) {
          setError(err.message || 'Failed to sync Wealthsimple pending orders');
        }
      }
      setOpenTrades(await api.getOpenTrades());
    } catch (err: any) {
      setError(err.message || 'Failed to load manual entries');
    } finally {
      if (showSpinner) setLoadingTrades(false);
    }
  };

  const fetchChain = async () => {
    setLoadingChain(true);
    setError(null);
    setChain(null);
    setSelectedStrike(null);
    setQuote(null);
    setQuoteState('Snapshot');
    try {
      const result = await api.getManualEntryChain({ symbol, optionType, dte });
      setChain(result);
      const withMark = result.strikes.filter((item) => item.mark && item.mark > 0);
      const center = withMark[Math.floor(withMark.length / 2)] || result.strikes[Math.floor(result.strikes.length / 2)];
      if (center) setSelectedStrike(center.strike);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch strikes');
    } finally {
      setLoadingChain(false);
    }
  };

  const fetchQuote = async () => {
    if (!selectedStrike || !expiration) return;
    setLoadingQuote(true);
    setError(null);
    try {
      const result = await api.getManualEntryQuote({ symbol, optionType, strike: selectedStrike, expiration });
      setQuote(result);
      setQuoteState('Snapshot');
    } catch (err: any) {
      setError(err.message || 'Failed to fetch quote');
    } finally {
      setLoadingQuote(false);
    }
  };

  useEffect(() => {
    async function load() {
      try {
        const data = await api.getManualEntrySettings();
        setSettings(data);
        setSettingsDraft(data);
        setSymbol(data.defaultTicker || 'QQQ');
        setQuantity(data.contracts || 1);
        setOrderType(data.orderType || 'LIMIT');
      } catch (err: any) {
        setError(err.message || 'Failed to load manual entry settings');
      }
      refreshTrades();
    }
    load();
  }, []);

  useEffect(() => {
    if (!showEntry || !selectedStrike || !expiration) return;
    fetchQuote();
    setLimitEdited(false);
  }, [showEntry, selectedStrike, expiration, optionType]);

  useEffect(() => {
    if (!showEntry || !selectedStrike || !expiration) return;
    setQuoteState(isConnected ? 'Waiting' : 'Snapshot');
    sendMessage({
      type: 'MANUAL_ENTRY_SUBSCRIBE_QUOTE',
      data: { symbol, optionType, strike: selectedStrike, expiration }
    });
    return () => {
      sendMessage({ type: 'MANUAL_ENTRY_UNSUBSCRIBE_QUOTE' });
    };
  }, [showEntry, symbol, optionType, selectedStrike, expiration, isConnected, sendMessage]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'MANUAL_ENTRY_QUOTE_UPDATE' && lastMessage.data?.ticker === selectedTicker) {
      setQuote(lastMessage.data);
      setQuoteState('Live');
    }
    if (lastMessage.type === 'MANUAL_ENTRY_QUOTE_ERROR') {
      setQuoteState('Snapshot');
    }
    if (lastMessage.type === 'TRADES_UPDATED') {
      refreshTrades(false, false);
    }
  }, [lastMessage, selectedTicker]);

  useEffect(() => {
    if (orderType !== 'LIMIT' || limitEdited) return;
    const ask = quote?.ask;
    if (ask && ask > 0) {
      setLimitPrice((ask * (1 + Number(settings.slippagePct || 0) / 100)).toFixed(2));
    }
  }, [orderType, quote?.ask, settings.slippagePct, limitEdited]);

  const saveSettings = async () => {
    setSavingSettings(true);
    setError(null);
    try {
      const updated = await api.updateManualEntrySettings({
        ...settingsDraft,
        defaultTicker: settingsDraft.defaultTicker.toUpperCase()
      });
      setSettings(updated);
      setSettingsDraft(updated);
      setSymbol(updated.defaultTicker);
      setQuantity(updated.contracts);
      setOrderType(updated.orderType);
    } catch (err: any) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const submitOrder = async () => {
    if (!selectedStrike || !expiration) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.submitManualEntryOrder({
        symbol,
        optionType,
        strike: selectedStrike,
        expiration,
        quantity,
        orderType,
        limitPrice: orderType === 'LIMIT' ? Number(limitPrice) : null
      });
      setShowEntry(false);
      await refreshTrades(true);
    } catch (err: any) {
      setError(err.message || 'Failed to submit order');
    } finally {
      setSubmitting(false);
    }
  };

  const submitSell = async (trade: Position) => {
    setClosingId(trade.id);
    setError(null);
    try {
      await api.closeWealthsimpleTrade(trade.id, trade.quantity);
      await refreshTrades(true);
    } catch (err: any) {
      setError(err.message || 'Failed to submit sell order');
    } finally {
      setClosingId(null);
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
              <h2 className="text-xl font-semibold tracking-tight">Manual Entry</h2>
              <Badge variant="outline">Wealthsimple</Badge>
            </div>
            <p className="text-sm text-muted-foreground">Live option entry with ThetaData quotes and SnapTrade execution.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-2" onClick={() => refreshTrades(true)} disabled={loadingTrades}>
            <RefreshCw className={`h-4 w-4 ${loadingTrades ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button className="gap-2" onClick={() => { setShowEntry(true); setSymbol(settings.defaultTicker); setQuantity(settings.contracts); setOrderType(settings.orderType || 'LIMIT'); }}>
            <BadgeDollarSign className="h-4 w-4" />
            New Entry
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">Manual Defaults</h3>
            <Button size="sm" variant="outline" className="gap-2" onClick={saveSettings} disabled={savingSettings}>
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
          <div className="grid gap-3">
            <div>
              <Label className="text-xs">Ticker</Label>
              <Input value={settingsDraft.defaultTicker} onChange={(e) => setSettingsDraft({ ...settingsDraft, defaultTicker: e.target.value.toUpperCase() })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Contracts</Label>
                <Input type="number" min={1} value={settingsDraft.contracts} onChange={(e) => setSettingsDraft({ ...settingsDraft, contracts: Number(e.target.value) })} />
              </div>
              <div>
                <Label className="text-xs">Slippage %</Label>
                <Input type="number" min={0} value={settingsDraft.slippagePct} onChange={(e) => setSettingsDraft({ ...settingsDraft, slippagePct: Number(e.target.value) })} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Order Type</Label>
              <Select value={settingsDraft.orderType} onValueChange={(value: 'MARKET' | 'LIMIT') => setSettingsDraft({ ...settingsDraft, orderType: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MARKET">Market</SelectItem>
                  <SelectItem value="LIMIT">Limit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Take Profit %</Label>
                <Input type="number" min={0} value={settingsDraft.takeProfitPct ?? ''} onChange={(e) => setSettingsDraft({ ...settingsDraft, takeProfitPct: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <Label className="text-xs">Stop Loss %</Label>
                <Input type="number" min={0} value={settingsDraft.stopLossPct ?? ''} onChange={(e) => setSettingsDraft({ ...settingsDraft, stopLossPct: e.target.value ? Number(e.target.value) : null })} />
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {showEntry && (
            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-semibold">New Entry</h3>
                <Button variant="ghost" size="icon" onClick={() => setShowEntry(false)}>
                  <XCircle className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-3 lg:grid-cols-6">
                <div>
                  <Label className="text-xs">Ticker</Label>
                  <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
                </div>
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select value={optionType} onValueChange={(value: 'CALL' | 'PUT') => setOptionType(value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CALL">Call</SelectItem>
                      <SelectItem value="PUT">Put</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">DTE</Label>
                  <Select value={String(dte)} onValueChange={(value) => setDte(Number(value) as 0 | 1 | 2)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0</SelectItem>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="2">2</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button variant="outline" className="w-full gap-2" onClick={fetchChain} disabled={loadingChain}>
                    <RefreshCw className={`h-4 w-4 ${loadingChain ? 'animate-spin' : ''}`} />
                    Strikes
                  </Button>
                </div>
                <div>
                  <Label className="text-xs">Contracts</Label>
                  <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
                </div>
                <div>
                  <Label className="text-xs">Order Type</Label>
                  <Select value={orderType} onValueChange={(value: 'MARKET' | 'LIMIT') => { setOrderType(value); setLimitEdited(false); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MARKET">Market</SelectItem>
                      <SelectItem value="LIMIT">Limit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {chain && (
                <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_180px_180px_180px]">
                  <div>
                    <Label className="text-xs">Strike</Label>
                    <Select value={selectedStrike ? String(selectedStrike) : ''} onValueChange={(value) => setSelectedStrike(Number(value))}>
                      <SelectTrigger><SelectValue placeholder="Choose strike" /></SelectTrigger>
                      <SelectContent>
                        {chain.strikes.map((item) => (
                          <SelectItem key={item.strike} value={String(item.strike)}>
                            {item.strike} · {currency(item.bid)} / {currency(item.ask)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Radio className={`h-3 w-3 ${quoteState === 'Live' ? 'text-emerald-500' : 'text-muted-foreground'}`} />
                      {quoteState}
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold">{currency(quoteMark(quote))}</div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                    <div className="text-xs text-muted-foreground">Bid / Ask</div>
                    <div className="mt-1 font-mono text-sm">{currency(quote?.bid)} / {currency(quote?.ask)}</div>
                  </div>
                  <div>
                    <Label className="text-xs">Limit</Label>
                    <Input
                      value={limitPrice}
                      disabled={orderType !== 'LIMIT'}
                      onChange={(e) => { setLimitPrice(e.target.value); setLimitEdited(true); }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  {selectedTicker || 'Fetch strikes and choose a contract.'}
                  {loadingQuote && <span className="ml-2">Refreshing quote...</span>}
                </div>
                <Button className="gap-2" onClick={submitOrder} disabled={submitting || !Number.isFinite(quantity) || quantity < 1 || !selectedStrike || !quote?.mark || (orderType === 'LIMIT' && !Number(limitPrice))}>
                  <Send className="h-4 w-4" />
                  Submit Entry
                </Button>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-border">
            <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
              <h3 className="font-semibold">Manual Entries</h3>
              <Badge variant="outline">{manualTrades.length} active</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 text-left">Contract</th>
                    <th className="px-3 py-3 text-right">Qty</th>
                    <th className="px-3 py-3 text-right">Entry</th>
                    <th className="px-3 py-3 text-right">Live</th>
                    <th className="px-3 py-3 text-right">TP</th>
                    <th className="px-3 py-3 text-right">SL</th>
                    <th className="px-3 py-3 text-left">State</th>
                    <th className="px-3 py-3 text-left">Broker</th>
                    <th className="px-3 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingTrades ? (
                    <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Loading manual entries...</td></tr>
                  ) : manualTrades.length === 0 ? (
                    <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">No active manual entries.</td></tr>
                  ) : manualTrades.map((trade) => {
                    const canSell = trade.status === 'OPEN' && !isExitPending(trade);
                    const manualEntry = getManualEntryData(trade);
                    return (
                      <tr key={trade.id} className="border-t border-border/70">
                        <td className="px-3 py-3">
                          <div className="font-medium">{contractLabel(trade)}</div>
                          <div className="text-xs text-muted-foreground">Entry {trade.broker_order_id || '-'}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-mono">{trade.quantity}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.entry_price)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.current_price)}</td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-500">{currency(trade.take_profit_trigger)}</td>
                        <td className="px-3 py-3 text-right font-mono text-muted-foreground">{currency(manualEntry?.stopLossDisplay)}</td>
                        <td className="px-3 py-3">
                          <Badge variant={isExitPending(trade) ? 'secondary' : trade.status === 'OPEN' ? 'default' : 'outline'}>
                            {trade.execution_status || trade.status}
                          </Badge>
                          {trade.execution_error && <div className="mt-1 max-w-[280px] text-xs text-amber-600">{trade.execution_error}</div>}
                        </td>
                        <td className="px-3 py-3 text-xs text-muted-foreground">
                          <div>{trade.last_broker_order_status || '-'}</div>
                          <div>{compactDate(trade.last_broker_sync_at)}</div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button asChild variant="outline" size="sm">
                              <Link to={`/trades/${trade.id}/command`}>Command</Link>
                            </Button>
                            <Button variant="destructive" size="sm" disabled={!canSell || closingId === trade.id} onClick={() => submitSell(trade)}>
                              {closingId === trade.id ? 'Selling' : 'SELL'}
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
        </section>
      </div>
    </div>
  );
}
