
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search, BrainCircuit, TrendingUp, TrendingDown, Loader2, AlertCircle, Zap, Globe, BarChart3, Gauge } from 'lucide-react';

export default function StockAnalysis({ initialTicker }: { initialTicker?: string }) {
  const [ticker, setTicker] = useState(initialTicker || '');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchForecast = useCallback(async (symbol: string) => {
    setLoading(true); setError(null);
    try {
      const res = await api.getMLForecast(symbol);
      setData(res);
      if (res.status === 'FAILED') setError(res.error_message || 'Analysis failed');
    } catch (err: any) { setError(err.message || 'Failed to fetch analysis'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (initialTicker) fetchForecast(initialTicker); }, [initialTicker, fetchForecast]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (data?.status === 'PENDING') {
      interval = setInterval(async () => {
        try {
          const res = await api.getMLForecast(data.ticker);
          setData(res);
          if (res.status !== 'PENDING') clearInterval(interval);
        } catch {}
      }, 5000);
    }
    return () => clearInterval(interval);
  }, [data]);

  return (
    <div className="container mx-auto py-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-6 rounded-lg border shadow-sm">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2"><BrainCircuit className="h-6 w-6 text-primary" /> Stock ML Insights</h2>
          <p className="text-sm text-muted-foreground">Universal ticker analysis powered by Random Forest & LSTM</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (ticker.trim()) fetchForecast(ticker.trim()); }} className="flex w-full md:w-auto items-center gap-2">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Enter Ticker" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} className="pl-8 h-10" />
          </div>
          <Button type="submit" disabled={loading || !ticker.trim()}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Analyze'}</Button>
        </form>
      </div>
      {error && <Card className="border-destructive/50 bg-destructive/5"><CardContent className="p-4 flex items-center gap-3 text-destructive"><AlertCircle className="h-5 w-5" /><p className="font-medium">{error}</p></CardContent></Card>}
      {data?.status === 'PENDING' && (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <div className="relative"><BrainCircuit className="h-16 w-16 text-primary animate-pulse" /><Loader2 className="h-20 w-20 text-primary/20 animate-spin absolute -top-2 -left-2" /></div>
          <div className="text-center"><h3 className="text-lg font-bold">Training Models for {data.ticker}...</h3><p className="text-sm text-muted-foreground">Fetching 5y data and running ensemble predictions.</p></div>
        </div>
      )}
      {data?.status === 'SUCCESS' && data.indicators && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-700">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="md:col-span-2 border-primary/20 bg-primary/5">
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Zap className="h-4 w-4 text-primary" /> AI Strategic Summary</CardTitle></CardHeader>
              <CardContent><div className="text-lg leading-relaxed italic text-foreground/90 bg-background/50 p-4 rounded-lg border">"{data.ai_summary}"</div><div className="mt-4 flex flex-wrap gap-2"><Badge variant="outline" className="bg-background">Confidence: {(data.confidence * 100).toFixed(0)}%</Badge><Badge variant="outline" className="bg-background">Expected Move: {data.expected_move}</Badge></div></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Globe className="h-4 w-4 text-blue-500" /> Sentiment</CardTitle></CardHeader>
              <CardContent className="h-[120px] flex flex-col items-center justify-center"><div className="text-4xl font-bold">{(data.indicators.sentiment * 100).toFixed(0)}</div><div className="text-xs text-muted-foreground uppercase font-medium">Score (0-100)</div></CardContent>
            </Card>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase">Next Day Forecast</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">${data.forecast.next_day}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase">Next Week Forecast</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">${data.forecast.next_week}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase">RSI (14)</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{data.indicators.rsi}</div></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground uppercase">Expected Move</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold text-blue-500">{data.expected_move}</div></CardContent></Card>
          </div>
        </div>
      )}
    </div>
  );
}
