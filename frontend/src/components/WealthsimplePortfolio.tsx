import React, { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useSnaptradePortfolio } from '@/hooks/useDashboardData';
import { useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, BrainCircuit, Activity, TrendingUp, AlertTriangle, Loader2, Link } from 'lucide-react';
import { StatsCard } from './StatsCard';

export default function WealthsimplePortfolio() {
  const queryClient = useQueryClient();
  const { data: portfolio, isLoading, error, refetch } = useSnaptradePortfolio();
  const [isSyncing, setIsSyncing] = useState(false);
  const [isGeneratingBriefing, setIsGeneratingBriefing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [briefing, setBriefing] = useState<any | null>(null);
  const [lastReviewedAt, setLastReviewedAt] = useState<string | null>(null);

  useEffect(() => {
    const loadPersistentBriefing = async () => {
      try {
        const data = await api.getSnaptradeBriefing();
        if (data && data.briefing) {
          setBriefing(data.briefing);
          setLastReviewedAt(data.lastReviewedAt);
        }
      } catch (e) {
        console.error('Failed to load persistent briefing:', e);
      }
    };
    loadPersistentBriefing();
  }, []);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await api.syncSnaptradePortfolio();
      await refetch();
    } catch (err) {
      console.error(err);
      alert('Failed to sync Wealthsimple portfolio.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleGenerateBriefing = async () => {
    setIsGeneratingBriefing(true);
    try {
      const data = await api.getSnaptradeBriefing(true);
      setBriefing(data.briefing);
      setLastReviewedAt(data.lastReviewedAt);
    } catch (err) {
      console.error(err);
      alert('Failed to generate AI briefing. Please try again.');
    } finally {
      setIsGeneratingBriefing(false);
    }
  };

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const data = await api.connectSnaptrade();
      if (data.redirectURI) {
        window.location.href = data.redirectURI;
      } else {
        alert('Failed to get connection URL');
      }
    } catch (err: any) {
      alert(`Error connecting to SnapTrade: ${err.message}`);
    } finally {
      setIsConnecting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin mb-4" />
        <p>Loading Wealthsimple Portfolio...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-red-500">
        <AlertTriangle className="h-8 w-8 mb-4" />
        <p>Failed to load Wealthsimple portfolio. Please ensure your broker is connected.</p>
      </div>
    );
  }

  const accounts = portfolio?.accounts || [];
  const positions = portfolio?.positions || [];

  // Calculate high-level stats
  const totalValue = positions.reduce((acc: number, pos: any) => acc + (Number(pos.price) * Number(pos.units)), 0);
  const totalOpenPnl = positions.reduce((acc: number, pos: any) => acc + Number(pos.open_pnl || 0), 0);

  return (
    <div className="space-y-6">
      {/* Header Actions */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-4 rounded-lg border shadow-sm">
        <div className="flex flex-col">
          <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-green-500" />
            Wealthsimple Portfolio
          </h2>
          <p className="text-xs text-muted-foreground mt-1">Manage your long-term equities and crypto holdings</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleConnect} disabled={isConnecting} className="gap-2">
            {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link className="h-4 w-4" />}
            Connect Broker
          </Button>
          <Button variant="default" size="sm" onClick={handleSync} disabled={isSyncing} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync Data'}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatsCard 
          title="Total Value" 
          value={`$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} 
          icon={Activity} 
        />
        <StatsCard 
          title="Open PnL" 
          value={`$${totalOpenPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} 
          icon={TrendingUp} 
          valueClassName={totalOpenPnl >= 0 ? 'text-green-500' : 'text-red-500'}
        />
        <StatsCard 
          title="Active Positions" 
          value={positions.length} 
          icon={Activity} 
        />
      </div>

      {/* AI Briefing Card */}
      <Card className="border-primary/20 bg-primary/5 shadow-premium overflow-hidden group">
        <CardHeader className="pb-3 border-b border-primary/10">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-lg flex items-center gap-2 text-primary">
                <BrainCircuit className="h-5 w-5 animate-pulse" />
                Wealthsimple AI Manager
              </CardTitle>
              {lastReviewedAt && (
                <p className="text-[11px] text-muted-foreground">
                  Last Reviewed: <span className="font-semibold text-primary">{new Date(lastReviewedAt).toLocaleString()}</span>
                </p>
              )}
            </div>
            <Button 
              size="sm" 
              onClick={handleGenerateBriefing} 
              disabled={isGeneratingBriefing || positions.length === 0}
              className="gap-2 shadow-sm transition-premium hover:shadow-primary/25"
            >
              {isGeneratingBriefing ? <Loader2 className="h-4 w-4 animate-spin" /> : <BrainCircuit className="h-4 w-4" />}
              {briefing ? 'Regenerate Analysis' : 'Analyze Portfolio'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isGeneratingBriefing ? (
            <div className="p-12 flex flex-col items-center justify-center space-y-4 text-center">
              <div className="relative">
                <BrainCircuit className="h-12 w-12 text-primary animate-pulse" />
                <Loader2 className="h-16 w-16 text-primary/30 animate-spin absolute -top-2 -left-2" />
              </div>
              <div className="space-y-1">
                <p className="font-bold text-primary">AI scanning equities and crypto...</p>
                <p className="text-xs text-muted-foreground max-w-[300px]">Reviewing fundamentals and PnL metrics.</p>
              </div>
            </div>
          ) : briefing ? (
            <div className="p-6 space-y-6 animate-in fade-in slide-in-from-top-2 duration-200">
              {/* Summary Banner */}
              {briefing.summary && (
                <div className="p-4 rounded-xl bg-background border border-primary/20 shadow-inner text-sm leading-relaxed font-sans text-slate-700 dark:text-slate-300">
                  <span className="font-semibold text-primary block mb-1">Portfolio Summary</span>
                  {briefing.summary}
                </div>
              )}

              {/* Action Required & Hold/Watch Layout */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Action Required Column */}
                <div className="space-y-3">
                  <h3 className="text-sm font-bold text-red-500 uppercase tracking-wider flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" />
                    Action Required ({briefing.actionRequired?.length || 0})
                  </h3>
                  <div className="space-y-3">
                    {!briefing.actionRequired || briefing.actionRequired.length === 0 ? (
                      <div className="p-4 rounded-lg border border-dashed text-center text-xs text-muted-foreground">
                        No immediate actions required.
                      </div>
                    ) : (
                      briefing.actionRequired.map((action: any, idx: number) => (
                        <div key={idx} className="p-3.5 rounded-xl border border-red-500/10 bg-red-500/5 dark:bg-red-500/10 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-sm text-foreground">{action.symbol}</span>
                            <div className="flex items-center gap-1.5">
                              <Badge className="bg-red-500 hover:bg-red-600 text-white border-none text-[10px] uppercase font-bold py-0.5">
                                {action.verdict}
                              </Badge>
                              {action.amount && action.amount !== 'N/A' && (
                                <Badge variant="outline" className="text-[10px] font-semibold">
                                  {action.amount}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">{action.actionPlan}</p>
                          {action.timeline && (
                            <div className="text-[10px] font-mono text-red-500/80 bg-red-500/10 w-fit px-1.5 py-0.5 rounded">
                              Timeline: {action.timeline}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Watch / Hold Column */}
                <div className="space-y-3">
                  <h3 className="text-sm font-bold text-sky-500 uppercase tracking-wider flex items-center gap-1.5">
                    <Activity className="h-4 w-4" />
                    Watch / Hold ({briefing.holdWatch?.length || 0})
                  </h3>
                  <div className="space-y-3">
                    {!briefing.holdWatch || briefing.holdWatch.length === 0 ? (
                      <div className="p-4 rounded-lg border border-dashed text-center text-xs text-muted-foreground">
                        No watch/hold positions listed.
                      </div>
                    ) : (
                      briefing.holdWatch.map((hold: any, idx: number) => (
                        <div key={idx} className="p-3.5 rounded-xl border border-sky-500/10 bg-sky-500/5 dark:bg-sky-500/10 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-sm text-foreground">{hold.symbol}</span>
                            <Badge className="bg-sky-500 hover:bg-sky-600 text-white border-none text-[10px] uppercase font-bold py-0.5">
                              {hold.verdict}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{hold.actionPlan}</p>
                          {hold.timeline && (
                            <div className="text-[10px] font-mono text-sky-600 dark:text-sky-400 bg-sky-500/10 w-fit px-1.5 py-0.5 rounded">
                              Timeframe: {hold.timeline}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-10 flex flex-col items-center justify-center space-y-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">
              <Activity className="h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground max-w-[280px]">Need insights on your holdings? Click above to let AI analyze your portfolio.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Positions Table */}
      <Card>
        <CardHeader>
          <CardTitle>Holdings</CardTitle>
          <CardDescription>Your current equity and crypto positions from Wealthsimple.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="space-y-3 p-3 md:hidden">
            {positions.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No positions found. Sync your broker to fetch data.</div>
            ) : positions.map((pos: any) => (
              <article key={`mobile-${pos.id}`} className="rounded-xl border border-border/70 bg-background/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div><div className="font-bold text-primary">{pos.symbol}</div><Badge variant="outline" className="mt-1 text-[10px]">{pos.asset_type}</Badge></div>
                  <div className={`text-right font-mono text-lg font-bold ${Number(pos.open_pnl) >= 0 ? 'text-green-500' : 'text-red-500'}`}>${Number(pos.open_pnl).toFixed(2)}</div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border/60 pt-3 text-sm">
                  <div><div className="text-xs text-muted-foreground">Units</div><div className="font-mono">{Number(pos.units).toFixed(4)}</div></div>
                  <div><div className="text-xs text-muted-foreground">Average</div><div className="font-mono">${Number(pos.average_purchase_price).toFixed(2)}</div></div>
                  <div><div className="text-xs text-muted-foreground">Current</div><div className="font-mono">${Number(pos.price).toFixed(2)}</div></div>
                </div>
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3">Asset Type</th>
                  <th className="px-4 py-3 text-right">Units</th>
                  <th className="px-4 py-3 text-right">Avg Price</th>
                  <th className="px-4 py-3 text-right">Current Price</th>
                  <th className="px-4 py-3 text-right">Open PnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-muted-foreground">
                      No positions found. Sync your broker to fetch data.
                    </td>
                  </tr>
                ) : (
                  positions.map((pos: any) => (
                    <tr key={pos.id} className="border-b hover:bg-muted/50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-bold text-primary">{pos.symbol}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px]">{pos.asset_type}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {Number(pos.units).toFixed(4)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        ${Number(pos.average_purchase_price).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        ${Number(pos.price).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className={`font-bold ${Number(pos.open_pnl) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          ${Number(pos.open_pnl).toFixed(2)}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
