import React, { useState } from 'react';
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
  const [briefing, setBriefing] = useState<string | null>(null);

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
      const data = await api.getSnaptradeBriefing();
      setBriefing(data.briefing);
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
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2 text-primary">
              <BrainCircuit className="h-5 w-5 animate-pulse" />
              Wealthsimple AI Manager
            </CardTitle>
            <Button 
              size="sm" 
              onClick={handleGenerateBriefing} 
              disabled={isGeneratingBriefing || positions.length === 0}
              className="gap-2 shadow-sm transition-all hover:shadow-primary/25"
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
            <div className="p-6 space-y-4 animate-in fade-in slide-in-from-top-4 duration-700">
              <div className="p-4 rounded-xl bg-background border shadow-inner text-sm leading-relaxed whitespace-pre-wrap font-sans italic text-slate-700 dark:text-slate-300">
                {typeof briefing === 'string' ? briefing : JSON.stringify(briefing, null, 2)}
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
          <div className="overflow-x-auto">
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
