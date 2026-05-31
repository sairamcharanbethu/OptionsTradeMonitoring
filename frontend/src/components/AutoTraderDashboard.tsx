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

export default function AutoTraderDashboard() {
  const [settings, setSettings] = useState<{ mode: 'simulation' | 'live'; maxContracts: number } | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const interval = setInterval(fetchData, 15000); // Poll every 15s
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
    } catch (err: any) {
      console.error(err);
      alert('Manual trigger failed: ' + err.message);
    } finally {
      setIsScanning(false);
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
          <Button variant="outline" size="sm" onClick={fetchData} className="gap-2">
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
              <div className="grid grid-cols-2 gap-2 text-xs">
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
              <div className="grid grid-cols-2 gap-2 text-xs">
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
