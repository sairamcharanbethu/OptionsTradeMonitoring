import React, { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import { 
  Activity, 
  BrainCircuit, 
  SlidersHorizontal, 
  TrendingUp, 
  AlertTriangle, 
  Zap, 
  ShieldAlert, 
  History, 
  Cpu, 
  RefreshCw,
  Loader2,
  DollarSign
} from 'lucide-react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip
} from 'recharts';

export default function AutoTraderDashboard() {
  const [settings, setSettings] = useState<{ mode: 'simulation' | 'live'; maxContracts: number } | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Integration Health Check States
  const [healthCheck, setHealthCheck] = useState<any>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  // Tab State
  const [activeTab, setActiveTab] = useState<'live' | 'backtest'>('live');

  // Backtest States
  const [backtestSymbol, setBacktestSymbol] = useState<'SPY' | 'QQQ'>('SPY');
  const [backtestStartDate, setBacktestStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [backtestEndDate, setBacktestEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  });
  const [backtestMode, setBacktestMode] = useState<'rule-based' | 'ai'>('rule-based');
  const [backtestContractSize, setBacktestContractSize] = useState(5);
  const [backtestResults, setBacktestResults] = useState<any>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  const fetchHealthCheck = async () => {
    setIsCheckingHealth(true);
    try {
      const data = await api.getAutoTraderHealth();
      setHealthCheck(data);
    } catch (err) {
      console.error('[Health Check] Failed:', err);
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const fetchData = async () => {
    try {
      const [sData, statusData] = await Promise.all([
        api.getAutoTraderSettings(),
        api.getAutoTraderStatus()
      ]);
      setSettings(sData);
      setStatus(statusData);
      setError(null);
    } catch (err: any) {
      console.error(err);
      setError('Failed to fetch Auto Trader system status.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    fetchHealthCheck();
    const interval = setInterval(() => {
      fetchData();
      fetchHealthCheck();
    }, 15000); // Poll every 15s
    return () => clearInterval(interval);
  }, []);

  const handleModeToggle = async () => {
    if (!settings) return;
    const nextMode = settings.mode === 'simulation' ? 'live' : 'simulation';
    
    if (nextMode === 'live') {
      // Prompt safety confirm modal
      setShowLiveConfirm(true);
    } else {
      await updateSettings('simulation', settings.maxContracts);
    }
  };

  const handleLiveConfirm = async () => {
    setShowLiveConfirm(false);
    if (!settings) return;
    await updateSettings('live', settings.maxContracts);
  };

  const handleContractSliderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!settings) return;
    const val = parseInt(e.target.value, 10);
    setSettings({ ...settings, maxContracts: val });
  };

  const handleContractSliderRelease = async () => {
    if (!settings) return;
    await updateSettings(settings.mode, settings.maxContracts);
  };

  const updateSettings = async (mode: 'simulation' | 'live', maxContracts: number) => {
    setIsUpdatingSettings(true);
    try {
      await api.updateAutoTraderSettings(mode, maxContracts);
      const updated = await api.getAutoTraderSettings();
      setSettings(updated);
    } catch (err: any) {
      console.error(err);
      alert('Failed to update Auto Trader settings: ' + err.message);
      // Revert local state
      fetchData();
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const handleManualTrigger = async () => {
    setIsScanning(true);
    try {
      const result = await api.triggerAutoTraderScan();
      if (result.success && result.executedTrades.length > 0) {
        alert(`Scan complete! Executed ${result.executedTrades.length} trade(s).`);
      } else {
        alert('Scan complete! No matching option trade setups detected.');
      }
      await fetchData();
    } finally {
      setIsScanning(false);
    }
  };

  const handleRunBacktest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBacktestLoading(true);
    setBacktestError(null);
    setBacktestResults(null);
    
    const start = new Date(backtestStartDate);
    const end = new Date(backtestEndDate);
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1024 * 60 * 60 * 24));
    
    if (backtestMode === 'ai' && diffDays > 7) {
      setBacktestError('AI Decision Mode is strictly limited to a maximum of 7 trading days to safeguard against high token usage.');
      setBacktestLoading(false);
      return;
    }
    
    if (start >= end) {
      setBacktestError('Start date must be before the end date.');
      setBacktestLoading(false);
      return;
    }

    try {
      const results = await api.runBacktest(
        backtestSymbol,
        backtestStartDate,
        backtestEndDate,
        backtestMode,
        backtestContractSize
      );
      setBacktestResults(results);
    } catch (err: any) {
      console.error(err);
      setBacktestError(err.message || 'Failed to complete historical backtest.');
    } finally {
      setBacktestLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin mb-4" />
        <p>Initializing Quantitative Auto-Trader Dashboard...</p>
      </div>
    );
  }

  if (error || !settings || !status) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-red-500">
        <AlertTriangle className="h-8 w-8 mb-4" />
        <p>{error || 'System is currently unavailable.'}</p>
      </div>
    );
  }

  const isLive = settings.mode === 'live';
  const marketOpen = status.marketOpen;

  // Render relative price index bar relative to Put Wall (Min) and Call Wall (Max)
  const renderGexBar = (spot: number, putWall: number, flip: number, callWall: number) => {
    const min = Math.min(spot, putWall, flip, callWall) - 2;
    const max = Math.max(spot, putWall, flip, callWall) + 2;
    const range = max - min;

    const getPercent = (val: number) => ((val - min) / range) * 100;

    const spotPercent = getPercent(spot);
    const putPercent = getPercent(putWall);
    const flipPercent = getPercent(flip);
    const callPercent = getPercent(callWall);

    return (
      <div className="space-y-2 mt-4">
        <div className="text-[10px] text-muted-foreground flex justify-between">
          <span>Put Wall: ${putWall.toFixed(2)}</span>
          <span className="font-semibold text-slate-500">Flip: ${flip.toFixed(2)}</span>
          <span>Call Wall: ${callWall.toFixed(2)}</span>
        </div>
        <div className="relative h-3 bg-muted rounded-full overflow-visible">
          {/* Put Wall line */}
          <div className="absolute h-full w-1 bg-red-400 rounded" style={{ left: `${putPercent}%` }} title="Put Wall" />
          {/* Flip line */}
          <div className="absolute h-full w-0.5 bg-yellow-400" style={{ left: `${flipPercent}%` }} title="Gamma Flip" />
          {/* Call Wall line */}
          <div className="absolute h-full w-1 bg-green-400 rounded" style={{ left: `${callPercent}%` }} title="Call Wall" />
          
          {/* Spot price glowing indicator */}
          <div 
            className={`absolute -top-1 w-5 h-5 -ml-2.5 rounded-full border-2 border-background flex items-center justify-center shadow-lg transition-all ${
              spot > flip ? 'bg-indigo-500 shadow-indigo-500/50' : 'bg-rose-500 shadow-rose-500/50'
            }`} 
            style={{ left: `${spotPercent}%` }}
            title={`Spot Price: $${spot.toFixed(2)}`}
          >
            <div className="w-1.5 h-1.5 bg-white rounded-full animate-ping" />
          </div>
        </div>
        <div className="text-[10px] text-center font-bold" style={{ color: spot > flip ? '#6366f1' : '#f43f5e' }}>
          Spot: ${spot.toFixed(2)} ({spot > flip ? 'Positive Gamma Regime' : 'Negative Gamma Regime'})
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-5 rounded-xl border shadow-sm relative overflow-hidden">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
              <Cpu className="h-6 w-6 text-indigo-500 animate-pulse" />
              AI Auto Option Trader
            </h2>
            {isLive ? (
              <Badge className="bg-red-500/10 text-red-500 border-red-500/30 gap-1 animate-pulse px-2 py-0.5 text-xs font-bold shadow-lg shadow-red-500/15">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                LIVE TRADING
              </Badge>
            ) : (
              <Badge className="bg-indigo-500/10 text-indigo-500 border-indigo-500/30 gap-1 px-2 py-0.5 text-xs font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
                SIMULATION
              </Badge>
            )}
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 max-w-[600px]">
            Quantitative options day trading system targeting SPY & QQQ. Day trades 0 DTE contracts before 1 PM ET (10% SL) and 1 DTE after 1 PM ET. Fully flat overnight.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { fetchData(); fetchHealthCheck(); }} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button 
            variant="default" 
            size="sm" 
            onClick={handleManualTrigger} 
            disabled={isScanning || !marketOpen} 
            className="gap-2 bg-indigo-600 hover:bg-indigo-700 shadow-md shadow-indigo-600/25"
          >
            {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {isScanning ? 'Scanning...' : 'Scan Now'}
          </Button>
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 p-1 rounded-xl">
        <button
          onClick={() => setActiveTab('live')}
          className={`flex-1 py-2.5 px-4 text-xs sm:text-sm font-extrabold rounded-lg transition-all flex items-center justify-center gap-2 ${
            activeTab === 'live'
              ? 'bg-indigo-600 text-white shadow shadow-indigo-600/25'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Activity className="h-4 w-4" />
          Live Monitor & Control
        </button>
        <button
          onClick={() => setActiveTab('backtest')}
          className={`flex-1 py-2.5 px-4 text-xs sm:text-sm font-extrabold rounded-lg transition-all flex items-center justify-center gap-2 ${
            activeTab === 'backtest'
              ? 'bg-indigo-600 text-white shadow shadow-indigo-600/25'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <History className="h-4 w-4" />
          Historical Backtesting Hub
        </button>
      </div>

      {activeTab === 'live' ? (
        <>
          {/* Control Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Settings Control Panel */}
            <Card className="lg:col-span-1 border-slate-200 dark:border-slate-800">
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-md flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                  <SlidersHorizontal className="h-5 w-5 text-indigo-500" />
                  Bot Control Center
                </CardTitle>
                <CardDescription className="text-xs">Configure trading boundaries and sizing parameters.</CardDescription>
              </CardHeader>
              <CardContent className="p-5 space-y-6">
                
                {/* Paper vs Live Toggle Switch */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Execution Mode</label>
                  <div className="flex items-center justify-between p-3 rounded-lg border bg-slate-50/50 dark:bg-slate-900/50">
                    <div className="flex flex-col">
                      <span className="text-sm font-bold">{isLive ? 'Live Money Brokerage' : 'Paper Trading (Simulated)'}</span>
                      <span className="text-xs text-muted-foreground">{isLive ? 'Trades executed directly via SnapTrade' : 'Orders simulated using real market data'}</span>
                    </div>
                    {/* Custom switch */}
                    <button
                      onClick={handleModeToggle}
                      disabled={isUpdatingSettings}
                      className={`w-12 h-6 flex items-center rounded-full p-1 cursor-pointer transition-all duration-300 ${
                        isLive ? 'bg-red-500 shadow-md shadow-red-500/20' : 'bg-indigo-500 shadow-md shadow-indigo-500/20'
                      }`}
                    >
                      <div
                        className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-300 ${
                          isLive ? 'translate-x-6' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Contract Size Slider */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Contracts per Trade</label>
                    <span className="text-sm font-extrabold text-indigo-600 bg-indigo-500/10 px-2 py-0.5 rounded-full">{settings.maxContracts} Contracts</span>
                  </div>
                  <div className="p-4 rounded-lg border bg-slate-50/50 dark:bg-slate-900/50 space-y-4">
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={settings.maxContracts}
                      onChange={handleContractSliderChange}
                      onMouseUp={handleContractSliderRelease}
                      onTouchEnd={handleContractSliderRelease}
                      disabled={isUpdatingSettings}
                      className="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground font-semibold">
                      <span>1 Contract (Low Risk)</span>
                      <span>10 Contracts (Max Limit)</span>
                    </div>
                  </div>
                </div>

                {/* System Status Indicators */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Operational Status</label>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 rounded-lg border bg-slate-50/50 dark:bg-slate-900/50 flex flex-col text-center items-center justify-center">
                      <Activity className={`h-5 w-5 mb-1 ${marketOpen ? 'text-green-500 animate-pulse' : 'text-slate-400'}`} />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Market State</span>
                      <span className="text-xs font-bold mt-1">{marketOpen ? 'OPEN' : 'CLOSED'}</span>
                    </div>
                    <div className="p-3 rounded-lg border bg-slate-50/50 dark:bg-slate-900/50 flex flex-col text-center items-center justify-center">
                      <BrainCircuit className="h-5 w-5 mb-1 text-indigo-500" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Daily Trades</span>
                      <span className="text-xs font-bold mt-1">{status.todayTradesCount} / 3 taken</span>
                    </div>
                  </div>
                </div>

                {/* Health Check Status Panel */}
                <div className="space-y-2 pt-4 border-t">
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Integrations Health</label>
                    {isCheckingHealth ? (
                      <span className="text-[10px] text-muted-foreground animate-pulse">Checking...</span>
                    ) : healthCheck?.status ? (
                      <Badge 
                        variant="outline" 
                        className={`text-[10px] font-extrabold px-1.5 py-0 ${
                          healthCheck.status === 'HEALTHY' 
                            ? 'bg-green-500/10 text-green-500 border-green-500/20' 
                            : healthCheck.status === 'DEGRADED'
                            ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
                            : 'bg-red-500/10 text-red-500 border-red-500/20'
                        }`}
                      >
                        {healthCheck.status}
                      </Badge>
                    ) : null}
                  </div>

                  {healthCheck?.services ? (
                    <div className="space-y-2 text-xs">
                      {/* Database */}
                      <div className="flex justify-between items-center p-2 rounded border bg-slate-50/30 dark:bg-slate-900/10">
                        <span className="font-semibold text-slate-600 dark:text-slate-400">Database</span>
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${healthCheck.services.database?.status === 'HEALTHY' ? 'bg-green-500' : 'bg-red-500'}`} />
                          <span className="font-bold text-slate-700 dark:text-slate-300">
                            {healthCheck.services.database?.status === 'HEALTHY' ? `${healthCheck.services.database.latencyMs}ms` : 'Offline'}
                          </span>
                        </div>
                      </div>

                      {/* Redis */}
                      <div className="flex justify-between items-center p-2 rounded border bg-slate-50/30 dark:bg-slate-900/10">
                        <span className="font-semibold text-slate-600 dark:text-slate-400">Redis Cache</span>
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${healthCheck.services.redis?.status === 'HEALTHY' ? 'bg-green-500' : 'bg-red-500'}`} />
                          <span className="font-bold text-slate-700 dark:text-slate-300">
                            {healthCheck.services.redis?.status === 'HEALTHY' ? `${healthCheck.services.redis.latencyMs}ms` : 'Offline'}
                          </span>
                        </div>
                      </div>

                      {/* Questrade */}
                      <div className="flex justify-between items-center p-2 rounded border bg-slate-50/30 dark:bg-slate-900/10">
                        <span className="font-semibold text-slate-600 dark:text-slate-400">Questrade Feed</span>
                        <div className="flex items-center gap-1.5">
                          <span 
                            className={`w-2 h-2 rounded-full ${
                              healthCheck.services.questrade?.status === 'HEALTHY' 
                                ? 'bg-green-500' 
                                : healthCheck.services.questrade?.status === 'UNCONFIGURED' 
                                ? 'bg-amber-400' 
                                : 'bg-red-500'
                            }`} 
                          />
                          <span className="font-bold text-slate-700 dark:text-slate-300">
                            {healthCheck.services.questrade?.status === 'HEALTHY' 
                              ? `${healthCheck.services.questrade.latencyMs}ms` 
                              : healthCheck.services.questrade?.status === 'UNCONFIGURED'
                              ? 'Unlinked'
                              : 'Offline'}
                          </span>
                        </div>
                      </div>

                      {/* SnapTrade */}
                      <div className="flex justify-between items-center p-2 rounded border bg-slate-50/30 dark:bg-slate-900/10">
                        <span className="font-semibold text-slate-600 dark:text-slate-400">SnapTrade API</span>
                        <div className="flex items-center gap-1.5">
                          <span 
                            className={`w-2 h-2 rounded-full ${
                              healthCheck.services.snaptrade?.status === 'HEALTHY' 
                                ? 'bg-green-500' 
                                : healthCheck.services.snaptrade?.status === 'UNCONFIGURED' 
                                ? 'bg-amber-400' 
                                : 'bg-red-500'
                            }`} 
                          />
                          <span className="font-bold text-slate-700 dark:text-slate-300">
                            {healthCheck.services.snaptrade?.status === 'HEALTHY' 
                              ? `${healthCheck.services.snaptrade.latencyMs}ms` 
                              : healthCheck.services.snaptrade?.status === 'UNCONFIGURED'
                              ? 'Unconfigured'
                              : 'Offline'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground text-center py-2">
                      Loading integrations health logs...
                    </div>
                  )}
                </div>

              </CardContent>
            </Card>

            {/* GEX & Gamma Exposures Monitor */}
            <Card className="lg:col-span-2 border-slate-200 dark:border-slate-800">
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-md flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                  <TrendingUp className="h-5 w-5 text-green-500" />
                  Quantitative Market Regimes (SPY & QQQ GEX)
                </CardTitle>
                <CardDescription className="text-xs">Dynamic dealer hedging levels & Gamma Walls fetched from option chains.</CardDescription>
              </CardHeader>
              <CardContent className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* SPY GEX CARD */}
                <div className="p-4 rounded-xl border bg-slate-50/30 dark:bg-slate-900/10 space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b">
                    <span className="font-extrabold text-sm text-indigo-600">SPY GEX PROFILE</span>
                    <Badge variant="outline" className={status.gex?.SPY?.netGex >= 0 ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}>
                      {status.gex?.SPY?.netGex >= 0 ? 'Positive GEX' : 'Negative GEX'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-muted-foreground">Net GEX:</span>
                      <div className="font-bold text-sm text-slate-700 dark:text-slate-300">
                        ${(status.gex?.SPY?.netGex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Gamma Flip:</span>
                      <div className="font-bold text-sm text-slate-700 dark:text-slate-300">${Number(status.gex?.SPY?.gammaFlip).toFixed(2)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Net Vanna (VEX):</span>
                      <div className={`font-bold text-xs ${status.gex?.SPY?.netVex >= 0 ? 'text-indigo-500' : 'text-rose-500'}`}>
                        ${(status.gex?.SPY?.netVex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}/vol
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Net Charm (CEX):</span>
                      <div className={`font-bold text-xs ${status.gex?.SPY?.netCex >= 0 ? 'text-emerald-500' : 'text-orange-500'}`}>
                        ${(status.gex?.SPY?.netCex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}/day
                      </div>
                    </div>
                  </div>
                  {renderGexBar(
                    Number(status.gex?.SPY?.spotPrice),
                    Number(status.gex?.SPY?.putWall),
                    Number(status.gex?.SPY?.gammaFlip),
                    Number(status.gex?.SPY?.callWall)
                  )}
                </div>

                {/* QQQ GEX CARD */}
                <div className="p-4 rounded-xl border bg-slate-50/30 dark:bg-slate-900/10 space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b">
                    <span className="font-extrabold text-sm text-indigo-600">QQQ GEX PROFILE</span>
                    <Badge variant="outline" className={status.gex?.QQQ?.netGex >= 0 ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}>
                      {status.gex?.QQQ?.netGex >= 0 ? 'Positive GEX' : 'Negative GEX'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-muted-foreground">Net GEX:</span>
                      <div className="font-bold text-sm text-slate-700 dark:text-slate-300">
                        ${(status.gex?.QQQ?.netGex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Gamma Flip:</span>
                      <div className="font-bold text-sm text-slate-700 dark:text-slate-300">${Number(status.gex?.QQQ?.gammaFlip).toFixed(2)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Net Vanna (VEX):</span>
                      <div className={`font-bold text-xs ${status.gex?.QQQ?.netVex >= 0 ? 'text-indigo-500' : 'text-rose-500'}`}>
                        ${(status.gex?.QQQ?.netVex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}/vol
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Net Charm (CEX):</span>
                      <div className={`font-bold text-xs ${status.gex?.QQQ?.netCex >= 0 ? 'text-emerald-500' : 'text-orange-500'}`}>
                        ${(status.gex?.QQQ?.netCex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}/day
                      </div>
                    </div>
                  </div>
                  {renderGexBar(
                    Number(status.gex?.QQQ?.spotPrice),
                    Number(status.gex?.QQQ?.putWall),
                    Number(status.gex?.QQQ?.gammaFlip),
                    Number(status.gex?.QQQ?.callWall)
                  )}
                </div>

              </CardContent>
            </Card>
          </div>

          {/* Decision & Trade Audit Logs */}
          <Card>
            <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-md flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                  <History className="h-5 w-5 text-indigo-500" />
                  Intraday Decision Audit Logs
                </CardTitle>
                <CardDescription className="text-xs">Trace of executed option trades and corresponding AI rationales today.</CardDescription>
              </div>
              <Badge className="bg-indigo-500/10 text-indigo-500 border-indigo-500/20">{status.trades?.length || 0} Trades</Badge>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b">
                    <tr>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Symbol</th>
                      <th className="px-4 py-3">Details</th>
                      <th className="px-4 py-3 text-right">Contracts</th>
                      <th className="px-4 py-3 text-right">Entry</th>
                      <th className="px-4 py-3 text-right">Status</th>
                      <th className="px-4 py-3 text-right">PnL</th>
                      <th className="px-4 py-3">AI Rationale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.trades?.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="text-center py-10 text-muted-foreground">
                          No trades executed today. Scans run automatically.
                        </td>
                      </tr>
                    ) : (
                      status.trades?.map((trade: any) => {
                        const time = new Date(trade.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        return (
                          <tr key={trade.id} className="border-b hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-3 font-semibold text-slate-600">{time}</td>
                            <td className="px-4 py-3">
                              <span className="font-extrabold text-indigo-600 block">{trade.symbol}</span>
                              <span className="text-[10px] text-muted-foreground uppercase">{trade.isSimulated ? 'Simulation' : 'Live'}</span>
                            </td>
                            <td className="px-4 py-3 font-medium">
                              <span className={trade.optionType === 'CALL' ? 'text-green-500' : 'text-rose-500'}>{trade.optionType}</span>
                              {` $${trade.strikePrice} exp ${new Date(trade.expirationDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}`}
                            </td>
                            <td className="px-4 py-3 text-right font-bold">{trade.quantity}</td>
                            <td className="px-4 py-3 text-right text-muted-foreground">${Number(trade.entryPrice).toFixed(2)}</td>
                            <td className="px-4 py-3 text-right">
                              <Badge variant="outline" className={trade.status === 'CLOSED' ? 'bg-slate-100 text-slate-700' : 'bg-green-500/10 text-green-500 border-green-500/20 animate-pulse'}>
                                {trade.status}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-right">
                              {trade.status === 'CLOSED' ? (
                                <div className={`font-extrabold ${trade.realizedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                  ${trade.realizedPnl?.toFixed(2)}
                                </div>
                              ) : (
                                <span className="text-slate-400 font-bold">-</span>
                              )}
                            </td>
                            <td className="px-4 py-3 max-w-[300px] text-xs text-muted-foreground italic truncate" title={trade.notes || 'N/A'}>
                              {trade.notes || 'Auto-scan fill confirmed.'}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          {/* Backtesting Configuration Form */}
          <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-md flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                <SlidersHorizontal className="h-5 w-5 text-indigo-500" />
                Backtest Configuration Center
              </CardTitle>
              <CardDescription className="text-xs">
                Configure historical options day trading rules, sizing, and backtesting range.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5">
              <form onSubmit={handleRunBacktest} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  {/* Symbol */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Underlying Asset</label>
                    <select
                      value={backtestSymbol}
                      onChange={(e) => setBacktestSymbol(e.target.value as 'SPY' | 'QQQ')}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="SPY">SPY (S&P 500 ETF)</option>
                      <option value="QQQ">QQQ (Nasdaq 100 ETF)</option>
                    </select>
                  </div>
                  
                  {/* Date range inputs */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Start Date</label>
                    <input
                      type="date"
                      value={backtestStartDate}
                      onChange={(e) => setBacktestStartDate(e.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      required
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">End Date</label>
                    <input
                      type="date"
                      value={backtestEndDate}
                      onChange={(e) => setBacktestEndDate(e.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      required
                    />
                  </div>

                  {/* Mode */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Execution Mode</label>
                    <select
                      value={backtestMode}
                      onChange={(e) => setBacktestMode(e.target.value as 'rule-based' | 'ai')}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="rule-based">Rule-Based Solver (Fast & Free)</option>
                      <option value="ai">AI Decision Engine (Claude 3.5 Sonnet)</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-col md:flex-row justify-between items-center gap-6 pt-2">
                  {/* Sizer */}
                  <div className="w-full md:w-1/2 space-y-1">
                    <div className="flex justify-between text-xs font-bold text-slate-500">
                      <span>CONTRACT SIZE PER TRADE</span>
                      <span className="text-indigo-500 font-extrabold">{backtestContractSize} Contracts</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={backtestContractSize}
                      onChange={(e) => setBacktestContractSize(parseInt(e.target.value, 10))}
                      className="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                    />
                  </div>
                  
                  <div className="w-full md:w-auto flex justify-end">
                    <Button
                      type="submit"
                      disabled={backtestLoading}
                      className="w-full md:w-auto bg-indigo-600 hover:bg-indigo-700 text-white shadow-md shadow-indigo-600/25 gap-2 px-6"
                    >
                      {backtestLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Running Simulation...
                        </>
                      ) : (
                        <>
                          <Zap className="h-4 w-4" />
                          Run Historical Backtest
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {backtestMode === 'ai' && (
                  <div className="p-3 bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 text-xs text-yellow-800 dark:text-yellow-400 rounded-lg flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">AI Execution Limit Warning:</span> To prevent excessive OpenRouter API costs and rate limits, AI Mode scans are strictly restricted to a maximum date range of <strong>7 trading days</strong>. Rule-Based solver is unlimited up to the 60-day historical limit.
                    </div>
                  </div>
                )}

                {backtestMode === 'rule-based' && (
                  <div className="p-3 bg-indigo-50 dark:bg-indigo-950/20 border border-indigo-200 text-xs text-indigo-800 dark:text-indigo-400 rounded-lg flex items-start gap-2">
                    <BrainCircuit className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">Rule-Based Solver Mode:</span> Runs instantaneous historical scanning over the last 30-180 days using mathematical GEX regressive walls and technical indicator crossovers. Free and optimized. (Note: Yahoo Finance stores 15-minute intraday bars for up to 60 days max).
                    </div>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {backtestError && (
            <div className="p-4 bg-rose-50 dark:bg-rose-950/20 border border-rose-200 text-sm text-rose-800 dark:text-rose-400 rounded-lg flex items-center gap-2 shadow-sm">
              <AlertTriangle className="h-5 w-5 text-rose-500 shrink-0" />
              <span>{backtestError}</span>
            </div>
          )}

          {backtestResults && (
            <div className="space-y-6 animate-fade-in">
              {/* Summary Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                {/* PnL Card */}
                <Card className="bg-card border-slate-200 dark:border-slate-800 overflow-hidden relative shadow-sm">
                  <div className={`absolute top-0 left-0 w-full h-1 ${backtestResults.totalReturn >= 0 ? 'bg-green-500' : 'bg-red-500'}`} />
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Net Return</span>
                    <span className={`text-lg font-black mt-2 ${backtestResults.totalReturn >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {backtestResults.totalReturn >= 0 ? '+' : ''}${backtestResults.totalReturn.toFixed(2)}
                    </span>
                    <span className={`text-[10px] font-bold mt-1 ${backtestResults.totalReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      ({backtestResults.totalReturnPct.toFixed(2)}%)
                    </span>
                  </CardContent>
                </Card>

                {/* Win Rate */}
                <Card className="bg-card border-slate-200 dark:border-slate-800 overflow-hidden relative shadow-sm">
                  <div className="absolute top-0 left-0 w-full h-1 bg-indigo-500" />
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Win Rate</span>
                    <span className="text-lg font-black text-indigo-500 mt-2">
                      {backtestResults.winRate.toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-1 font-semibold">
                      {backtestResults.wins}W – {backtestResults.losses}L
                    </span>
                  </CardContent>
                </Card>

                {/* Profit Factor */}
                <Card className="bg-card border-slate-200 dark:border-slate-800 overflow-hidden relative shadow-sm">
                  <div className={`absolute top-0 left-0 w-full h-1 ${backtestResults.profitFactor >= 1.5 ? 'bg-green-500' : backtestResults.profitFactor >= 1 ? 'bg-yellow-500' : 'bg-red-500'}`} />
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Profit Factor</span>
                    <span className="text-lg font-black text-slate-800 dark:text-slate-200 mt-2">
                      {backtestResults.profitFactor.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-1 font-semibold">
                      Gains / Losses ratio
                    </span>
                  </CardContent>
                </Card>

                {/* Max Drawdown */}
                <Card className="bg-card border-slate-200 dark:border-slate-800 overflow-hidden relative shadow-sm">
                  <div className="absolute top-0 left-0 w-full h-1 bg-red-400" />
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Max Drawdown</span>
                    <span className="text-lg font-black text-red-500 mt-2">
                      -{backtestResults.maxDrawdown.toFixed(2)}%
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-1 font-semibold">
                      Peak-to-trough decline
                    </span>
                  </CardContent>
                </Card>

                {/* Trades Count */}
                <Card className="bg-card border-slate-200 dark:border-slate-800 overflow-hidden relative shadow-sm">
                  <div className="absolute top-0 left-0 w-full h-1 bg-slate-400" />
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Trades Taken</span>
                    <span className="text-lg font-black text-slate-700 dark:text-slate-300 mt-2">
                      {backtestResults.tradesCount}
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-1 font-semibold">
                      Total roundtrips
                    </span>
                  </CardContent>
                </Card>

                {/* Final Capital */}
                <Card className="bg-card border-slate-200 dark:border-slate-800 overflow-hidden relative shadow-sm">
                  <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500" />
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Final Balance</span>
                    <span className="text-lg font-black text-emerald-500 mt-2">
                      ${backtestResults.finalCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="text-[10px] text-muted-foreground mt-1 font-semibold">
                      Start: $10,000.00
                    </span>
                  </CardContent>
                </Card>
              </div>

              {/* Equity Curve Chart */}
              <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
                <CardHeader className="pb-3 border-b">
                  <CardTitle className="text-md flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                    <TrendingUp className="h-5 w-5 text-indigo-500" />
                    Simulated Equity Curve (Capital Growth)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Roundtrip portfolio equity chart starting from $10,000 initial capital.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-5">
                  {backtestResults.equityCurve && backtestResults.equityCurve.length > 0 ? (
                    <div className="h-72 w-full mt-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={[{ date: 'Start', pnl: 0, capital: 10000 }, ...backtestResults.equityCurve]}>
                          <defs>
                            <linearGradient id="colorCapital" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(200, 200, 200, 0.15)" />
                          <XAxis dataKey="date" stroke="#888888" fontSize={10} tickLine={false} axisLine={false} />
                          <YAxis 
                            stroke="#888888" 
                            fontSize={10} 
                            tickLine={false} 
                            axisLine={false} 
                            domain={['dataMin - 500', 'dataMax + 500']}
                            tickFormatter={(value) => `$${value}`}
                          />
                          <RechartsTooltip 
                            contentStyle={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', border: 'none', borderRadius: '8px', color: '#fff' }}
                            formatter={(value: any) => [`$${parseFloat(value).toFixed(2)}`, 'Portfolio Equity']}
                          />
                          <Area type="monotone" dataKey="capital" stroke="#6366f1" strokeWidth={2} fillOpacity={1} fill="url(#colorCapital)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="text-center py-10 text-muted-foreground text-sm">
                      No equity intervals logged.
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Trades Ledger */}
              <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
                <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-md flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                      <History className="h-5 w-5 text-indigo-500" />
                      Historical Trade Ledger
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Exhaustive ledger of all theoretical trades simulated.
                    </CardDescription>
                  </div>
                  <Badge className="bg-indigo-500/10 text-indigo-500 border-indigo-500/20">
                    {backtestResults.trades?.length || 0} Simulated Trades
                  </Badge>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b">
                        <tr>
                          <th className="px-4 py-3">Date</th>
                          <th className="px-4 py-3">Times (ET)</th>
                          <th className="px-4 py-3">Option Spec</th>
                          <th className="px-4 py-3 text-right">Entry Prem</th>
                          <th className="px-4 py-3 text-right">Exit Prem</th>
                          <th className="px-4 py-3 text-right">ROI</th>
                          <th className="px-4 py-3 text-right">PnL</th>
                          <th className="px-4 py-3">Exit Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResults.trades?.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="text-center py-10 text-muted-foreground">
                              No setups matched execution criteria during this historical window.
                            </td>
                          </tr>
                        ) : (
                          backtestResults.trades?.map((trade: any, idx: number) => (
                            <React.Fragment key={idx}>
                              <tr className="border-b hover:bg-slate-50/50 transition-colors">
                                <td className="px-4 py-3 font-semibold text-slate-600">{trade.date}</td>
                                <td className="px-4 py-3 text-xs text-muted-foreground">
                                  {trade.entryTime} → {trade.exitTime}
                                </td>
                                <td className="px-4 py-3 font-medium">
                                  <span className={trade.optionType === 'CALL' ? 'text-green-500 font-bold' : 'text-rose-500 font-bold'}>
                                    {trade.optionType}
                                  </span>
                                  {` $${trade.strike} (${trade.dte})`}
                                </td>
                                <td className="px-4 py-3 text-right text-slate-600">${trade.entryPrice.toFixed(2)}</td>
                                <td className="px-4 py-3 text-right text-slate-600">${trade.exitPrice.toFixed(2)}</td>
                                <td className={`px-4 py-3 text-right font-bold text-xs ${trade.roi >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                  {trade.roi >= 0 ? '+' : ''}{trade.roi.toFixed(1)}%
                                </td>
                                <td className={`px-4 py-3 text-right font-extrabold ${trade.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                  {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                                </td>
                                <td className="px-4 py-3 text-xs font-semibold text-slate-600">{trade.exitReason}</td>
                              </tr>
                              {trade.reasoning && (
                                <tr className="bg-slate-50/30 dark:bg-slate-900/5 border-b">
                                  <td colSpan={8} className="px-4 py-2 text-[11px] text-muted-foreground italic leading-relaxed">
                                    <strong className="text-slate-500 uppercase text-[9px] font-bold tracking-wider mr-1.5">Decision Triggers:</strong>
                                    {trade.reasoning}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      {/* Safety Confirmation Dialog for Live Trading */}
      <Dialog open={showLiveConfirm} onOpenChange={setShowLiveConfirm}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader className="space-y-3">
            <DialogTitle className="flex items-center gap-2 text-red-500 font-bold">
              <ShieldAlert className="h-6 w-6 text-red-500" />
              Live Options Trading Authorization
            </DialogTitle>
            <DialogDescription className="text-slate-600 leading-relaxed text-sm">
              You are about to activate **Live Money Options Trading** directly on your connected SnapTrade brokerage account.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-red-50 dark:bg-red-950/20 p-4 rounded-lg border border-red-200 text-xs text-red-800 dark:text-red-400 space-y-2">
            <p className="font-bold flex items-center gap-1"><AlertTriangle className="h-4 w-4" /> CRITICAL REGULATORY WARNING:</p>
            <p>1. Options trading carries substantial risk of loss and is not suitable for all investors.</p>
            <p>2. The bot will automatically route trades according to mathematical GEX setups. You accept all capital risks.</p>
            <p>3. Hard cutoffs will exit positions. High spread slippages or API rate limit failures can occur.</p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowLiveConfirm(false)}>
              Cancel
            </Button>
            <Button 
              variant="default" 
              onClick={handleLiveConfirm} 
              className="bg-red-600 hover:bg-red-700 text-white shadow-md shadow-red-600/25"
            >
              Activate Live Trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
