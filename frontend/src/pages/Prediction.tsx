
import React, { useState, useEffect, useCallback } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    ReferenceLine, Legend
} from 'recharts';

import { Loader2, TrendingUp, TrendingDown, AlignJustify, BrainCircuit, Activity, Clock, AlertTriangle } from 'lucide-react';

import { api } from '@/lib/api';

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

                        {/* Technical Indicators Card */}
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
