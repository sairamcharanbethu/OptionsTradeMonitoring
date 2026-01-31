
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, Position } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn, parseLocalDate } from '@/lib/utils';
import { RefreshCw, ArrowLeft, Loader2, TrendingUp, TrendingDown, Target, ShieldAlert, LineChart, BrainCircuit, Activity, Info, XCircle, DollarSign, Hash, CheckCircle2, LayoutGrid, List } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

export default function PositionDetailsPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [position, setPosition] = useState<Position | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
    const [updater, setUpdater] = useState<number>(0); // Force re-render for timer
    const pollIntervalRef = React.useRef<any>(null);

    // Close Logic
    const [isClosing, setIsClosing] = useState(false);
    const [salePrice, setSalePrice] = useState<string>('');
    const [saleQty, setSaleQty] = useState<string>('');
    const [closeError, setCloseError] = useState<string | null>(null);

    // View Modes
    const [simViewMode, setSimViewMode] = useState<'table' | 'heatmap'>('table');

    // Analysis
    const [analysis, setAnalysis] = useState<{ verdict: string, text: string } | null>(null);
    const [analysisLoading, setAnalysisLoading] = useState(false);

    useEffect(() => {
        if (!id) return;
        loadPosition(id);

        // dedicated polling
        const startPolling = async () => {
            try {
                const settings = await api.getSettings();
                const intervalSeconds = parseInt(settings.position_poll_interval || '2');

                if (intervalSeconds > 0) {
                    pollIntervalRef.current = setInterval(async () => {
                        await handleRefresh(true);
                    }, intervalSeconds * 1000);
                }
            } catch (err) {
                console.error("Failed to load settings for polling", err);
            }
        };
        startPolling();

        // Timer for UI "ago" update
        const timer = setInterval(() => setUpdater(prev => prev + 1), 1000);

        return () => {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            clearInterval(timer);
        };
    }, [id]);

    useEffect(() => {
        if (position) {
            setSalePrice(position.current_price?.toString() || '');
            setSaleQty(position.quantity?.toString() || '');
            setLastUpdated(new Date());
        }
    }, [position]);

    const loadPosition = async (posId: string) => {
        try {
            setLoading(true);
            const allPositions = await api.getPositions(); // Ideally we'd have a getPositionById API
            const match = allPositions.find(p => p.id.toString() === posId);
            if (match) {
                setPosition(match);
            } else {
                setError('Position not found');
            }
        } catch (err: any) {
            setError(err.message || 'Failed to load position');
        } finally {
            setLoading(false);
        }
    };

    const handleRefresh = async (silent = false) => {
        if (!position) return;
        if (!silent) setRefreshing(true);
        try {
            await api.syncPosition(position.id);
            await loadPosition(position.id.toString());
            setLastUpdated(new Date());
        } catch (err) {
            console.error('Failed to refresh position:', err);
        } finally {
            if (!silent) setRefreshing(false);
        }
    };

    const handleAnalyze = async () => {
        if (!position) return;
        setAnalysisLoading(true);
        try {
            const result = await api.analyzePosition(position.id);
            setAnalysis({ verdict: result.verdict, text: result.analysis });
        } catch (err) {
            console.error(err);
            setAnalysis({ verdict: 'Error', text: 'Failed to generate analysis. Please try again.' });
        } finally {
            setAnalysisLoading(false);
        }
    };

    const handleClosePosition = async () => {
        if (!position) return;
        const price = parseFloat(salePrice);
        const qty = parseInt(saleQty);


        if (isNaN(price) || price <= 0) {
            setCloseError('Please enter a valid sale price.');
            return;
        }
        if (isNaN(qty) || qty <= 0 || qty > (position.quantity || 0)) {
            setCloseError(`Please enter a quantity between 1 and ${position.quantity}.`);
            return;
        }

        setIsClosing(true);
        setCloseError(null);
        try {
            await api.closePosition(position.id, price, qty);
            navigate('/'); // Go back to dashboard on close? Or stay to see report?
            // Staying is better for "Close Trade" tab to show success/closed status.
            await loadPosition(position.id.toString());
        } catch (err: any) {
            setCloseError(err.message || 'Failed to close position');
        } finally {
            setIsClosing(false);
        }
    };

    const formatCurrency = (val: number | undefined) => {
        if (val == null) return '-';
        return `$${Number(val).toFixed(2)}`;
    };

    if (loading) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    if (error || !position) {
        return (
            <div className="container mx-auto p-8 max-w-4xl">
                <Button variant="ghost" className="mb-4 gap-2 pl-0" onClick={() => navigate('/')}>
                    <ArrowLeft className="h-4 w-4" /> Back to Dashboard
                </Button>
                <Alert variant="destructive">
                    <AlertDescription>{error || 'Position not found'}</AlertDescription>
                </Alert>
            </div>
        );
    }

    // Calculations
    const currentPrice = position.current_price ?? 0;
    const entryPrice = position.entry_price ?? 0;
    const quantity = position.quantity ?? 1;
    const marketValue = currentPrice * quantity * 100;
    const costBasis = entryPrice * quantity * 100;
    const unrealizedPnl = marketValue - costBasis;
    const unrealizedPnlPct = entryPrice ? ((Number(currentPrice) - Number(entryPrice)) / Number(entryPrice)) * 100 : 0;
    const isProfit = unrealizedPnl >= 0;
    const dte = Math.ceil((parseLocalDate(position.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const breakEven = position.option_type === 'CALL'
        ? Number(position.strike_price) + Number(entryPrice)
        : Number(position.strike_price) - Number(entryPrice);

    return (
        <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-7xl animate-in fade-in duration-500">
            {/* Header */}
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <Button variant="ghost" className="mb-2 gap-2 pl-0 hover:pl-2 transition-all text-muted-foreground" onClick={() => navigate('/')}>
                        <ArrowLeft className="h-4 w-4" /> Back to Dashboard
                    </Button>
                    <div className="flex items-center gap-3">
                        <h1 className="text-3xl font-bold tracking-tight">{position.symbol}</h1>
                        <Badge variant={position.option_type === 'CALL' ? 'default' : 'secondary'} className="text-sm px-2 py-0.5 sm:px-3 sm:py-1">
                            {position.option_type} ${position.strike_price}
                        </Badge>
                        <Badge variant="outline" className="text-xs font-mono ml-2">
                            Updated {Math.floor((new Date().getTime() - lastUpdated.getTime()) / 1000)}s ago
                        </Badge>
                        <Badge variant="outline" className={cn("text-sm px-2 py-0.5 sm:px-3 sm:py-1 font-bold", isProfit ? 'text-green-600 border-green-200 bg-green-50' : 'text-red-600 border-red-200 bg-red-50')}>
                            {unrealizedPnlPct > 0 ? '+' : ''}{unrealizedPnlPct.toFixed(2)}%
                        </Badge>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className="text-right hidden sm:block">
                        <div className="text-sm text-muted-foreground">Expiration</div>
                        <div className="font-medium">{parseLocalDate(position.expiration_date).toLocaleDateString()} <span className={dte <= 7 ? "text-orange-600 font-bold" : "text-muted-foreground"}>({dte}d)</span></div>
                    </div>
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-10 w-10 shrink-0"
                        onClick={() => handleRefresh(false)}
                        disabled={refreshing}
                        title="Force Refresh Data"
                    >
                        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                    </Button>
                </div>
            </div>

            {/* Main Content */}
            <Tabs defaultValue="details" className="space-y-6">
                <TabsList className="w-full justify-start overflow-x-auto h-auto p-1 bg-muted/50 rounded-lg gap-2">
                    <TabsTrigger value="details" className="px-4 py-2">Overview & Greeks</TabsTrigger>
                    <TabsTrigger value="technical" className="px-4 py-2">Technical Analysis</TabsTrigger>
                    <TabsTrigger value="sims" className="px-4 py-2">Simulations</TabsTrigger>
                    <TabsTrigger value="ai" className="px-4 py-2">AI Insights</TabsTrigger>
                    <TabsTrigger value="close" className="px-4 py-2 text-red-600 dark:text-red-400 font-bold hover:bg-red-50 dark:hover:bg-red-900/10">Manage Trade</TabsTrigger>
                </TabsList>

                {/* DETAILS TAB */}
                <TabsContent value="details" className="space-y-6">
                    {/* Key Metrics Grid */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="p-4 bg-card rounded-xl border shadow-sm">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Total P&L</div>
                            <div className={cn("text-2xl font-mono font-bold tracking-tight", isProfit ? 'text-green-600' : 'text-red-600')}>
                                {unrealizedPnl > 0 ? '+' : ''}{formatCurrency(unrealizedPnl)}
                            </div>
                        </div>
                        <div className="p-4 bg-card rounded-xl border shadow-sm">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Current Price</div>
                            <div className="text-2xl font-mono font-bold tracking-tight">
                                {formatCurrency(position.current_price)}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                                Cost Basis: {formatCurrency(position.entry_price)}
                            </div>
                        </div>
                        <div className="p-4 bg-card rounded-xl border shadow-sm">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Market Value</div>
                            <div className="text-2xl font-mono font-bold tracking-tight">
                                {formatCurrency(marketValue / 100)}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                                {position.quantity} Contracts
                            </div>
                        </div>
                        <div className="p-4 bg-card rounded-xl border shadow-sm">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Break Even</div>
                            <div className="text-2xl font-mono font-bold tracking-tight text-primary">
                                {formatCurrency(breakEven)}
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Greeks */}
                        <div className="p-6 rounded-xl border bg-card shadow-sm space-y-4">
                            <div className="flex items-center gap-2 font-semibold">
                                <BrainCircuit className="h-5 w-5 text-purple-500" /> Option Greeks
                            </div>
                            <div className="grid grid-cols-5 gap-2 text-center">
                                <div className="p-3 bg-blue-50/50 dark:bg-blue-900/10 rounded-lg">
                                    <div className="text-[10px] sm:text-xs font-bold text-blue-600 uppercase mb-1">Delta</div>
                                    <div className="font-mono text-sm sm:text-base">{position.delta?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-3 bg-purple-50/50 dark:bg-purple-900/10 rounded-lg">
                                    <div className="text-[10px] sm:text-xs font-bold text-purple-600 uppercase mb-1">Theta</div>
                                    <div className="font-mono text-sm sm:text-base">{position.theta?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-3 bg-emerald-50/50 dark:bg-emerald-900/10 rounded-lg">
                                    <div className="text-[10px] sm:text-xs font-bold text-emerald-600 uppercase mb-1">Gamma</div>
                                    <div className="font-mono text-sm sm:text-base">{position.gamma?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-3 bg-orange-50/50 dark:bg-orange-900/10 rounded-lg">
                                    <div className="text-[10px] sm:text-xs font-bold text-orange-600 uppercase mb-1">Vega</div>
                                    <div className="font-mono text-sm sm:text-base">{position.vega?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-3 bg-sky-50/50 dark:bg-sky-900/10 rounded-lg">
                                    <div className="text-[10px] sm:text-xs font-bold text-sky-600 uppercase mb-1">IV</div>
                                    <div className="font-mono text-sm sm:text-base">{position.iv?.toFixed(1) ?? '-'}%</div>
                                </div>
                            </div>
                        </div>

                        {/* Risk Management */}
                        <div className="p-6 rounded-xl border bg-card shadow-sm space-y-4">
                            <div className="flex items-center gap-2 font-semibold">
                                <ShieldAlert className="h-5 w-5 text-orange-500" /> Active Risk Controls (Auto-Analysis)
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="p-3 bg-background rounded-lg border">
                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                                        <TrendingDown className="h-3.5 w-3.5" /> Suggested Stop Loss
                                    </div>
                                    <div className="text-lg font-mono font-bold text-red-600">
                                        {position.suggested_stop_loss ? formatCurrency(position.suggested_stop_loss) : '-'}
                                    </div>
                                </div>
                                <div className="p-3 bg-background rounded-lg border">
                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                                        <Target className="h-3.5 w-3.5" /> Suggested Take Profit
                                    </div>
                                    <div className="text-lg font-mono font-bold text-green-600">
                                        {position.suggested_take_profit_1 ? formatCurrency(position.suggested_take_profit_1) : '-'}
                                        {position.suggested_take_profit_2 &&
                                            <span className="text-xs text-muted-foreground ml-2 font-normal">
                                                (L2: {formatCurrency(position.suggested_take_profit_2)})
                                            </span>
                                        }
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* TECHNICAL ANALYSIS TAB */}
                <TabsContent value="technical" className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="lg:col-span-2 p-6 rounded-xl border bg-card shadow-sm">
                            <div className="flex items-center gap-2 font-semibold mb-6">
                                <LineChart className="h-5 w-5 text-blue-500" /> Auto-Generated Technical Levels
                            </div>

                            {!position.suggested_stop_loss ? (
                                <div className="p-12 text-center bg-muted/30 rounded-lg text-muted-foreground">
                                    Technical analysis data is not available. Try adding a new position to see auto-analysis in action.
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    {/* Exits */}
                                    <div className="space-y-4">
                                        <h3 className="text-sm font-semibold uppercase text-muted-foreground">Recommended Exits</h3>
                                        <div className="space-y-3">
                                            <div className="flex justify-between items-center p-3 bg-red-50 dark:bg-red-900/10 rounded-lg border border-red-100 dark:border-red-900/30">
                                                <div className="flex flex-col">
                                                    <span className="text-xs font-bold text-red-600 uppercase">Stop Loss</span>
                                                    <span className="text-[10px] text-red-700/70">Based on ATR Volatility</span>
                                                </div>
                                                <span className="text-xl font-mono font-bold">{formatCurrency(position.suggested_stop_loss)}</span>
                                            </div>

                                            <div className="flex justify-between items-center p-3 bg-green-50 dark:bg-green-900/10 rounded-lg border border-green-100 dark:border-green-900/30">
                                                <div className="flex flex-col">
                                                    <span className="text-xs font-bold text-green-600 uppercase">Take Profit 1</span>
                                                    <span className="text-[10px] text-green-700/70">Conservative Target (2.5x ATR)</span>
                                                </div>
                                                <span className="text-xl font-mono font-bold">{formatCurrency(position.suggested_take_profit_1)}</span>
                                            </div>

                                            <div className="flex justify-between items-center p-3 bg-emerald-50 dark:bg-emerald-900/10 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                                                <div className="flex flex-col">
                                                    <span className="text-xs font-bold text-emerald-600 uppercase">Take Profit 2</span>
                                                    <span className="text-[10px] text-emerald-700/70">Aggressive Target (4.0x ATR)</span>
                                                </div>
                                                <span className="text-xl font-mono font-bold">{formatCurrency(position.suggested_take_profit_2)}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Market Structure */}
                                    <div className="space-y-4">
                                        <h3 className="text-sm font-semibold uppercase text-muted-foreground">Market Structure</h3>
                                        <div className="space-y-3">
                                            <div className="p-4 rounded-lg bg-background border flex justify-between items-center">
                                                <span className="text-sm font-medium text-orange-600">Immediate Resistance</span>
                                                <span className="text-lg font-mono font-bold">{formatCurrency(position.analyzed_resistance)}</span>
                                            </div>
                                            <div className="h-px bg-border my-2 border-dashed"></div>
                                            <div className="p-4 rounded-lg bg-background border flex justify-between items-center">
                                                <span className="text-sm font-medium text-blue-600">Immediate Support</span>
                                                <span className="text-lg font-mono font-bold">{formatCurrency(position.analyzed_support)}</span>
                                            </div>
                                        </div>

                                        {position.analysis_data && (
                                            <div className="mt-6 pt-4 border-t">
                                                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3">Key Indicators</h4>
                                                <div className="grid grid-cols-2 gap-3 text-sm">
                                                    <div className="flex justify-between p-2 bg-muted/50 rounded">
                                                        <span>EMA (9)</span>
                                                        <span className="font-mono">{formatCurrency(position.analysis_data.ema9)}</span>
                                                    </div>
                                                    <div className="flex justify-between p-2 bg-muted/50 rounded">
                                                        <span>EMA (21)</span>
                                                        <span className="font-mono">{formatCurrency(position.analysis_data.ema21)}</span>
                                                    </div>
                                                    <div className="flex justify-between p-2 bg-muted/50 rounded">
                                                        <span>ATR Volatility</span>
                                                        <span className="font-mono">{formatCurrency(position.analysis_data.atr)}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="p-6 rounded-xl border bg-card shadow-sm">
                            <h3 className="text-lg font-semibold mb-4">Why these levels?</h3>
                            <div className="prose prose-sm text-muted-foreground">
                                <p>
                                    These levels are calculated using real-time historical data for {position.symbol}.
                                    We use the <strong>Average True Range (ATR)</strong> to determine volatility-adjusted exits.
                                </p>
                                <ul className="list-disc pl-4 space-y-2 mt-2">
                                    <li><strong>Stop Loss:</strong> Placed 1.5x ATR below your entry to allow for normal market noise.</li>
                                    <li><strong>Take Profit 1:</strong> A high-probability target at 2.5x ATR.</li>
                                    <li><strong>Take Profit 2:</strong> An extended target at 4.0x ATR for trend-following.</li>
                                    <li><strong>Support/Resistance:</strong> Derived from recent Pivot Highs and Lows on the chart.</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* SIMULATIONS TAB */}
                <TabsContent value="sims" className="space-y-4 pt-4">
                    <div className="p-4 bg-muted/30 rounded-lg border space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold flex items-center gap-2">
                                <Activity className="h-4 w-4 text-blue-500" />
                                PnL Simulation (What-If)
                            </h3>
                            <div className="flex items-center gap-2">
                                <div className="flex border rounded-md overflow-hidden bg-background">
                                    <Button
                                        variant={simViewMode === 'table' ? 'default' : 'ghost'}
                                        size="sm"
                                        className="h-8 rounded-none px-3"
                                        onClick={() => setSimViewMode('table')}
                                    >
                                        <List className="h-4 w-4 mr-2" />
                                        Table
                                    </Button>
                                    <Button
                                        variant={simViewMode === 'heatmap' ? 'default' : 'ghost'}
                                        size="sm"
                                        className="h-8 rounded-none px-3"
                                        onClick={() => setSimViewMode('heatmap')}
                                    >
                                        <LayoutGrid className="h-4 w-4 mr-2" />
                                        Heatmap
                                    </Button>
                                </div>
                                {position.underlying_price && (
                                    <Badge variant="outline" className="text-[10px]">
                                        Ref Price: ${position.underlying_price.toFixed(2)}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                            {simViewMode === 'table'
                                ? "Estimates potential returns based on stock price movements using Delta, Gamma, and Theta."
                                : "Profit Zone visualization. X-axis is stock move, Y-axis is days to expiration (Top=Now, Bottom=Exp)."}
                        </p>

                        {position.delta == null && (
                            <div className="py-8 text-center text-sm text-muted-foreground">
                                Greeks are required for simulation. Please refresh the position.
                            </div>
                        )}

                        {position.delta != null && position.underlying_price == null && (
                            <div className="py-8 text-center text-sm text-muted-foreground">
                                Underlying price is required for simulation. Please refresh the position to fetch market data.
                            </div>
                        )}

                        {position.delta != null && position.underlying_price != null && (
                            <>
                                {simViewMode === 'table' ? (
                                    <div className="rounded-md border overflow-hidden">
                                        <table className="w-full text-xs text-left border-collapse">
                                            <thead className="bg-muted/50">
                                                <tr>
                                                    <th className="p-2 border-b">Stock Move</th>
                                                    <th className="p-2 border-b">New Option Price</th>
                                                    <th className="p-2 border-b text-right">Estimated PnL</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {[-15, -10, -5, -2, 0, 2, 5, 10, 15].map((pct) => {
                                                    const stockPrice = position.underlying_price!;
                                                    const dS = stockPrice * (pct / 100);
                                                    const deltaEffect = (position.delta || 0) * dS;
                                                    const gammaEffect = 0.5 * (position.gamma || 0) * Math.pow(dS, 2);
                                                    const estOptionPrice = Math.max(0.01, (position.current_price || 0) + deltaEffect + gammaEffect);
                                                    const estMarketValue = estOptionPrice * (position.quantity || 1) * 100;
                                                    const estPnl = estMarketValue - (position.entry_price * (position.quantity || 1) * 100);
                                                    const estPnlPct = (estOptionPrice - position.entry_price) / position.entry_price * 100;

                                                    return (
                                                        <tr key={pct} className={pct === 0 ? 'bg-primary/10 font-medium' : 'hover:bg-muted/20'}>
                                                            <td className="p-2 border-b">
                                                                <div className="flex items-center gap-1">
                                                                    {pct > 0 ? <TrendingUp className="h-3 w-3 text-green-500" /> : pct < 0 ? <TrendingDown className="h-3 w-3 text-red-500" /> : null}
                                                                    {pct === 0 ? 'Current Price' : `${pct > 0 ? '+' : ''}${pct}% ($${(stockPrice + dS).toFixed(2)})`}
                                                                </div>
                                                            </td>
                                                            <td className="p-2 border-b font-mono">
                                                                ${estOptionPrice.toFixed(2)}
                                                            </td>
                                                            <td className={`p-2 border-b font-mono text-right ${estPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                                {estPnl >= 0 ? '+' : ''}${estPnl.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                                                <span className="text-[10px] ml-1 opacity-70">
                                                                    ({estPnlPct >= 0 ? '+' : ''}{estPnlPct.toFixed(1)}%)
                                                                </span>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-8 gap-1 text-[9px] font-bold text-center text-muted-foreground mb-1">
                                            <div>DTE</div>
                                            {[-10, -5, -2, 0, 2, 5, 10].map(p => <div key={p}>{p}%</div>)}
                                        </div>
                                        {(function () {
                                            const dte = Math.ceil((parseLocalDate(position.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                                            const timePoints = [dte, Math.floor(dte * 0.75), Math.floor(dte * 0.5), Math.floor(dte * 0.25), 0];

                                            return timePoints.map((d) => (
                                                <div key={d} className="grid grid-cols-8 gap-1">
                                                    <div className="flex items-center justify-center text-[10px] font-mono text-muted-foreground border-r">{d}d</div>
                                                    {[-10, -5, -2, 0, 2, 5, 10].map((pct) => {
                                                        const stockPrice = position.underlying_price!;
                                                        const dS = stockPrice * (pct / 100);
                                                        const deltaEffect = (position.delta || 0) * dS;
                                                        const gammaEffect = 0.5 * (position.gamma || 0) * Math.pow(dS, 2);

                                                        const timePassed = dte - d;
                                                        const thetaEffect = (position.theta || 0) * timePassed;

                                                        const estOptionPrice = Math.max(0.01, (position.current_price || 0) + deltaEffect + gammaEffect + thetaEffect);
                                                        const estPnlPct = (estOptionPrice - position.entry_price) / position.entry_price * 100;

                                                        const intensity = Math.min(Math.abs(estPnlPct) / 50, 1);
                                                        const opacity = 0.1 + (intensity * 0.8);

                                                        return (
                                                            <div
                                                                key={pct}
                                                                className={`h-9 flex flex-col items-center justify-center rounded text-[8px] sm:text-[9px] font-mono border border-black/5 transition-premium hover:ring-1 hover:ring-primary`}
                                                                style={{
                                                                    backgroundColor: estPnlPct >= 0 ? `rgba(34, 197, 94, ${opacity})` : `rgba(239, 68, 68, ${opacity})`,
                                                                    color: opacity > 0.6 ? 'white' : 'inherit'
                                                                }}
                                                                title={`Stock: ${(stockPrice + dS).toFixed(2)} (${pct}%) | PnL: ${estPnlPct.toFixed(1)}%`}
                                                            >
                                                                {estPnlPct >= 0 ? '+' : ''}{estPnlPct.toFixed(0)}%
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="ai" className="space-y-4 pt-4">
                    <div className="p-6 bg-card rounded-xl border space-y-4 shadow-sm">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg font-semibold flex items-center gap-2">
                                <BrainCircuit className="h-5 w-5 text-purple-600" />
                                AI Strategy Insights
                            </h3>
                            <Button
                                onClick={handleAnalyze}
                                disabled={analysisLoading}
                                size="sm"
                                className="bg-purple-600 hover:bg-purple-700 text-white"
                            >
                                {analysisLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BrainCircuit className="mr-2 h-4 w-4" />}
                                Generate Analysis
                            </Button>
                        </div>

                        {!analysis ? (
                            <div className="text-center py-12 px-4 border-2 border-dashed rounded-lg">
                                <div className="bg-purple-50 dark:bg-purple-900/10 p-3 rounded-full w-fit mx-auto mb-3">
                                    <BrainCircuit className="h-6 w-6 text-purple-600" />
                                </div>
                                <h4 className="text-base font-medium mb-1">No Analysis Generated</h4>
                                <p className="text-sm text-muted-foreground mb-4">
                                    Tap the button above to have our AI analyze this position's technicals and risk profile.
                                </p>
                                <Button variant="outline" onClick={handleAnalyze} disabled={analysisLoading}>
                                    Generate Now
                                </Button>
                            </div>
                        ) : (
                            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-muted-foreground">Verdict:</span>
                                    <Badge
                                        variant={
                                            analysis.verdict === 'Bullish' ? 'default' :
                                                analysis.verdict === 'Bearish' ? 'destructive' :
                                                    'secondary'
                                        }
                                        className="uppercase tracking-wider"
                                    >
                                        {analysis.verdict}
                                    </Badge>
                                </div>
                                <div className="prose prose-sm dark:prose-invert max-w-none bg-muted/30 p-4 rounded-lg border">
                                    <p className="whitespace-pre-wrap leading-relaxed">
                                        {analysis.text}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </TabsContent>

                {/* CLOSE TAB */}
                <TabsContent value="close" className="space-y-6">
                    <div className="max-w-2xl mx-auto p-8 rounded-xl border bg-background shadow-sm">
                        <div className="flex items-center gap-3 mb-8">
                            <div className="h-10 w-10 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center">
                                <XCircle className="h-6 w-6 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-red-700 dark:text-red-400">Close Position</h3>
                                <p className="text-sm text-muted-foreground">Execute a sell order to close this trade.</p>
                            </div>
                        </div>

                        {closeError && (
                            <Alert variant="destructive" className="mb-6">
                                <AlertDescription>{closeError}</AlertDescription>
                            </Alert>
                        )}

                        <div className="grid grid-cols-2 gap-6 mb-8">
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Sale Price (per contract)</Label>
                                <div className="relative">
                                    <DollarSign className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        type="number"
                                        step="0.01"
                                        className="pl-9 h-11 text-lg"
                                        value={salePrice}
                                        onChange={(e) => setSalePrice(e.target.value)}
                                        placeholder="0.00"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Quantity ({position.quantity} max)</Label>
                                <div className="relative">
                                    <Hash className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        type="number"
                                        className="pl-9 h-11 text-lg"
                                        value={saleQty}
                                        onChange={(e) => setSaleQty(e.target.value)}
                                        placeholder="1"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="bg-muted p-4 rounded-lg mb-8 flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Estimated Realized P&L:</span>
                            <span className="font-mono font-bold text-lg">
                                {(() => {
                                    const p = parseFloat(salePrice) || 0;
                                    const q = parseInt(saleQty) || 0;
                                    const val = (p - position.entry_price) * q * 100;
                                    return <span className={val >= 0 ? "text-green-600" : "text-red-600"}>{val >= 0 ? '+' : ''}{formatCurrency(val / 100)}</span>
                                })()}
                            </span>
                        </div>

                        <Button className="w-full h-12 text-lg bg-red-600 hover:bg-red-700 font-bold" onClick={handleClosePosition} disabled={isClosing}>
                            {isClosing ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <CheckCircle2 className="h-5 w-5 mr-2" />}
                            Submit Order
                        </Button>
                    </div>
                </TabsContent>

            </Tabs>
        </div>
    );
}
