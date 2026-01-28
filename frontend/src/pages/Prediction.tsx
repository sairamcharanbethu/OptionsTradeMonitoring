
import React, { useState, useEffect, useCallback } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    ReferenceLine, Legend
} from 'recharts';

import { Loader2, TrendingUp, TrendingDown, AlignJustify, BrainCircuit, Activity, Clock, AlertTriangle, Newspaper } from 'lucide-react';

import { api } from '@/lib/api';

interface NewsHeadline {
    title: string;
    score: number;
    sentiment: 'Bullish' | 'Bearish' | 'Neutral';
    published: number;
}

interface NewsSentiment {
    available: boolean;
    aggregate_score: number;
    sentiment: 'Bullish' | 'Bearish' | 'Neutral';
    headline_count: number;
    headlines: NewsHeadline[];
    error?: string;
    message?: string;
}

interface MarketIndicators {
    available: boolean;
    vix?: number;
    vix_level?: string;
    fear_greed?: {
        value: number;
        label: string;
    };
    fifty_two_week?: {
        high: number;
        low: number;
        current: number;
        distance_from_high_pct: number;
        distance_from_low_pct: number;
        position_in_range: number;
    };
    analyst_targets?: {
        mean_target: number;
        high_target?: number;
        low_target?: number;
        num_analysts: number;
        recommendation: string;
        upside_pct: number;
    };
}

interface PredictionData {
    symbol: string;
    currentPrice: number;
    history: { date: string; close: number }[];
    indicators: {
        rsi: number;
        macd: { macd: number; signal: number; histogram: number };
        sma50: number;
        sma200: number;
        ema9: number;
        ema21: number;
        bollinger: { upper: number; lower: number; middle: number };
    };
    newsSentiment?: NewsSentiment;
    marketIndicators?: MarketIndicators;
    aiAnalysis: {
        verdict: 'Buy' | 'Sell' | 'Hold';
        reasoning: string;
    };
}

const COOLDOWN_SECONDS = 60; // 1 minute cooldown between requests

export default function Prediction() {
    const [symbol, setSymbol] = useState('');
    const [querySymbol, setQuerySymbol] = useState<string | null>(null);
    const token = localStorage.getItem('token') || '';

    const [data, setData] = useState<PredictionData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const [cooldown, setCooldown] = useState(0);

    // Cooldown timer effect
    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setInterval(() => {
            setCooldown(prev => Math.max(0, prev - 1));
        }, 1000);
        return () => clearInterval(timer);
    }, [cooldown]);

    useEffect(() => {
        if (!querySymbol || !token) return;

        let mounted = true;
        setIsLoading(true);
        setError(null);
        setData(null);

        api.predictStock(querySymbol)
            .then(res => {
                if (mounted) {
                    setData(res);
                    setCooldown(COOLDOWN_SECONDS); // Start cooldown after successful request
                }
            })
            .catch(err => {
                if (mounted) {
                    setError(err);
                    // If rate limited, set a longer cooldown
                    if (err.message?.includes('Rate') || err.message?.includes('429') || err.message?.includes('Too Many')) {
                        setCooldown(COOLDOWN_SECONDS * 2);
                    }
                }
            })
            .finally(() => {
                if (mounted) setIsLoading(false);
            });

        return () => { mounted = false; };
    }, [querySymbol, token]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (symbol.trim() && cooldown === 0) {
            setQuerySymbol(symbol.toUpperCase());
        }
    };

    const getVerdictColor = (verdict: string) => {
        switch (verdict) {
            case 'Buy': return 'text-green-400 border-green-400 bg-green-900/20';
            case 'Sell': return 'text-red-400 border-red-400 bg-red-900/20';
            default: return 'text-yellow-400 border-yellow-400 bg-yellow-900/20';
        }
    };

    return (
        <div className="p-6 space-y-6 max-w-7xl mx-auto">
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
                <h1 className="text-3xl font-bold flex items-center gap-2">
                    <BrainCircuit className="w-8 h-8 text-purple-400" />
                    AI Stock Prediction
                </h1>
                <form onSubmit={handleSearch} className="flex gap-2 w-full md:w-auto items-center">
                    <input
                        type="text"
                        value={symbol}
                        onChange={(e) => setSymbol(e.target.value)}
                        placeholder="Enter Symbol (e.g. NVDA)"
                        className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 uppercase"
                    />
                    <button
                        type="submit"
                        disabled={isLoading || !symbol || cooldown > 0}
                        className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-50 font-medium transition-colors min-w-[120px]"
                    >
                        {isLoading ? <Loader2 className="animate-spin mx-auto" /> :
                            cooldown > 0 ? (
                                <span className="flex items-center gap-1 justify-center">
                                    <Clock className="w-4 h-4" /> {cooldown}s
                                </span>
                            ) : 'Analyze'}
                    </button>
                </form>
            </div>

            {/* Questrade API Constraints & Transparency */}
            <div className="bg-slate-800/30 border border-slate-700/50 rounded-lg p-4 text-xs text-slate-400">
                <div className="flex items-center gap-2 font-semibold text-slate-300 mb-2">
                    <Activity className="w-4 h-4 text-cyan-500" />
                    Questrade API Synchronization
                </div>
                <ul className="space-y-1 ml-6 list-disc">
                    <li><strong>Market Data Limit:</strong> Questrade allows ~15,000 requests/hour. To preserve your budget, we cache 5-year history in the database.</li>
                    <li><strong>Incremental Sync:</strong> Only new "gap" candles are fetched since your last sync, reducing API payload by 99%.</li>
                    <li><strong>Accuracy:</strong> AI leverages deep history (5 years) to calculate long-term SMA/EMA cross-overs and support levels.</li>
                    <li><strong>Cooldown:</strong> A {COOLDOWN_SECONDS}s window is required between new symbols to prevent terminal rate-limiting.</li>
                </ul>
            </div>

            {error && (
                <div className={`p-4 rounded-lg flex items-start gap-3 ${(error as any).message?.includes('Rate') || (error as any).message?.includes('429') || (error as any).message?.includes('wait')
                    ? 'bg-yellow-900/20 border border-yellow-500/50 text-yellow-200'
                    : 'bg-red-900/20 border border-red-500/50 text-red-200'
                    }`}>
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                        <div className="font-medium">
                            {(error as any).message?.includes('Rate') || (error as any).message?.includes('wait')
                                ? 'Rate Limit Reached'
                                : 'Analysis Error'}
                        </div>
                        <div className="text-sm opacity-80 mt-1">
                            {(error as any).message?.includes('Rate') || (error as any).message?.includes('wait')
                                ? 'Questrade API rate limit reached. Please wait 2-3 minutes before trying again. Each prediction fetches 2 years of historical data.'
                                : (error as Error).message}
                        </div>
                    </div>
                </div>
            )}

            {data && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in zoom-in duration-300">

                    {/* Main Chart Section */}
                    <div className="lg:col-span-2 bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl backdrop-blur-sm">
                        <div className="flex justify-between items-center mb-6">
                            <div>
                                <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                                    {data.symbol}
                                </h2>
                                <div className="text-3xl font-mono mt-1 text-white">
                                    ${data.currentPrice.toFixed(2)}
                                </div>
                            </div>
                            <div className={`px-4 py-2 rounded-full border text-lg font-bold flex items-center gap-2 ${getVerdictColor(data.aiAnalysis.verdict)}`}>
                                {data.aiAnalysis.verdict === 'Buy' ? <TrendingUp className="w-5 h-5" /> :
                                    data.aiAnalysis.verdict === 'Sell' ? <TrendingDown className="w-5 h-5" /> :
                                        <AlignJustify className="w-5 h-5" />}
                                {data.aiAnalysis.verdict}
                            </div>
                        </div>

                        <div className="h-[400px] w-full min-h-[400px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={data.history}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                                    <XAxis
                                        dataKey="date"
                                        stroke="#94a3b8"
                                        tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                        minTickGap={30}
                                    />
                                    <YAxis
                                        domain={['auto', 'auto']}
                                        stroke="#94a3b8"
                                        tickFormatter={(val) => `$${val}`}
                                    />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
                                        labelStyle={{ color: '#94a3b8' }}
                                    />
                                    <Legend />
                                    <Line
                                        type="monotone"
                                        dataKey="close"
                                        stroke="#8b5cf6"
                                        strokeWidth={2}
                                        dot={false}
                                        name="Price"
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Analysis & Indicators Column */}
                    <div className="space-y-6">

                        {/* AI Analysis Card */}
                        <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 rounded-xl p-6 shadow-xl relative overflow-hidden group">
                            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                <BrainCircuit className="w-24 h-24" />
                            </div>
                            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-purple-300">
                                <BrainCircuit className="w-5 h-5" /> AI Reasoning
                            </h3>
                            <p className="text-slate-300 leading-relaxed text-sm">
                                {data.aiAnalysis.reasoning}
                            </p>
                        </div>

                        {/* News Sentiment Card */}
                        {data.newsSentiment && data.newsSentiment.available && (
                            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl">
                                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-amber-300">
                                    <Newspaper className="w-5 h-5" /> News Sentiment
                                </h3>

                                {/* Aggregate Score */}
                                <div className="mb-4 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs text-slate-400">Overall Sentiment</span>
                                        <span className={`text-lg font-bold ${data.newsSentiment.sentiment === 'Bullish' ? 'text-green-400' :
                                            data.newsSentiment.sentiment === 'Bearish' ? 'text-red-400' :
                                                'text-yellow-400'
                                            }`}>
                                            {data.newsSentiment.sentiment}
                                        </span>
                                    </div>
                                    <div className="mt-2">
                                        <div className="flex justify-between text-xs text-slate-500 mb-1">
                                            <span>Bearish</span>
                                            <span>Score: {data.newsSentiment.aggregate_score.toFixed(2)}</span>
                                            <span>Bullish</span>
                                        </div>
                                        {/* Visual sentiment bar */}
                                        <div className="relative h-2 bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 rounded-full overflow-hidden">
                                            <div
                                                className="absolute top-0 bottom-0 w-3 bg-white border-2 border-slate-800 rounded-full shadow-lg transform -translate-x-1/2"
                                                style={{ left: `${((data.newsSentiment.aggregate_score + 1) / 2) * 100}%` }}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Headlines List */}
                                {data.newsSentiment.headlines.length > 0 && (
                                    <div className="space-y-2">
                                        <div className="text-xs text-slate-400 font-medium">
                                            Recent Headlines ({data.newsSentiment.headline_count})
                                        </div>
                                        {data.newsSentiment.headlines.slice(0, 5).map((headline, idx) => (
                                            <div key={idx} className="p-2 bg-slate-900/30 rounded border-l-2 transition-colors hover:bg-slate-900/50"
                                                style={{
                                                    borderLeftColor: headline.sentiment === 'Bullish' ? '#4ade80' :
                                                        headline.sentiment === 'Bearish' ? '#f87171' : '#facc15'
                                                }}>
                                                <p className="text-xs text-slate-300 leading-snug line-clamp-2">{headline.title}</p>
                                                <div className="flex justify-between items-center mt-1">
                                                    <span className={`text-[10px] font-medium ${headline.sentiment === 'Bullish' ? 'text-green-400' :
                                                        headline.sentiment === 'Bearish' ? 'text-red-400' :
                                                            'text-yellow-400'
                                                        }`}>
                                                        {headline.sentiment}
                                                    </span>
                                                    <span className="text-[10px] text-slate-500 font-mono">
                                                        {headline.score > 0 ? '+' : ''}{headline.score.toFixed(2)}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Market Indicators Card */}
                        {data.marketIndicators && data.marketIndicators.available && (
                            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl">
                                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-emerald-300">
                                    <Activity className="w-5 h-5" /> Market Sentiment
                                </h3>

                                <div className="space-y-4">
                                    {/* VIX */}
                                    {data.marketIndicators.vix && (
                                        <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-slate-400">VIX (Fear Index)</span>
                                                <span className={`text-lg font-bold ${data.marketIndicators.vix < 15 ? 'text-green-400' :
                                                        data.marketIndicators.vix < 20 ? 'text-yellow-400' :
                                                            data.marketIndicators.vix < 30 ? 'text-orange-400' :
                                                                'text-red-400'
                                                    }`}>
                                                    {data.marketIndicators.vix.toFixed(1)}
                                                </span>
                                            </div>
                                            <div className="text-xs text-slate-500 mt-1">{data.marketIndicators.vix_level}</div>
                                        </div>
                                    )}

                                    {/* Fear & Greed */}
                                    {data.marketIndicators.fear_greed && (
                                        <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                            <div className="flex justify-between items-center mb-2">
                                                <span className="text-xs text-slate-400">Fear & Greed</span>
                                                <span className={`text-sm font-medium ${data.marketIndicators.fear_greed.value >= 75 ? 'text-green-400' :
                                                        data.marketIndicators.fear_greed.value >= 55 ? 'text-lime-400' :
                                                            data.marketIndicators.fear_greed.value >= 45 ? 'text-yellow-400' :
                                                                data.marketIndicators.fear_greed.value >= 25 ? 'text-orange-400' :
                                                                    'text-red-400'
                                                    }`}>
                                                    {data.marketIndicators.fear_greed.value}/100 ({data.marketIndicators.fear_greed.label})
                                                </span>
                                            </div>
                                            <div className="relative h-2 bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 rounded-full">
                                                <div
                                                    className="absolute top-0 bottom-0 w-2 bg-white border border-slate-800 rounded-full shadow transform -translate-x-1/2"
                                                    style={{ left: `${data.marketIndicators.fear_greed.value}%` }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {/* 52-Week Range */}
                                    {data.marketIndicators.fifty_two_week && (
                                        <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                            <div className="flex justify-between text-xs text-slate-400 mb-1">
                                                <span>52W Low: ${data.marketIndicators.fifty_two_week.low.toFixed(2)}</span>
                                                <span>52W High: ${data.marketIndicators.fifty_two_week.high.toFixed(2)}</span>
                                            </div>
                                            <div className="relative h-2 bg-slate-700 rounded-full mb-2">
                                                <div
                                                    className="absolute top-0 bottom-0 w-2 bg-blue-500 rounded-full shadow-lg shadow-blue-500/50 transform -translate-x-1/2"
                                                    style={{ left: `${Math.min(100, Math.max(0, data.marketIndicators.fifty_two_week.position_in_range))}%` }}
                                                />
                                            </div>
                                            <div className="text-center text-xs text-slate-400">
                                                {data.marketIndicators.fifty_two_week.distance_from_high_pct.toFixed(1)}% from 52W high
                                            </div>
                                        </div>
                                    )}

                                    {/* Analyst Targets */}
                                    {data.marketIndicators.analyst_targets && (
                                        <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                            <div className="flex justify-between items-center mb-1">
                                                <span className="text-xs text-slate-400">Analyst Target</span>
                                                <span className={`text-sm font-bold ${data.marketIndicators.analyst_targets.upside_pct > 10 ? 'text-green-400' :
                                                        data.marketIndicators.analyst_targets.upside_pct > 0 ? 'text-lime-400' :
                                                            data.marketIndicators.analyst_targets.upside_pct > -10 ? 'text-yellow-400' :
                                                                'text-red-400'
                                                    }`}>
                                                    ${data.marketIndicators.analyst_targets.mean_target.toFixed(2)}
                                                </span>
                                            </div>
                                            <div className="flex justify-between text-xs">
                                                <span className={`font-medium uppercase ${data.marketIndicators.analyst_targets.recommendation === 'buy' ||
                                                        data.marketIndicators.analyst_targets.recommendation === 'strong_buy' ? 'text-green-400' :
                                                        data.marketIndicators.analyst_targets.recommendation === 'hold' ? 'text-yellow-400' :
                                                            'text-red-400'
                                                    }`}>
                                                    {data.marketIndicators.analyst_targets.recommendation.replace('_', ' ')}
                                                </span>
                                                <span className="text-slate-500">
                                                    {data.marketIndicators.analyst_targets.upside_pct > 0 ? '+' : ''}
                                                    {data.marketIndicators.analyst_targets.upside_pct.toFixed(1)}% upside
                                                </span>
                                            </div>
                                            <div className="text-xs text-slate-600 mt-1">
                                                Based on {data.marketIndicators.analyst_targets.num_analysts} analysts
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl">
                            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-cyan-300">
                                <Activity className="w-5 h-5" /> Technicals
                            </h3>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="text-xs text-slate-400 mb-1">RSI (14)</div>
                                    <div className={`text-xl font-mono ${data.indicators.rsi > 70 ? 'text-red-400' :
                                        data.indicators.rsi < 30 ? 'text-green-400' : 'text-white'
                                        }`}>
                                        {data.indicators.rsi.toFixed(1)}
                                    </div>
                                </div>

                                <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="text-xs text-slate-400 mb-1">MACD</div>
                                    <div className={`text-xl font-mono ${data.indicators.macd.histogram > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {data.indicators.macd.histogram.toFixed(2)}
                                    </div>
                                </div>

                                <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="text-xs text-slate-400 mb-1">EMA 9</div>
                                    <div className={`text-lg font-mono ${data.currentPrice > data.indicators.ema9 ? 'text-green-400' : 'text-red-400'}`}>
                                        ${data.indicators.ema9.toFixed(2)}
                                    </div>
                                </div>

                                <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="text-xs text-slate-400 mb-1">EMA 21</div>
                                    <div className={`text-lg font-mono ${data.currentPrice > data.indicators.ema21 ? 'text-green-400' : 'text-red-400'}`}>
                                        ${data.indicators.ema21.toFixed(2)}
                                    </div>
                                </div>

                                <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="text-xs text-slate-400 mb-1">SMA 50</div>
                                    <div className="text-lg font-mono text-white">
                                        ${data.indicators.sma50.toFixed(2)}
                                    </div>
                                </div>

                                <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                    <div className="text-xs text-slate-400 mb-1">SMA 200</div>
                                    <div className="text-lg font-mono text-white">
                                        ${data.indicators.sma200.toFixed(2)}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-4 pt-4 border-t border-slate-700">
                                <div className="flex justify-between text-xs text-slate-400 mb-1">
                                    <span>Bollinger Lower</span>
                                    <span>Bollinger Upper</span>
                                </div>
                                <div className="flex justify-between font-mono text-sm">
                                    <span className="text-green-300">${data.indicators.bollinger.lower.toFixed(2)}</span>
                                    <span className="text-red-300">${data.indicators.bollinger.upper.toFixed(2)}</span>
                                </div>
                                {/* Visual Bar for Price within Bollinger */}
                                <div className="relative h-2 bg-slate-700 rounded-full mt-2 overflow-hidden">
                                    <div
                                        className="absolute top-0 bottom-0 bg-blue-500 rounded-full w-2 shadow-[0_0_8px_rgba(59,130,246,0.8)]"
                                        style={{
                                            left: `${Math.min(100, Math.max(0, ((data.currentPrice - data.indicators.bollinger.lower) / (data.indicators.bollinger.upper - data.indicators.bollinger.lower)) * 100))}%`
                                        }}
                                    />
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            )}

            {/* Empty State */}
            {!data && !isLoading && !error && (
                <div className="flex flex-col items-center justify-center py-20 text-slate-500 opacity-50">
                    <BrainCircuit className="w-24 h-24 mb-4 stroke-1" />
                    <p className="text-xl">Enter a generic stock symbol to generate an AI prediction</p>
                </div>
            )}
        </div>
    );
}
