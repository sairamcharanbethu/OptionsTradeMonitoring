import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    TrendingUp,
    TrendingDown,
    Search,
    Loader2,
    Activity,
    RefreshCw,
    X,
    Wifi,
    WifiOff
} from 'lucide-react';

interface Candle {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface CandleWithEMA extends Candle {
    ema9Live: number | null;
    ema9Closed: number | null;
    state: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

interface LiveQuote {
    symbol: string;
    lastTradePrice: number;
    bidPrice: number;
    askPrice: number;
    volume: number;
    timestamp: string;
}

// EMA calculation helper
const calculateEMA = (prices: number[], period: number): (number | null)[] => {
    if (prices.length < period) return prices.map(() => null);

    const k = 2 / (period + 1);
    const emaValues: (number | null)[] = [];

    // First EMA is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
        emaValues.push(null);
    }

    let ema = sum / period;
    emaValues[period - 1] = ema;

    // Calculate rest
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
        emaValues.push(ema);
    }

    return emaValues;
};

export default function LiveAnalysis() {
    const [ticker, setTicker] = useState('');
    const [activeTicker, setActiveTicker] = useState('');
    const [candles, setCandles] = useState<CandleWithEMA[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [liveQuote, setLiveQuote] = useState<LiveQuote | null>(null);
    const [isSubscribed, setIsSubscribed] = useState(false);

    // WebSocket for real-time updates
    const { isConnected: wsConnected, lastMessage } = useWebSocket();

    // Handle WebSocket messages
    useEffect(() => {
        if (lastMessage && lastMessage.type === 'PRICE_UPDATE' && lastMessage.data) {
            const quote = lastMessage.data;
            // Only update if it's for our active ticker
            if (quote.symbol && quote.symbol.toUpperCase() === activeTicker.toUpperCase()) {
                setLiveQuote({
                    symbol: quote.symbol,
                    lastTradePrice: quote.lastTradePrice || quote.price || 0,
                    bidPrice: quote.bidPrice || 0,
                    askPrice: quote.askPrice || 0,
                    volume: quote.volume || 0,
                    timestamp: new Date().toISOString()
                });
                setLastUpdated(new Date());
            }
        }
    }, [lastMessage, activeTicker]);

    const fetchCandles = useCallback(async (symbol: string) => {
        if (!symbol.trim()) return;

        setLoading(true);
        setError(null);

        try {
            const data = await api.getLiveCandles(symbol);

            if (!data.candles || data.candles.length === 0) {
                setError('No candle data available for this symbol');
                setCandles([]);
                return;
            }

            const rawCandles: Candle[] = data.candles;
            const closePrices = rawCandles.map(c => c.close);

            // EMA9 on all candles (Live - includes current incomplete candle)
            const ema9Live = calculateEMA(closePrices, 9);

            // EMA9 on closed candles only (exclude last candle)
            const closedPrices = closePrices.slice(0, -1);
            const ema9Closed = calculateEMA(closedPrices, 9);

            // Build enriched candles
            const enrichedCandles: CandleWithEMA[] = rawCandles.map((c, i) => {
                const liveEma = ema9Live[i];
                const closedEma = i < ema9Closed.length ? ema9Closed[i] : null;

                let state: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
                if (liveEma !== null) {
                    if (c.close > liveEma) state = 'BULLISH';
                    else if (c.close < liveEma) state = 'BEARISH';
                }

                return {
                    ...c,
                    ema9Live: liveEma,
                    ema9Closed: closedEma,
                    state
                };
            });

            setCandles(enrichedCandles.reverse()); // Most recent first
            setActiveTicker(symbol.toUpperCase());
            setLastUpdated(new Date());

            // Subscribe to real-time updates for this symbol
            try {
                await api.subscribeLiveAnalysis(symbol);
                setIsSubscribed(true);
                console.log(`[LiveAnalysis] Subscribed to real-time updates for ${symbol}`);
            } catch (subErr) {
                console.warn('[LiveAnalysis] Failed to subscribe to real-time updates:', subErr);
                setIsSubscribed(false);
            }
        } catch (err: any) {
            console.error('Failed to fetch candles:', err);
            setError(err.message || 'Failed to fetch data');
            setCandles([]);
            setIsSubscribed(false);
        } finally {
            setLoading(false);
        }
    }, []);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        if (!autoRefresh || !activeTicker) return;

        const interval = setInterval(() => {
            fetchCandles(activeTicker);
        }, 30000);

        return () => clearInterval(interval);
    }, [autoRefresh, activeTicker, fetchCandles]);

    const handleSearch = () => {
        if (ticker.trim()) {
            fetchCandles(ticker.trim());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSearch();
        }
    };

    const formatTime = (isoTime: string) => {
        const date = new Date(isoTime);
        return date.toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    };

    const formatPrice = (price: number | null) => {
        if (price === null) return '—';
        return price.toFixed(2);
    };

    return (
        <div className="space-y-6">
            {/* Search Section */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Activity className="h-5 w-5 text-blue-500" />
                        Live Analysis with AI
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col sm:flex-row gap-3">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Enter ticker symbol (e.g., AAPL, SPY, TSLA)"
                                value={ticker}
                                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                                onKeyDown={handleKeyDown}
                                className="pl-9"
                            />
                            {ticker && (
                                <button
                                    onClick={() => setTicker('')}
                                    className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                        <Button onClick={handleSearch} disabled={loading || !ticker.trim()}>
                            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
                            Analyze
                        </Button>
                        {activeTicker && (
                            <Button variant="outline" onClick={() => fetchCandles(activeTicker)} disabled={loading}>
                                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                            </Button>
                        )}
                    </div>

                    {activeTicker && (
                        <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                            <span>Showing: <span className="font-bold text-foreground">{activeTicker}</span></span>
                            {lastUpdated && (
                                <span>Last updated: {lastUpdated.toLocaleTimeString()}</span>
                            )}
                            <div className="flex items-center gap-1.5">
                                {wsConnected ? (
                                    <>
                                        <Wifi className="h-3 w-3 text-green-500" />
                                        <span className="text-green-600 text-xs">Live</span>
                                    </>
                                ) : (
                                    <>
                                        <WifiOff className="h-3 w-3 text-red-500" />
                                        <span className="text-red-600 text-xs">Offline</span>
                                    </>
                                )}
                                {isSubscribed && wsConnected && (
                                    <Badge variant="secondary" className="text-[10px] ml-1">Subscribed</Badge>
                                )}
                            </div>
                            <label className="flex items-center gap-2 ml-auto cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoRefresh}
                                    onChange={(e) => setAutoRefresh(e.target.checked)}
                                    className="rounded"
                                />
                                Auto-refresh (30s)
                            </label>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Error Display */}
            {error && (
                <Card className="border-red-500/50 bg-red-500/10">
                    <CardContent className="py-4 text-red-500 text-sm">
                        {error}
                    </CardContent>
                </Card>
            )}

            {/* Results Table */}
            {candles.length > 0 && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium flex items-center justify-between">
                            <span>Real-time Aggregation & EMA9 Calculation</span>
                            <Badge variant="outline" className="text-xs">
                                {candles.length} candles (1-min)
                            </Badge>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                                    <tr>
                                        <th className="px-4 py-3 text-left">Time (ET)</th>
                                        <th className="px-4 py-3 text-right">Close</th>
                                        <th className="px-4 py-3 text-right">EMA9 (Live)</th>
                                        <th className="px-4 py-3 text-right">EMA9 (Closed)</th>
                                        <th className="px-4 py-3 text-center">State</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {candles.map((candle, idx) => (
                                        <tr
                                            key={candle.time}
                                            className={`border-b hover:bg-muted/30 transition-colors ${idx === 0 ? 'bg-primary/5' : ''}`}
                                        >
                                            <td className="px-4 py-2.5 font-mono text-xs">
                                                {formatTime(candle.time)}
                                                {idx === 0 && <Badge variant="secondary" className="ml-2 text-[10px]">LIVE</Badge>}
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-medium">
                                                ${formatPrice(candle.close)}
                                            </td>
                                            <td className="px-4 py-2.5 text-right text-blue-500 font-medium">
                                                {candle.ema9Live !== null ? `$${formatPrice(candle.ema9Live)}` : '—'}
                                            </td>
                                            <td className="px-4 py-2.5 text-right text-purple-500 font-medium">
                                                {candle.ema9Closed !== null ? `$${formatPrice(candle.ema9Closed)}` : '—'}
                                            </td>
                                            <td className="px-4 py-2.5 text-center">
                                                {candle.state === 'BULLISH' && (
                                                    <Badge className="bg-green-500/20 text-green-600 border-green-500/30 text-[10px]">
                                                        <TrendingUp className="h-3 w-3 mr-1" />
                                                        BULLISH
                                                    </Badge>
                                                )}
                                                {candle.state === 'BEARISH' && (
                                                    <Badge className="bg-red-500/20 text-red-600 border-red-500/30 text-[10px]">
                                                        <TrendingDown className="h-3 w-3 mr-1" />
                                                        BEARISH
                                                    </Badge>
                                                )}
                                                {candle.state === 'NEUTRAL' && (
                                                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                                        NEUTRAL
                                                    </Badge>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Empty State */}
            {!loading && !error && candles.length === 0 && !activeTicker && (
                <Card className="border-dashed">
                    <CardContent className="py-12 text-center text-muted-foreground">
                        <Activity className="h-12 w-12 mx-auto mb-4 opacity-20" />
                        <p className="text-sm">Enter a ticker symbol above to start live analysis</p>
                        <p className="text-xs mt-1">Get real-time EMA9 calculations and trend state</p>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
