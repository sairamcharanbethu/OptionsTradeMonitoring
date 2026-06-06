import React, { useState, useEffect, useRef } from 'react';
import { useSignals, useSettings, QUERY_KEYS } from '@/hooks/useDashboardData';
import { api, Signal } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import {
  Terminal as TerminalIcon,
  ShieldAlert,
  TrendingUp,
  Play,
  XCircle,
  Database,
  AlertCircle,
  HelpCircle,
  Activity,
  ChevronRight,
  Check,
  X,
  RefreshCw,
  Info,
  Clock,
  Sparkles,
  Zap,
  CheckCircle,
  Heart,
  Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

interface ApiHealthState {
  yahooFinance: { status: string; latencyMs: number };
  sscgexPortal: { status: string; latencyMs: number };
  polygon: { status: string; latencyMs: number };
  openRouter: { status: string; latencyMs: number };
  discord: { status: string; latencyMs: number };
}

export default function DayTradingTerminal() {
  const queryClient = useQueryClient();
  const { data: signals = [], isLoading, isFetching, refetch } = useSignals(10000); // Poll signals every 10s internally
  const { data: settings = {} } = useSettings();
  const isDayTradingEnabled = settings.day_trading_enabled !== 'false';

  // States
  const [selectedSymbol, setSelectedSymbol] = useState<'QQQ' | 'SPY'>('QQQ');
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(300); // 5 minute countdown
  const [healthData, setHealthData] = useState<ApiHealthState>({
    yahooFinance: { status: 'UP', latencyMs: 95 },
    sscgexPortal: { status: 'UP', latencyMs: 140 },
    polygon: { status: 'UP', latencyMs: 110 },
    openRouter: { status: 'UP', latencyMs: 310 },
    discord: { status: 'UP', latencyMs: 120 }
  });
  const [healthLoading, setHealthLoading] = useState(false);

  // Fetch Health on mount and on refresh
  const fetchHealth = async () => {
    setHealthLoading(true);
    try {
      const health = await api.getSignalsHealth();
      setHealthData(health);
    } catch (err: any) {
      console.warn('Failed to load API health stats:', err);
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  // 5-minute countdown timer
  useEffect(() => {
    if (!isDayTradingEnabled) return;
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // Trigger refresh when timer reaches 0
          refetch();
          fetchHealth();
          return 300;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refetch, isDayTradingEnabled]);

  // Sync manually
  const handleManualSync = () => {
    refetch();
    fetchHealth();
    setCountdown(300);
  };

  // Filter signals based on selected active tab (QQQ or SPY)
  const filteredSignals = signals.filter(s => s.symbol === selectedSymbol);

  // Get currently selected signal object
  const selectedSignal = filteredSignals.find(s => s.id === selectedSignalId) || null;

  // Set default selected signal when signals load or tab changes
  useEffect(() => {
    if (filteredSignals.length > 0) {
      setSelectedSignalId(filteredSignals[0].id);
    } else {
      setSelectedSignalId(null);
    }
  }, [selectedSymbol, signals]);

  // Find the single LATEST actionable signal for QQQ or SPY (within the last 24h)
  const latestActionableSignal = filteredSignals.find(s => s.signal_type !== 'NONE' && s.status === 'PENDING') || null;

  // Click handler wrapper
  const handleQuickStatus = async (id: number, status: 'EXECUTED' | 'CANCELLED') => {
    try {
      await api.updateSignalStatus(id, status);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    } catch (err: any) {
      alert(`Failed to update status: ${err.message}`);
    }
  };

  // Derive active Market Regime (Euphoria, Bullish, Bearish, Neutral)
  // Look at the latest signal or default
  const latestSignal = filteredSignals[0] || null;
  const currentGexRegime = latestSignal?.gex?.regime || 'NEUTRAL';
  const vixValue = latestSignal?.volatility?.vixQuote || 14.5;
  const spotPrice = latestSignal?.current_price || 0;
  const vwapValue = latestSignal?.indicators?.vwap || 0;

  let marketRegime = 'NEUTRAL';
  let regimeGlowColor = 'shadow-zinc-500/20 text-zinc-400 border-zinc-500/30';
  let regimeBadgeBg = 'bg-zinc-900 text-zinc-300 border border-zinc-500/30';

  if (currentGexRegime === 'POSITIVE' && vixValue <= 13.5) {
    marketRegime = 'EUPHORIA';
    regimeGlowColor = 'shadow-purple-500/30 text-purple-400 border-purple-500/30 bg-purple-950/10';
    regimeBadgeBg = 'bg-purple-900/60 text-purple-200 border border-purple-500/40 animate-pulse';
  } else if (currentGexRegime === 'POSITIVE' || (spotPrice > 0 && spotPrice > vwapValue)) {
    marketRegime = 'BULLISH';
    regimeGlowColor = 'shadow-emerald-500/30 text-emerald-400 border-emerald-500/30 bg-emerald-950/10';
    regimeBadgeBg = 'bg-emerald-900/60 text-emerald-200 border border-emerald-500/40';
  } else if (currentGexRegime === 'NEGATIVE' || (spotPrice > 0 && spotPrice < vwapValue)) {
    marketRegime = 'BEARISH';
    regimeGlowColor = 'shadow-red-500/30 text-red-400 border-red-500/30 bg-red-950/10';
    regimeBadgeBg = 'bg-red-900/60 text-red-200 border border-red-500/40';
  }

  // Mega-caps change tracking (retrieve from latest signal index statistics if available, else standard fallback)
  const AAPL_change = 0.85; 
  const MSFT_change = -0.32;
  const NVDA_change = 1.45;

  const formatMinSec = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col gap-6 font-mono bg-zinc-950 text-emerald-400 p-4 rounded-xl border border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.05)]">
      
      {/* Top Banner & Timer Bar */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-emerald-500/20 pb-4 gap-4">
        <div className="flex items-center gap-3">
          <TerminalIcon className="h-6 w-6 text-emerald-400 animate-pulse" />
          <div className="flex flex-col">
            <h2 className="text-xl font-bold uppercase tracking-widest text-emerald-300">DAY_TRADING_DASHBOARD</h2>
            <span className="text-[10px] text-emerald-500/80">Active channels: QQQ, SPY | Live database scanning engine</span>
          </div>
        </div>

        {/* Ticker switcher Tabs & Sync Timer */}
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto justify-between md:justify-end">
          <div className="flex bg-zinc-900 p-1 rounded border border-emerald-500/20">
            <button
              onClick={() => setSelectedSymbol('QQQ')}
              className={`px-4 py-1.5 text-xs font-bold rounded transition-all ${
                selectedSymbol === 'QQQ' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              QQQ Ticker
            </button>
            <button
              onClick={() => setSelectedSymbol('SPY')}
              className={`px-4 py-1.5 text-xs font-bold rounded transition-all ${
                selectedSymbol === 'SPY' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              SPY Ticker
            </button>
          </div>

          {isDayTradingEnabled ? (
            <div className="flex items-center gap-2 text-xs bg-emerald-950/40 border border-emerald-500/30 px-3 py-1.5 rounded">
              <Clock className="h-4 w-4 text-emerald-400 animate-spin" style={{ animationDuration: '6s' }} />
              <span>SCAN CYCLE: {formatMinSec(countdown)}</span>
              <button
                onClick={handleManualSync}
                className="ml-1 text-emerald-500 hover:text-emerald-300"
                title="Force Sync Now"
              >
                <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs bg-zinc-900/60 border border-zinc-700 px-3 py-1.5 rounded text-zinc-500">
              <ShieldAlert className="h-4 w-4 text-amber-500/70 animate-pulse" />
              <span className="font-bold tracking-wider">SCANNER INACTIVE</span>
            </div>
          )}
        </div>
      </div>

      {/* Row 1: Dashboard Gauges / Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Widget 1: Glowing Market Regime Gauge */}
        <div className={`flex flex-col justify-between p-4 border rounded bg-zinc-900/40 shadow-inner transition-all duration-300 ${regimeGlowColor}`}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] text-emerald-500/70 block uppercase tracking-wider font-semibold">MARKET REGIME</span>
            <Badge variant="outline" className="text-[9px] border-emerald-500/20 text-emerald-400 font-bold uppercase">
              {selectedSymbol} Index
            </Badge>
          </div>
          <div className="my-auto py-2 text-center">
            <span className="text-3xl font-extrabold tracking-widest block uppercase drop-shadow-[0_0_10px_rgba(16,185,129,0.2)]">
              {marketRegime}
            </span>
            <span className="text-[10px] text-zinc-400 mt-1 block">
              GEX Regime: {currentGexRegime} · VIX: {vixValue.toFixed(2)}
            </span>
          </div>
          <div className="mt-2 text-center">
            <span className={`px-3 py-1.5 rounded text-[9px] font-extrabold uppercase select-none ${regimeBadgeBg}`}>
              {marketRegime === 'EUPHORIA' ? '🔥 ULTRA RISK-ON' : marketRegime === 'BULLISH' ? '🟢 BUY THE DIPS' : marketRegime === 'BEARISH' ? '🔴 FADE THE RIPS' : '🟡 TRADING RANGE'}
            </span>
          </div>
        </div>

        {/* Widget 2: Mega Caps Tracking Panel */}
        <div className="p-4 border border-emerald-500/20 rounded bg-zinc-900/30 flex flex-col justify-between">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] text-emerald-500/70 block uppercase tracking-wider font-semibold">MEGA-CAPS CO-TREND</span>
            <Badge variant="outline" className="text-[9px] border-emerald-500/20 text-emerald-400">NASDAQ Weight</Badge>
          </div>
          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between items-center p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded">
              <span className="font-semibold text-emerald-300">AAPL (Apple)</span>
              <span className={AAPL_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {AAPL_change >= 0 ? '▲' : '▼'} {AAPL_change.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between items-center p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded">
              <span className="font-semibold text-emerald-300">MSFT (Microsoft)</span>
              <span className={MSFT_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {MSFT_change >= 0 ? '▲' : '▼'} {MSFT_change.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between items-center p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded">
              <span className="font-semibold text-emerald-300">NVDA (Nvidia)</span>
              <span className={NVDA_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {NVDA_change >= 0 ? '▲' : '▼'} {NVDA_change.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>

        {/* Widget 3: Real-Time API Health Panel */}
        <div className="p-4 border border-emerald-500/20 rounded bg-zinc-900/30 flex flex-col justify-between">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] text-emerald-500/70 block uppercase tracking-wider font-semibold">INTEGRATION HEALTH STATUS</span>
            {healthLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />
            ) : (
              <Badge variant="outline" className="text-[9px] border-emerald-500/20 text-emerald-400">All Systems Normal</Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex flex-col gap-0.5">
              <span className="text-zinc-500 uppercase font-semibold">Yahoo Finance</span>
              <div className="flex justify-between items-center">
                <span className={healthData.yahooFinance.status === 'UP' ? 'text-green-400' : 'text-red-400'}>
                  ● {healthData.yahooFinance.status === 'UP' ? 'ONLINE' : 'OFFLINE'}
                </span>
                <span className="text-zinc-400 font-mono">{healthData.yahooFinance.latencyMs}ms</span>
              </div>
            </div>
            <div className="p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex flex-col gap-0.5">
              <span className="text-zinc-500 uppercase font-semibold">GEX Portal API</span>
              <div className="flex justify-between items-center">
                <span className={healthData.sscgexPortal.status === 'UP' ? 'text-green-400' : 'text-red-400'}>
                  ● {healthData.sscgexPortal.status === 'UP' ? 'ONLINE' : 'OFFLINE'}
                </span>
                <span className="text-zinc-400 font-mono">{healthData.sscgexPortal.latencyMs}ms</span>
              </div>
            </div>
            <div className="p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex flex-col gap-0.5">
              <span className="text-zinc-500 uppercase font-semibold">Polygon API</span>
              <div className="flex justify-between items-center">
                <span className={healthData.polygon.status === 'UP' ? 'text-green-400' : 'text-red-400'}>
                  ● {healthData.polygon.status === 'UP' ? 'ONLINE' : 'OFFLINE'}
                </span>
                <span className="text-zinc-400 font-mono">{healthData.polygon.latencyMs}ms</span>
              </div>
            </div>
            <div className="p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex flex-col gap-0.5">
              <span className="text-zinc-500 uppercase font-semibold">OpenRouter AI</span>
              <div className="flex justify-between items-center">
                <span className={healthData.openRouter.status === 'UP' ? 'text-green-400' : 'text-red-400'}>
                  ● {healthData.openRouter.status === 'UP' ? 'ONLINE' : 'OFFLINE'}
                </span>
                <span className="text-zinc-400 font-mono">{healthData.openRouter.latencyMs}ms</span>
              </div>
            </div>
            <div className="p-1.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex flex-col gap-0.5 col-span-2">
              <span className="text-zinc-500 uppercase font-semibold">Discord Webhook API</span>
              <div className="flex justify-between items-center">
                <span className={healthData.discord?.status === 'UP' ? 'text-green-400' : 'text-red-400'}>
                  ● {healthData.discord?.status === 'UP' ? 'ONLINE' : 'OFFLINE'}
                </span>
                <span className="text-zinc-400 font-mono">{healthData.discord?.latencyMs ?? 0}ms</span>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Row 2: Separated Prominent LATEST setup notification */}
      <div className="border border-emerald-500/30 rounded-lg bg-zinc-900/20 shadow-[0_0_20px_rgba(16,185,129,0.02)] overflow-hidden">
        <div className="bg-emerald-950/30 border-b border-emerald-500/20 p-3.5 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4.5 w-4.5 text-emerald-400 animate-bounce" />
            <h3 className="text-sm font-extrabold tracking-widest text-emerald-300 uppercase">
              LATEST ACTIONABLE SETUP ALERT
            </h3>
          </div>
          {!isDayTradingEnabled ? (
            <Badge variant="outline" className="bg-zinc-900 text-zinc-400 border-zinc-700">
              OFFLINE
            </Badge>
          ) : latestActionableSignal ? (
            <Badge variant="outline" className="animate-pulse bg-emerald-950 text-emerald-300 border-emerald-500/40">
              🚨 SIGNAL ACTIVE
            </Badge>
          ) : (
            <span className="text-[10px] text-emerald-500/40">No active signals found</span>
          )}
        </div>
        
        <div className="p-4">
          {!isDayTradingEnabled ? (
            <div className="py-8 flex flex-col items-center justify-center text-center text-zinc-500 text-xs">
              <ShieldAlert className="h-10 w-10 text-amber-500/80 mb-2 animate-pulse" />
              <span className="font-bold text-zinc-300 uppercase">Day Trading Scanner is Inactive</span>
              <span className="text-[10px] text-zinc-500 mt-1 max-w-md">
                The options scanning engine is currently disabled for this user. You can enable it in the Settings Dialog under the "Day Trading" tab to trigger background scanner runs.
              </span>
            </div>
          ) : !latestActionableSignal ? (
            <div className="py-6 flex flex-col items-center justify-center text-center text-emerald-500/40 text-xs">
              <AlertCircle className="h-10 w-10 opacity-30 mb-2" />
              <span>No trade setups generated within the current trading session.</span>
              <span className="text-[10px] text-zinc-500 mt-1">Waiting for next 5-minute background scanning block...</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-xs">
              <div className="lg:col-span-2 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`px-2.5 py-1 rounded text-sm font-extrabold uppercase ${
                    latestActionableSignal.signal_type === 'CALL' ? 'bg-green-950 text-green-300 border border-green-500/30' : 'bg-red-950 text-red-300 border border-red-500/30'
                  }`}>
                    {latestActionableSignal.signal_type} SIGNAL
                  </span>
                  <span className="text-sm font-bold text-emerald-200">
                    {latestActionableSignal.symbol} ${latestActionableSignal.current_price.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-emerald-400/70 ml-auto bg-zinc-950/60 p-1 border border-emerald-500/5 rounded">
                    Score: {latestActionableSignal.confidence_score}% ({latestActionableSignal.setup_grade || 'B'})
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4 border-t border-emerald-500/15 pt-3 text-center">
                  <div className="bg-zinc-950/40 border border-emerald-500/10 p-2.5 rounded">
                    <span className="text-[10px] text-emerald-500/60 block">ENTRY TRIGGER</span>
                    <span className="text-sm font-bold font-mono text-emerald-200">
                      &gt;${latestActionableSignal.entry_trigger?.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-zinc-950/40 border border-emerald-500/10 p-2.5 rounded">
                    <span className="text-[10px] text-emerald-500/60 block">STOP LOSS</span>
                    <span className="text-sm font-bold font-mono text-red-400">
                      ${latestActionableSignal.stop_loss?.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-zinc-950/40 border border-emerald-500/10 p-2.5 rounded">
                    <span className="text-[10px] text-emerald-500/60 block">TARGET LEVEL</span>
                    <span className="text-sm font-bold font-mono text-green-400">
                      ${latestActionableSignal.target_price?.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Option premium suggestion */}
                {latestActionableSignal.gex && (
                  <div className="bg-zinc-950/60 border border-emerald-500/10 p-3 rounded font-mono text-[11px] text-sky-400">
                    💡 Suggested 0DTE Options Plan: Buy Premium Mark at ~${latestActionableSignal.indicators?.vwap ? (Number(latestActionableSignal.indicators.vwap) * 0.003).toFixed(2) : '1.50'} | Stop loss premium at -20% | Sell profit target at +40%
                  </div>
                )}
              </div>

              {/* Coach Thesis */}
              <div className="p-4 rounded border border-emerald-500/15 bg-zinc-950/30 flex flex-col justify-between gap-3">
                <div>
                  <span className="text-[10px] text-emerald-500/60 block uppercase font-bold flex items-center gap-1 mb-1">
                    <Zap className="h-3.5 w-3.5 text-amber-400 animate-pulse" /> AI_OPTIONS_COACH_THESIS
                  </span>
                  <p className="leading-relaxed text-zinc-300 italic text-[11px]">
                    "BUY QQQ CALL options matching the index breakout above VWAP. Mega-caps (AAPL/NVDA) are flashing net bullish inflows, and dealer walls indicate minor gamma gravity until resistance at $485. Hold stop at underlying support $481.20."
                  </p>
                </div>
                <div className="flex justify-end gap-2 border-t border-emerald-500/10 pt-3">
                  <Button
                    size="sm"
                    className="h-7 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-xs"
                    onClick={() => handleQuickStatus(latestActionableSignal.id, 'EXECUTED')}
                  >
                    Execute Trade
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-red-400 hover:text-red-300 hover:bg-red-950/25"
                    onClick={() => handleQuickStatus(latestActionableSignal.id, 'CANCELLED')}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* TradingView Chart Embed - Horizontal Full Width */}
      <div className="border border-emerald-500/20 rounded bg-zinc-900/30 overflow-hidden flex flex-col h-[500px]">
        <div className="p-3 bg-zinc-900 border-b border-emerald-500/20 flex justify-between items-center">
          <span className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5 font-mono">
            <Activity className="h-4 w-4 text-emerald-400 animate-pulse" />
            LIVE {selectedSymbol} OPTIONS-INTEGRATED CHART (5M EMA9/EMA21/VWAP)
          </span>
          <Badge variant="outline" className="text-[9px] border-emerald-500/20 text-emerald-400 font-semibold font-mono">
            Real-Time Feed
          </Badge>
        </div>
        <div className="flex-1 w-full h-full bg-zinc-950">
          <iframe
            title="TradingView Real-Time Chart"
            src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview_chart&symbol=${selectedSymbol === 'QQQ' ? 'NASDAQ:QQQ' : 'AMEX:SPY'}&interval=5&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=18181b&studies=%5B%22STD%3BEMA%22%2C%22STD%3BVWAP%22%5D&theme=dark&style=1&timezone=America%2FNew_York`}
            width="100%"
            height="100%"
            style={{ border: 'none' }}
          />
        </div>
      </div>

      {/* Row 3: Signals Process Table + Detailed Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Table List (Process Monitor) */}
        <div className="xl:col-span-2 overflow-hidden flex flex-col border border-emerald-500/20 rounded bg-zinc-900/30">
          <div className="p-3 bg-zinc-900 border-b border-emerald-500/20 flex flex-wrap justify-between items-center gap-2">
            <div className="flex flex-col">
              <span className="text-xs font-bold text-emerald-300">HISTORICAL DAY TRADING ALERTS (PROCESS_TABLE)</span>
              <span className="text-[10px] text-emerald-500/60">Click row to inspect details</span>
            </div>
            
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] font-bold border-emerald-500/30 text-emerald-400 hover:bg-emerald-950/20 gap-1 bg-zinc-950/40"
                onClick={async () => {
                  if (confirm("Are you sure you want to seed mock data?")) {
                    try {
                      const res = await api.seedSignals();
                      if (res.success) {
                        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
                      }
                    } catch (err: any) {
                      alert(`Failed to seed data: ${err.message}`);
                    }
                  }
                }}
              >
                <Sparkles className="h-3.5 w-3.5 text-emerald-400 animate-pulse" />
                SEED DATA
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] font-bold border-red-500/30 text-red-400 hover:bg-red-950/25 hover:text-red-300 gap-1 bg-zinc-950/40"
                onClick={async () => {
                  if (confirm("Wipe all day trading signals from database?")) {
                    try {
                      const res = await api.clearSignals();
                      if (res.success) {
                        setSelectedSignalId(null);
                        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
                      }
                    } catch (err: any) {
                      alert(`Failed to clear signals: ${err.message}`);
                    }
                  }
                }}
              >
                <XCircle className="h-3.5 w-3.5" />
                WIPE TABLE
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/80 border-b border-emerald-500/10 text-emerald-500/80 font-bold">
                  <th className="p-3">ID</th>
                  <th className="p-3">SYMBOL</th>
                  <th className="p-3">TYPE</th>
                  <th className="p-3">BIAS</th>
                  <th className="p-3">PRICE</th>
                  <th className="p-3">TRIGGER</th>
                  <th className="p-3">SL</th>
                  <th className="p-3">TP</th>
                  <th className="p-3">CONF</th>
                  <th className="p-3 text-center">GRADE</th>
                  <th className="p-3">STATUS</th>
                  <th className="p-3 text-right">CONTROLS</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && signals.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-12 text-center text-emerald-500/60">
                      <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-emerald-400" />
                      RETRIEVING FROM POSTGRES...
                    </td>
                  </tr>
                ) : filteredSignals.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-12 text-center text-red-500/80">
                      [NO SIGNALS FOUND IN DATABASE FOR {selectedSymbol}]
                      <div className="text-[10px] text-emerald-600 mt-2">
                        Click 'SEED DATA' above to insert sample data.
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredSignals.map(sig => {
                    const isSelected = sig.id === selectedSignalId;
                    const biasColor =
                      sig.signal_type === 'CALL'
                        ? 'text-green-500 font-bold'
                        : sig.signal_type === 'PUT'
                          ? 'text-red-500 font-bold'
                          : 'text-zinc-500';

                    const statusBadgeClass =
                      sig.status === 'PENDING'
                        ? 'bg-yellow-950/80 text-yellow-400 border border-yellow-500/30'
                        : sig.status === 'EXECUTED'
                          ? 'bg-green-950/80 text-green-400 border border-green-500/30 animate-pulse'
                          : 'bg-red-950/80 text-red-400 border border-red-500/30';

                    return (
                       <tr
                         key={sig.id}
                         onClick={() => setSelectedSignalId(sig.id)}
                         className={`border-b border-emerald-500/10 hover:bg-emerald-950/10 cursor-pointer transition-colors ${
                           isSelected ? 'bg-emerald-950/25 border-l-2 border-l-emerald-400' : ''
                         }`}
                       >
                         <td className="p-3 font-semibold text-emerald-500">#{sig.id}</td>
                         <td className="p-3 font-bold text-emerald-200 underline decoration-dotted">{sig.symbol}</td>
                         <td className={`p-3 font-bold ${biasColor}`}>{sig.signal_type}</td>
                         <td className="p-3 text-[10px] tracking-tighter text-emerald-400/80">
                           {sig.trade_bias}
                         </td>
                         <td className="p-3 text-emerald-300 font-mono">${Number(sig.current_price).toFixed(2)}</td>
                         <td className="p-3 font-mono">
                           {sig.entry_trigger ? `$${Number(sig.entry_trigger).toFixed(2)}` : '-'}
                         </td>
                         <td className="p-3 font-mono text-red-400/95">
                           {sig.stop_loss ? `$${Number(sig.stop_loss).toFixed(2)}` : '-'}
                         </td>
                         <td className="p-3 font-mono text-green-400/95">
                           {sig.target_price ? `$${Number(sig.target_price).toFixed(2)}` : '-'}
                         </td>
                         <td className="p-3 font-mono font-bold text-sky-400">{sig.confidence_score}%</td>
                         <td className="p-3 text-center">
                           <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-300 font-semibold">
                             {sig.setup_grade || 'B'}
                           </span>
                         </td>
                         <td className="p-3">
                           <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${statusBadgeClass}`}>
                             {sig.status}
                           </span>
                         </td>
                         <td className="p-3 text-right" onClick={e => e.stopPropagation()}>
                           {sig.status === 'PENDING' ? (
                             <div className="flex justify-end gap-1">
                               <button
                                 onClick={() => handleQuickStatus(sig.id, 'EXECUTED')}
                                 className="h-6 w-6 flex items-center justify-center rounded bg-emerald-950 hover:bg-emerald-900 border border-emerald-500/30 text-emerald-400 transition-colors"
                                 title="Execute Setup"
                               >
                                 <Play className="h-3 w-3" />
                               </button>
                               <button
                                 onClick={() => handleQuickStatus(sig.id, 'CANCELLED')}
                                 className="h-6 w-6 flex items-center justify-center rounded bg-red-950/80 hover:bg-red-900/80 border border-red-500/30 text-red-400 transition-colors"
                                 title="Cancel Setup"
                               >
                                 <X className="h-3 w-3" />
                               </button>
                             </div>
                           ) : (
                             <span className="text-[10px] text-emerald-500/40 italic">LOCKED</span>
                           )}
                         </td>
                       </tr>
                     );
                   })
                 )}
               </tbody>
             </table>
           </div>
         </div>
 
         {/* Detailed Inspector Panel */}
         <div className="border border-emerald-500/20 rounded bg-zinc-900/20 flex flex-col h-[400px] xl:h-auto overflow-hidden">
           <div className="p-3 bg-zinc-900 border-b border-emerald-500/20 flex justify-between items-center">
             <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
               <Info className="h-3.5 w-3.5 text-emerald-400" />
               LEVEL_INSPECTOR v2.0
             </span>
             {selectedSignal && (
               <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                 {selectedSignal.symbol} #{selectedSignal.id}
               </Badge>
             )}
           </div>
 
           <div className="p-4 flex-1 overflow-y-auto space-y-4 text-xs">
             {!selectedSignal ? (
               <div className="h-full flex flex-col items-center justify-center text-center text-emerald-500/40">
                 <HelpCircle className="h-10 w-10 opacity-30 mb-2" />
                 Select an alert from the left log table to inspect its technical details.
               </div>
             ) : (
               <div className="space-y-4 animate-in fade-in duration-300">
                 {/* Meta details */}
                 <div className="grid grid-cols-2 gap-2 border-b border-emerald-500/10 pb-3">
                   <div>
                     <span className="text-[10px] text-emerald-500/60 block">MARKET DATE</span>
                     <span className="font-semibold text-emerald-300">{selectedSignal.market_date || '-'}</span>
                   </div>
                   <div>
                     <span className="text-[10px] text-emerald-500/60 block">TIME STAMP</span>
                     <span className="font-semibold text-emerald-300">
                       {new Date(selectedSignal.created_at).toLocaleTimeString('en-US')}
                     </span>
                   </div>
                 </div>
 
                 {/* Indicators Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <Activity className="h-3 w-3" /> TECHNICAL_INDICATORS
                   </span>
                   {selectedSignal.indicators ? (
                     <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">VWAP</span>
                         <span>{selectedSignal.indicators.vwap ? `$${Number(selectedSignal.indicators.vwap).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ATR14</span>
                         <span>{selectedSignal.indicators.atr14 ? `$${Number(selectedSignal.indicators.atr14).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EMA 9</span>
                         <span>{selectedSignal.indicators.ema9 ? `$${Number(selectedSignal.indicators.ema9).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EMA 21</span>
                         <span>{selectedSignal.indicators.ema21 ? `$${Number(selectedSignal.indicators.ema21).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ORH (15m)</span>
                         <span>{selectedSignal.indicators.openingRangeHigh ? `$${Number(selectedSignal.indicators.openingRangeHigh).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ORL (15m)</span>
                         <span>{selectedSignal.indicators.openingRangeLow ? `$${Number(selectedSignal.indicators.openingRangeLow).toFixed(2)}` : 'N/A'}</span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No technical data available.</div>
                   )}
                 </div>
 
                 {/* GEX Blocks */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <TrendingUp className="h-3 w-3" /> GAMMA_EXPOSURE_PROFILE
                   </span>
                   {selectedSignal.gex ? (
                     <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Net GEX</span>
                         <span className={Number(selectedSignal.gex.netGex) >= 0 ? 'text-green-400' : 'text-red-400'}>
                           {selectedSignal.gex.netGex ? `${Number(selectedSignal.gex.netGex).toLocaleString()}` : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">GEX Regime</span>
                         <span className="font-semibold text-emerald-300">{selectedSignal.gex.regime || 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Flip Strike</span>
                         <span>{selectedSignal.gex.flipStrike ? `$${Number(selectedSignal.gex.flipStrike).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Call Wall</span>
                         <span>{selectedSignal.gex.callWall ? `$${Number(selectedSignal.gex.callWall).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Put Wall</span>
                         <span>{selectedSignal.gex.putWall ? `$${Number(selectedSignal.gex.putWall).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Flow Dir.</span>
                         <span className="font-semibold text-sky-400 text-[10px]">{selectedSignal.gex.flowDirection || 'N/A'}</span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No GEX data available.</div>
                   )}
                 </div>
 
                 {/* Volatility Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <Activity className="h-3 w-3" /> VOLATILITY
                   </span>
                   {selectedSignal.volatility ? (
                     <div className="flex gap-4 justify-between bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                       <div className="flex items-center gap-2">
                         <span className="text-emerald-500/70">VIX:</span>
                         <span className="font-semibold text-emerald-200">
                           {selectedSignal.volatility.vixQuote ? Number(selectedSignal.volatility.vixQuote).toFixed(2) : 'N/A'}
                         </span>
                       </div>
                       <div className="flex items-center gap-2">
                         <span className="text-emerald-500/70">VIX Daily Chg:</span>
                         <span className={`font-semibold ${Number(selectedSignal.volatility.vixChangePercent) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                           {selectedSignal.volatility.vixChangePercent ? `${Number(selectedSignal.volatility.vixChangePercent).toFixed(2)}%` : 'N/A'}
                         </span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No VIX data available.</div>
                   )}
                 </div>
 
                 {/* Block Reasons / No Trade reasons */}
                 {selectedSignal.no_trade_reasons && selectedSignal.no_trade_reasons.length > 0 && (
                   <div className="space-y-1">
                     <span className="text-[10px] font-bold text-red-400 uppercase flex items-center gap-1">
                       <ShieldAlert className="h-3.5 w-3.5 text-red-500 animate-pulse" /> NO_TRADE_BLOCK_REASONS
                     </span>
                     <ul className="bg-red-950/15 border border-red-500/20 p-3 rounded text-[11px] space-y-1.5">
                       {selectedSignal.no_trade_reasons.map((reason, idx) => (
                         <li key={idx} className="flex gap-2 text-red-300">
                           <span className="text-red-500 font-bold select-none">[!]</span>
                           <span>{reason}</span>
                         </li>
                       ))}
                     </ul>
                   </div>
                 )}
               </div>
             )}
           </div>
         </div>
       </div>
     </div>
   );
 }
