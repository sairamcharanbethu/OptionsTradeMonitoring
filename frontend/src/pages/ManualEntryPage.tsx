import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeDollarSign, Gauge, RefreshCw, Radio, Save, Scissors, Send, XCircle } from 'lucide-react';
import { api, ManualEntryChain, ManualEntryQuote, ManualEntrySettings, Position } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const DEFAULT_SETTINGS: ManualEntrySettings = {
  defaultTicker: 'QQQ',
  contracts: 1,
  trimCount: 1,
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

function formatAge(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return 'waiting';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
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

function getSyntheticTrailData(trade: Position) {
  const raw = trade.analysis_data;
  const parsed = typeof raw === 'string'
    ? (() => {
        try { return JSON.parse(raw); } catch { return null; }
      })()
    : raw;
  return parsed?.syntheticTrailing || null;
}

function getUnderlyingStopPrice(trade: Position) {
  const manualEntry = getManualEntryData(trade);
  const stop = trade.underlying_stop_price ?? manualEntry?.underlyingStopPrice;
  const parsed = Number(stop);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isUnderlyingStopBreached(trade: Position) {
  const stop = getUnderlyingStopPrice(trade);
  const underlying = Number(trade.underlying_price);
  if (!stop || !Number.isFinite(underlying) || trade.status !== 'OPEN') return false;
  return trade.option_type === 'PUT' ? underlying >= stop : underlying <= stop;
}

function isManualEntryTrade(trade: Position) {
  const manualEntry = getManualEntryData(trade);
  const notes = String(trade.notes || '');
  return Boolean(manualEntry?.enabled)
    || manualEntry?.source === 'mcp'
    || notes.includes('[Manual Entry]')
    || notes.includes('[MCP]');
}

function entrySourceLabel(trade: Position) {
  const manualEntry = getManualEntryData(trade);
  if (manualEntry?.source === 'mcp' || String(trade.notes || '').includes('[MCP]')) return 'MCP';
  return 'Manual';
}

function executionMessage(trade: Position) {
  const status = String(trade.execution_status || trade.status || '');
  if (status === 'PENDING_TRIM') return 'Trim submitted; waiting for broker fill.';
  if (status === 'PENDING_EXIT') return 'Sell submitted; waiting for broker fill.';
  if (status === 'PENDING_ORDER' || status === 'PENDING' || status === 'PENDING_RECONCILE') return 'Entry submitted; waiting for broker fill.';
  if (status === 'FILLED' || status === 'FILLED_FULLY' || status === 'EXECUTED') return 'Broker fill confirmed.';
  if (status.startsWith('EXIT_')) return 'Exit needs broker review.';
  if (trade.status === 'OPEN') return 'Open and ready for action.';
  return status || '-';
}

export default function ManualEntryPage() {
  const { isConnected, isAuthenticated, lastMessage, sendMessage } = useWebSocket();
  const lastLiveQuoteAtRef = useRef(0);
  const quoteRequestInFlightRef = useRef(false);
  const selectedTickerRef = useRef('');
  const [settings, setSettings] = useState<ManualEntrySettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<ManualEntrySettings>(DEFAULT_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [speedMode, setSpeedMode] = useState(false);
  const [symbol, setSymbol] = useState('QQQ');
  const [optionType, setOptionType] = useState<'CALL' | 'PUT'>('CALL');
  const [dte, setDte] = useState<0 | 1 | 2>(0);
  const [chain, setChain] = useState<ManualEntryChain | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [quote, setQuote] = useState<ManualEntryQuote | null>(null);
  const [quoteState, setQuoteState] = useState<'Snapshot' | 'Live' | 'Polling' | 'Waiting'>('Snapshot');
  const [lastQuoteAt, setLastQuoteAt] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(Date.now());
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('LIMIT');
  const [quantity, setQuantity] = useState(1);
  const [limitPrice, setLimitPrice] = useState('');
  const [underlyingStopPrice, setUnderlyingStopPrice] = useState('');
  const [limitEdited, setLimitEdited] = useState(false);
  const [openTrades, setOpenTrades] = useState<Position[]>([]);
  const [loadingChain, setLoadingChain] = useState(false);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [trimmingId, setTrimmingId] = useState<number | null>(null);
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
  const quoteFreshnessMs = lastQuoteAt ? clockTick - lastQuoteAt : null;
  const marketQuoteStale = orderType === 'MARKET' && (!lastQuoteAt || quoteFreshnessMs === null || quoteFreshnessMs > 15_000);
  const estimatedPremium = orderType === 'LIMIT' ? Number(limitPrice) : Number(quoteMark(quote) || 0);
  const estimatedDebit = Number.isFinite(estimatedPremium) && estimatedPremium > 0 && Number.isFinite(quantity)
    ? estimatedPremium * Number(quantity || 0) * 100
    : null;
  const marketDisabledReason = orderType === 'MARKET'
    ? !selectedStrike
      ? 'Choose a strike before sending a market order.'
      : !quote?.mark
        ? 'Waiting for a premium quote before sending a market order.'
        : marketQuoteStale
          ? `Market order disabled: quote last updated ${formatAge(quoteFreshnessMs)}.`
          : ''
    : '';
  const submitDisabled = submitting
    || !Number.isFinite(quantity)
    || quantity < 1
    || !selectedStrike
    || !quote?.mark
    || (orderType === 'LIMIT' && !Number(limitPrice))
    || Boolean(marketDisabledReason);
  const quoteStatusMessage = selectedTicker
    ? `${quoteState} premium ${currency(quoteMark(quote))} · ${formatAge(quoteFreshnessMs)} · Bid/Ask ${currency(quote?.bid)} / ${currency(quote?.ask)}`
    : 'Fetch strikes and choose a contract.';

  const refreshTrades = async (syncBroker = false, showSpinner = true, suppressError = false) => {
    if (showSpinner) setLoadingTrades(true);
    try {
      if (syncBroker) {
        try {
          await api.syncSnaptradePendingOrders();
        } catch (err: any) {
          if (!suppressError) setError(err.message || 'Failed to sync Wealthsimple pending orders');
        }
      }
      setOpenTrades(await api.getOpenTrades());
    } catch (err: any) {
      if (!suppressError) setError(err.message || 'Failed to load manual entries');
    } finally {
      if (showSpinner) setLoadingTrades(false);
    }
  };

  const fetchChain = async () => {
    setLoadingChain(true);
    setError(null);
    selectedTickerRef.current = '';
    lastLiveQuoteAtRef.current = 0;
    setChain(null);
    setSelectedStrike(null);
    setQuote(null);
    setLastQuoteAt(null);
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

  const fetchQuote = async (silent = false) => {
    if (!selectedStrike || !expiration) return;
    const requestTicker = selectedTicker;
    if (silent && quoteRequestInFlightRef.current) return;
    if (silent) quoteRequestInFlightRef.current = true;
    if (!silent) {
      setLoadingQuote(true);
      setError(null);
    }
    try {
      const result = await api.getManualEntryQuote({ symbol, optionType, strike: selectedStrike, expiration });
      if (requestTicker !== selectedTickerRef.current) return;
      setQuote(result);
      setLastQuoteAt(Date.now());
      if (silent) {
        const liveAgeMs = lastLiveQuoteAtRef.current ? Date.now() - lastLiveQuoteAtRef.current : Number.POSITIVE_INFINITY;
        if (liveAgeMs > 5000) setQuoteState('Polling');
      } else {
        setQuoteState('Snapshot');
      }
    } catch (err: any) {
      if (!silent) setError(err.message || 'Failed to fetch quote');
    } finally {
      if (silent) quoteRequestInFlightRef.current = false;
      if (!silent) setLoadingQuote(false);
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
    lastLiveQuoteAtRef.current = 0;
    selectedTickerRef.current = selectedTicker;
    setLastQuoteAt(null);
    fetchQuote();
    setLimitEdited(false);
  }, [showEntry, selectedTicker, selectedStrike, expiration, optionType]);

  useEffect(() => {
    if (!showEntry) return;
    const interval = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [showEntry]);

  useEffect(() => {
    if (!showEntry || !selectedStrike || !expiration) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) fetchQuote(true);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [showEntry, symbol, optionType, selectedStrike, expiration]);

  useEffect(() => {
    let inFlight = false;
    const interval = window.setInterval(async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        await refreshTrades(false, false, true);
      } finally {
        inFlight = false;
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    if (!showEntry || !selectedStrike || !expiration) return;
    if (!isAuthenticated) {
      setQuoteState('Polling');
      return;
    }
    setQuoteState(isConnected ? 'Waiting' : 'Snapshot');
    sendMessage({
      type: 'MANUAL_ENTRY_SUBSCRIBE_QUOTE',
      data: { symbol, optionType, strike: selectedStrike, expiration }
    });
    return () => {
      sendMessage({ type: 'MANUAL_ENTRY_UNSUBSCRIBE_QUOTE' });
    };
  }, [showEntry, symbol, optionType, selectedStrike, expiration, isConnected, isAuthenticated, sendMessage]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'auth_error') {
      setQuoteState('Polling');
    }
    if (lastMessage.type === 'MANUAL_ENTRY_QUOTE_UPDATE' && lastMessage.data?.ticker === selectedTicker) {
      lastLiveQuoteAtRef.current = Date.now();
      setQuote(lastMessage.data);
      setLastQuoteAt(Date.now());
      setQuoteState('Live');
    }
    if (lastMessage.type === 'MANUAL_ENTRY_QUOTE_SUBSCRIBED' && lastMessage.data?.ticker === selectedTicker) {
      setQuoteState('Waiting');
    }
    if (lastMessage.type === 'MANUAL_ENTRY_QUOTE_ERROR') {
      setQuoteState('Polling');
    }
    if (lastMessage.type === 'TRADES_UPDATED') {
      refreshTrades(false, false, true);
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
    if (!selectedStrike || !expiration || submitDisabled) return;
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
        limitPrice: orderType === 'LIMIT' ? Number(limitPrice) : null,
        underlyingStopPrice: underlyingStopPrice ? Number(underlyingStopPrice) : null
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

  const submitTrim = async (trade: Position) => {
    setTrimmingId(trade.id);
    setError(null);
    try {
      await api.trimManualEntryPosition(trade.id, settings.trimCount);
      await refreshTrades(false);
    } catch (err: any) {
      setError(err.message || 'Failed to submit trim order');
    } finally {
      setTrimmingId(null);
    }
  };

  const selectStrikePreset = (preset: 'ATM' | 'ITM1' | 'OTM1') => {
    if (!chain?.strikes.length) return;
    const strikes = chain.strikes.map((item) => Number(item.strike)).filter((strike) => Number.isFinite(strike)).sort((a, b) => a - b);
    if (strikes.length === 0) return;
    const anchor = chain.underlyingPrice || selectedStrike || strikes[Math.floor(strikes.length / 2)];
    const atmIndex = strikes.reduce((bestIndex, strike, index) => (
      Math.abs(strike - anchor) < Math.abs(strikes[bestIndex] - anchor) ? index : bestIndex
    ), 0);
    const direction = optionType === 'CALL' ? 1 : -1;
    const offset = preset === 'ATM' ? 0 : preset === 'OTM1' ? direction : -direction;
    const nextIndex = Math.min(strikes.length - 1, Math.max(0, atmIndex + offset));
    setSelectedStrike(strikes[nextIndex]);
  };

  const loadDtePreset = async (value: 0 | 1 | 2) => {
    setDte(value);
    setLoadingChain(true);
    setError(null);
    selectedTickerRef.current = '';
    lastLiveQuoteAtRef.current = 0;
    setChain(null);
    setSelectedStrike(null);
    setQuote(null);
    setLastQuoteAt(null);
    setQuoteState('Snapshot');
    try {
      const result = await api.getManualEntryChain({ symbol, optionType, dte: value });
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!showEntry) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName || '';
      const targetRole = target?.getAttribute('role') || '';
      const isTextInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || target?.isContentEditable;
      const isFocusedControl = tagName === 'BUTTON' || tagName === 'A' || ['combobox', 'listbox', 'option'].includes(targetRole);
      if (event.key === 'Enter' && !isFocusedControl && !event.metaKey && !event.ctrlKey && !event.altKey && !submitDisabled) {
        event.preventDefault();
        submitOrder();
        return;
      }
      if (isTextInput || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectStrikePreset('ATM');
      } else if (event.key === '[') {
        event.preventDefault();
        if (!chain?.strikes.length || selectedStrike === null) return;
        const strikes = chain.strikes.map((item) => Number(item.strike)).sort((a, b) => a - b);
        const index = strikes.findIndex((strike) => strike === selectedStrike);
        if (index > 0) setSelectedStrike(strikes[index - 1]);
      } else if (event.key === ']') {
        event.preventDefault();
        if (!chain?.strikes.length || selectedStrike === null) return;
        const strikes = chain.strikes.map((item) => Number(item.strike)).sort((a, b) => a - b);
        const index = strikes.findIndex((strike) => strike === selectedStrike);
        if (index >= 0 && index < strikes.length - 1) setSelectedStrike(strikes[index + 1]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showEntry, submitDisabled, chain, selectedStrike, expiration, symbol, optionType, quantity, orderType, limitPrice]);

  const tradeActions = (trade: Position, compact = false) => {
    const canSell = trade.status === 'OPEN' && !isExitPending(trade);
    const trimCount = Math.max(1, Math.floor(Number(settings.trimCount || 1)));
    const canTrim = canSell && Number(trade.quantity || 0) > 0 && Number.isFinite(trimCount);
    const trimLabel = trimmingId === trade.id ? 'Trimming' : `TRIM ${Math.min(trimCount, Number(trade.quantity || 0))}`;

    return (
      <div className={`flex ${compact ? 'w-full flex-wrap' : 'justify-end'} gap-2`}>
        <Button asChild variant="outline" size="sm" className={compact ? 'flex-1' : ''}>
          <Link to={`/trades/${trade.id}/command`}>Command</Link>
        </Button>
        <Button variant="outline" size="sm" className={`gap-1 ${compact ? 'flex-1' : ''}`} disabled={!canTrim || trimmingId === trade.id || closingId === trade.id} onClick={() => submitTrim(trade)}>
          <Scissors className="h-3.5 w-3.5" />
          {trimLabel}
        </Button>
        <Button variant="destructive" size="sm" className={compact ? 'flex-1' : ''} disabled={!canSell || closingId === trade.id || trimmingId === trade.id} onClick={() => submitSell(trade)}>
          {closingId === trade.id ? 'Selling' : 'SELL'}
        </Button>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-4">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="rounded-full">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">Manual Entry</h2>
              <Badge variant="outline">Wealthsimple</Badge>
            </div>
            <p className="text-sm text-muted-foreground">Live option entry and MCP-routed trades with SnapTrade execution.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Speed</span>
            <Switch checked={speedMode} onCheckedChange={setSpeedMode} aria-label="Speed mode" />
          </div>
          <Button variant="outline" className="flex-1 gap-2 sm:flex-none" onClick={() => refreshTrades(true)} disabled={loadingTrades}>
            <RefreshCw className={`h-4 w-4 ${loadingTrades ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button className="flex-1 gap-2 sm:flex-none" onClick={() => { setShowEntry(true); setSymbol(settings.defaultTicker); setQuantity(settings.contracts); setOrderType(settings.orderType || 'LIMIT'); setUnderlyingStopPrice(''); }}>
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

      <div className={`grid min-w-0 gap-4 ${speedMode ? '' : 'xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]'}`}>
        {!speedMode && (
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
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Contracts</Label>
                <Input type="number" min={1} value={settingsDraft.contracts} onChange={(e) => setSettingsDraft({ ...settingsDraft, contracts: Number(e.target.value) })} />
              </div>
              <div>
                <Label className="text-xs">Trim Count</Label>
                <Input type="number" min={1} value={settingsDraft.trimCount} onChange={(e) => setSettingsDraft({ ...settingsDraft, trimCount: Number(e.target.value) })} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Slippage %</Label>
                <Input type="number" min={0} value={settingsDraft.slippagePct} onChange={(e) => setSettingsDraft({ ...settingsDraft, slippagePct: Number(e.target.value) })} />
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
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
        )}

        <section className="min-w-0 space-y-4">
          {showEntry && (
            <div className="min-w-0 rounded-md border border-border bg-card p-4">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-semibold">New Entry</h3>
                <Button variant="ghost" size="icon" onClick={() => setShowEntry(false)}>
                  <XCircle className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-7">
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
                  <div className="mt-2 grid grid-cols-3 gap-1">
                    {[0, 1, 2].map((value) => (
                      <Button key={value} type="button" variant={dte === value ? 'secondary' : 'outline'} size="sm" className="h-7 px-2 text-xs" onClick={() => loadDtePreset(value as 0 | 1 | 2)} title={`Load ${value} DTE strikes`}>
                        {value}
                      </Button>
                    ))}
                  </div>
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
                <div>
                  <Label className="text-xs">{optionType === 'PUT' ? 'Stop Over' : 'Stop Under'}</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={underlyingStopPrice}
                    onChange={(e) => setUnderlyingStopPrice(e.target.value)}
                    placeholder={chain?.underlyingPrice ? currency(chain.underlyingPrice) : '$742.27'}
                  />
                </div>
              </div>

              {chain && (
                <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_140px_160px_140px]">
                  <div className="min-w-0 sm:col-span-2 xl:col-span-1">
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
                    <div className="mt-2 grid grid-cols-3 gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => selectStrikePreset('ITM1')} title="Select one strike in-the-money">ITM</Button>
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => selectStrikePreset('ATM')} title="Select nearest at-the-money strike">ATM</Button>
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => selectStrikePreset('OTM1')} title="Select one strike out-of-the-money">OTM</Button>
                    </div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Radio className={`h-3 w-3 ${quoteState === 'Live' ? 'text-emerald-500' : 'text-muted-foreground'}`} />
                      {quoteState}
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold">{currency(quoteMark(quote))}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{formatAge(quoteFreshnessMs)}</div>
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
                <div className="min-w-0 text-xs text-muted-foreground">
                  <div className="break-words">{quoteStatusMessage}</div>
                  <div className="mt-1">
                    Risk {estimatedDebit === null ? '-' : currency(estimatedDebit)} debit · {quantity || 0} contract(s) @ {estimatedPremium > 0 ? currency(estimatedPremium) : '-'}
                  </div>
                  {underlyingStopPrice && (
                    <div className="mt-1 text-red-500">
                      Alert if {symbol || 'underlying'} {optionType === 'PUT' ? 'trades above' : 'trades below'} {currency(Number(underlyingStopPrice))}
                    </div>
                  )}
                  {marketDisabledReason && <div className="mt-1 text-amber-600">{marketDisabledReason}</div>}
                  {loadingQuote && <span className="ml-2">Refreshing quote...</span>}
                </div>
                <Button className="w-full gap-2 sm:w-auto" onClick={submitOrder} disabled={submitDisabled} title={marketDisabledReason || 'Submit entry'}>
                  <Send className="h-4 w-4" />
                  Submit Entry
                </Button>
              </div>
            </div>
          )}

          <div className="min-w-0 overflow-hidden rounded-md border border-border">
            <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
              <h3 className="font-semibold">Managed Entries</h3>
              <Badge variant="outline">{manualTrades.length} active</Badge>
            </div>
            <div className="grid gap-3 p-3 md:hidden">
              {loadingTrades ? (
                <div className="py-6 text-center text-sm text-muted-foreground">Loading manual entries...</div>
              ) : manualTrades.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">No active managed entries.</div>
              ) : manualTrades.map((trade) => {
                const manualEntry = getManualEntryData(trade);
                const syntheticTrail = getSyntheticTrailData(trade);
                const stopBreached = isUnderlyingStopBreached(trade);
                const underlyingStop = getUnderlyingStopPrice(trade);
                return (
                  <div key={trade.id} className={`rounded-md border bg-card p-3 ${stopBreached ? 'manual-stop-breached border-red-500/70' : 'border-border'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="break-words font-medium">{contractLabel(trade)}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <Badge variant="outline" className="h-5 text-[10px]">{entrySourceLabel(trade)}</Badge>
                          <span className="break-all">Entry {trade.broker_order_id || '-'}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">{executionMessage(trade)}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {stopBreached && <Badge variant="destructive" className="animate-pulse">CLOSE</Badge>}
                        <Badge variant={isExitPending(trade) ? 'secondary' : trade.status === 'OPEN' ? 'default' : 'outline'}>
                          {trade.execution_status || trade.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">Qty</div>
                        <div className="font-mono">{trade.quantity}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Live</div>
                        <div className="font-mono">{currency(trade.current_price)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Underlying</div>
                        <div className={`font-mono ${stopBreached ? 'font-semibold text-red-500' : ''}`}>{currency(trade.underlying_price)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">{trade.option_type === 'PUT' ? 'Stop Over' : 'Stop Under'}</div>
                        <div className={`font-mono ${stopBreached ? 'font-semibold text-red-500' : ''}`}>{currency(underlyingStop)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Entry</div>
                        <div className="font-mono">{currency(trade.entry_price)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">TP / Active stop</div>
                        <div className="font-mono">{currency(trade.take_profit_trigger)} / {currency(trade.stop_loss_trigger ?? manualEntry?.stopLossDisplay)}</div>
                        {syntheticTrail?.active && <div className="text-[10px] text-emerald-500">Synthetic {Number(syntheticTrail.pct || trade.trailing_stop_loss_pct).toFixed(1)}%</div>}
                      </div>
                    </div>
                    {trade.execution_error && <div className="mt-2 break-words text-xs text-amber-600">{trade.execution_error}</div>}
                    <div className="mt-3">{tradeActions(trade, true)}</div>
                  </div>
                );
              })}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[960px] text-sm">
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
                    <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">No active managed entries.</td></tr>
                  ) : manualTrades.map((trade) => {
                    const manualEntry = getManualEntryData(trade);
                    const syntheticTrail = getSyntheticTrailData(trade);
                    const stopBreached = isUnderlyingStopBreached(trade);
                    const underlyingStop = getUnderlyingStopPrice(trade);
                    return (
                      <tr key={trade.id} className={`border-t border-border/70 ${stopBreached ? 'manual-stop-breached' : ''}`}>
                        <td className="px-3 py-3">
                          <div className="font-medium">{contractLabel(trade)}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <Badge variant="outline" className="h-5 text-[10px]">{entrySourceLabel(trade)}</Badge>
                            <span className="break-all">Entry {trade.broker_order_id || '-'}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">{executionMessage(trade)}</div>
                          {stopBreached && <Badge variant="destructive" className="mt-2 animate-pulse">CLOSE NOW</Badge>}
                        </td>
                        <td className="px-3 py-3 text-right font-mono">{trade.quantity}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.entry_price)}</td>
                        <td className="px-3 py-3 text-right font-mono">{currency(trade.current_price)}</td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-500">{currency(trade.take_profit_trigger)}</td>
                        <td className="px-3 py-3 text-right">
                          <div className="font-mono text-muted-foreground">{currency(trade.stop_loss_trigger ?? manualEntry?.stopLossDisplay)}</div>
                          {syntheticTrail?.active && (
                            <div className="text-[10px] font-mono text-emerald-500">
                              Trail {Number(syntheticTrail.pct || trade.trailing_stop_loss_pct).toFixed(1)}% · high {currency(syntheticTrail.highPremium ?? trade.trailing_high_price)}
                            </div>
                          )}
                          <div className={`text-xs font-mono ${stopBreached ? 'font-semibold text-red-500' : 'text-muted-foreground'}`}>
                            {trade.option_type === 'PUT' ? 'Over' : 'Under'} {currency(underlyingStop)}
                          </div>
                          <div className={`text-xs font-mono ${stopBreached ? 'font-semibold text-red-500' : 'text-muted-foreground'}`}>
                            {currency(trade.underlying_price)}
                          </div>
                        </td>
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
                          {tradeActions(trade)}
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
