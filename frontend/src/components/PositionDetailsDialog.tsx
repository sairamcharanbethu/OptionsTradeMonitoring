import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrainCircuit, Info, Loader2, TrendingUp, TrendingDown, Target, ShieldAlert, Clock, Calendar, RefreshCw, Activity, CheckCircle2, DollarSign, Hash, XCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Position, api } from '@/lib/api';
import { parseLocalDate } from '@/lib/utils';

interface PositionDetailsDialogProps {
    position: Position;
    onCloseUpdate?: () => void;
}

export default function PositionDetailsDialog({ position: initialPosition, onCloseUpdate }: PositionDetailsDialogProps) {
    const [position, setPosition] = useState<Position>(initialPosition);
    const [analysis, setAnalysis] = useState<{ verdict: string, text: string } | null>(null);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const [salePrice, setSalePrice] = useState<string>('');
    const [saleQty, setSaleQty] = useState<string>('');
    const [closeError, setCloseError] = useState<string | null>(null);

    useEffect(() => {
        if (position) {
            setSalePrice(position.current_price?.toString() || '');
            setSaleQty(position.quantity?.toString() || '');
        }
    }, [position]);

    useEffect(() => {
        setPosition(initialPosition);
    }, [initialPosition]);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await api.syncPosition(position.id);
            const allPositions = await api.getPositions();
            const updated = allPositions.find(p => p.id === position.id);
            if (updated) {
                setPosition(updated);
            }
        } catch (err) {
            console.error('Failed to refresh position:', err);
        } finally {
            setRefreshing(false);
        }
    };

    const handleAnalyze = async () => {
        setLoading(true);
        try {
            const result = await api.analyzePosition(position.id);
            setAnalysis({ verdict: result.verdict, text: result.analysis });
        } catch (err) {
            console.error(err);
            setAnalysis({ verdict: 'Error', text: 'Failed to generate analysis. Please try again.' });
        } finally {
            setLoading(false);
        }
    };

    const handleClosePosition = async () => {
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
            if (onCloseUpdate) onCloseUpdate();
            handleRefresh();
        } catch (err: any) {
            setCloseError(err.message || 'Failed to close position');
        } finally {
            setIsClosing(false);
        }
    };

    const formatCurrency = (val: number | undefined) => val ? `$${val.toFixed(2)}` : '-';

    // Calculations
    const currentPrice = position.current_price || 0;
    const entryPrice = position.entry_price || 0;
    const quantity = position.quantity || 1;
    const marketValue = currentPrice * quantity * 100; // Standard option multiplier
    const costBasis = entryPrice * quantity * 100;
    const unrealizedPnl = marketValue - costBasis;
    const unrealizedPnlPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const isProfit = unrealizedPnl >= 0;

    // Advanced Stats
    const dte = Math.ceil((parseLocalDate(position.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const breakEven = position.option_type === 'CALL'
        ? position.strike_price + entryPrice
        : position.strike_price - entryPrice;

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-500 hover:text-blue-600">
                    <Info className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[650px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <div className="flex items-center justify-between pr-8">
                        <DialogTitle className="flex items-center gap-2">
                            <span className="font-bold">{position.symbol}</span>
                            <Badge variant={position.option_type === 'CALL' ? 'default' : 'secondary'} className="uppercase">
                                {position.option_type} ${position.strike_price}
                            </Badge>
                            <Badge variant="outline" className={isProfit ? 'text-green-600 border-green-200 bg-green-50' : 'text-red-600 border-red-200 bg-red-50'}>
                                {unrealizedPnlPct > 0 ? '+' : ''}{unrealizedPnlPct.toFixed(2)}%
                            </Badge>
                        </DialogTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={handleRefresh}
                            disabled={refreshing}
                            title="Force Refresh Data"
                        >
                            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                        </Button>
                    </div>
                    <div className="flex items-center justify-between">
                        <DialogDescription className="text-xs text-muted-foreground mt-1">
                            Exp: {parseLocalDate(position.expiration_date).toLocaleDateString()} • Break Even: ${breakEven.toFixed(2)} • Updated: {new Date(position.updated_at).toLocaleString()}
                        </DialogDescription>
                        <span className={`text-xs font-normal ${dte <= 7 ? 'text-orange-600 font-bold' : 'text-muted-foreground'}`}>
                            {dte}d left
                        </span>
                    </div>
                </DialogHeader>

                <Tabs defaultValue="details" className="w-full">
                    <TabsList className="grid w-full grid-cols-4">
                        <TabsTrigger value="details">Details & Greeks</TabsTrigger>
                        <TabsTrigger value="sims">Simulations</TabsTrigger>
                        <TabsTrigger value="ai">AI Analysis</TabsTrigger>
                        <TabsTrigger value="close" className="text-red-600 dark:text-red-400 font-bold">Close Trade</TabsTrigger>
                    </TabsList>

                    <TabsContent value="details" className="space-y-6 py-4">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                                <TrendingUp className="h-4 w-4" /> Position Performance
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                <div className="p-3 bg-muted/30 rounded-lg border">
                                    <div className="text-xs text-muted-foreground">Entry Price</div>
                                    <div className="text-lg font-mono font-medium">{formatCurrency(position.entry_price)}</div>
                                </div>
                                <div className="p-3 bg-muted/30 rounded-lg border">
                                    <div className="text-xs text-muted-foreground">Current Price</div>
                                    <div className={`text-lg font-mono font-medium ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                                        {formatCurrency(position.current_price)}
                                    </div>
                                </div>
                                <div className="p-3 bg-muted/30 rounded-lg border">
                                    <div className="text-xs text-muted-foreground">Break Even</div>
                                    <div className="text-lg font-mono font-medium underline decoration-dotted underline-offset-4">
                                        {formatCurrency(breakEven)}
                                    </div>
                                </div>
                                <div className="p-3 bg-muted/30 rounded-lg border">
                                    <div className="text-xs text-muted-foreground">Market Value</div>
                                    <div className="text-lg font-mono font-medium">{formatCurrency(marketValue / 100)}</div>
                                </div>
                                <div className="p-3 bg-muted/30 rounded-lg border">
                                    <div className="text-xs text-muted-foreground">Contracts</div>
                                    <div className="text-lg font-mono font-medium">{position.quantity}</div>
                                </div>
                                <div className="p-3 bg-muted/30 rounded-lg border">
                                    <div className="text-xs text-muted-foreground">Total Open P&L</div>
                                    <div className={`text-lg font-mono font-bold ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                                        {unrealizedPnl > 0 ? '+' : ''}{formatCurrency(unrealizedPnl)}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                                <BrainCircuit className="h-4 w-4" /> Greeks & Volatility
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                                <div className="p-2 text-center rounded bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100">
                                    <div className="text-[10px] uppercase text-blue-600 font-bold">Delta</div>
                                    <div className="font-mono text-sm">{position.delta?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-2 text-center rounded bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100">
                                    <div className="text-[10px] uppercase text-purple-600 font-bold">Theta</div>
                                    <div className="font-mono text-sm">{position.theta?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-2 text-center rounded bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100">
                                    <div className="text-[10px] uppercase text-emerald-600 font-bold">Gamma</div>
                                    <div className="font-mono text-sm">{position.gamma?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-2 text-center rounded bg-orange-50/50 dark:bg-orange-900/10 border border-orange-100">
                                    <div className="text-[10px] uppercase text-orange-600 font-bold">Vega</div>
                                    <div className="font-mono text-sm">{position.vega?.toFixed(3) ?? '-'}</div>
                                </div>
                                <div className="p-2 text-center rounded bg-slate-100 dark:bg-slate-800 border">
                                    <div className="text-[10px] uppercase text-slate-600 font-bold">IV</div>
                                    <div className="font-mono text-sm">{position.iv ? position.iv.toFixed(1) + '%' : '-'}</div>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                                <ShieldAlert className="h-4 w-4" /> Risk Management
                            </div>
                            <div className="grid grid-cols-3 gap-4">
                                <div className="p-3 rounded-lg border bg-background">
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                                        <TrendingDown className="h-3 w-3" /> Stop Loss
                                    </div>
                                    <div className="font-mono font-medium">{formatCurrency(position.stop_loss_trigger)}</div>
                                </div>
                                <div className="p-3 rounded-lg border bg-background">
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                                        <Target className="h-3 w-3" /> Take Profit
                                    </div>
                                    <div className="font-mono font-medium">{formatCurrency(position.take_profit_trigger)}</div>
                                </div>
                                <div className="p-3 rounded-lg border bg-background">
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                                        <TrendingUp className="h-3 w-3" /> Trailing Stop
                                    </div>
                                    <div className="font-mono font-medium">
                                        {position.trailing_stop_loss_pct ? `${position.trailing_stop_loss_pct}%` : '-'}
                                    </div>
                                    {position.trailing_high_price && (
                                        <div className="text-[10px] text-muted-foreground mt-1">High: {formatCurrency(position.trailing_high_price)}</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="sims" className="space-y-4 py-4">
                        <div className="p-4 bg-muted/30 rounded-lg border space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold flex items-center gap-2">
                                    <Activity className="h-4 w-4 text-blue-500" />
                                    PnL Simulation (What-If)
                                </h3>
                                {position.underlying_price && (
                                    <Badge variant="outline" className="text-[10px]">
                                        Ref Price: ${position.underlying_price.toFixed(2)}
                                    </Badge>
                                )}
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                                Estimates potential returns based on stock price movements using Delta, Gamma, and Theta.
                            </p>

                            {!position.delta && (
                                <div className="py-8 text-center text-sm text-muted-foreground">
                                    Greeks are required for simulation. Please refresh the position.
                                </div>
                            )}

                            {position.delta && !position.underlying_price && (
                                <div className="py-8 text-center text-sm text-muted-foreground">
                                    Underlying price is required for simulation. Please refresh the position to fetch market data.
                                </div>
                            )}

                            {position.delta && position.underlying_price && (
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
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="ai" className="space-y-4 py-4 min-h-[300px]">
                        {!analysis && !loading && (
                            <div className="flex flex-col items-center justify-center h-[200px] text-center space-y-4">
                                <BrainCircuit className="h-12 w-12 text-muted-foreground opacity-30" />
                                <div className="max-w-[80%] text-sm text-muted-foreground">
                                    Generate an AI analysis of this position using your configured AI model. It will consider the Greeks, Price Action, and Time Decay.
                                </div>
                                <Button onClick={handleAnalyze} className="gap-2">
                                    <BrainCircuit className="h-4 w-4" />
                                    Generate Analysis
                                </Button>
                            </div>
                        )}

                        {loading && (
                            <div className="flex flex-col items-center justify-center h-[200px] space-y-2">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                                <span className="text-sm text-muted-foreground animate-pulse">Consulting AI...</span>
                            </div>
                        )}

                        {analysis && (
                            <div className="space-y-4">
                                <div className={`p-4 rounded-lg border flex items-center justify-between ${analysis.verdict === 'CLOSE' ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-900/50 dark:text-red-400' :
                                    analysis.verdict === 'HOLD' ? 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-900/50 dark:text-green-400' :
                                        'bg-yellow-50 border-yellow-200 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-900/50 dark:text-yellow-400'
                                    }`}>
                                    <div>
                                        <div className="text-xs font-semibold uppercase tracking-wider opacity-70">Verdict</div>
                                        <div className="text-2xl font-bold">{analysis.verdict}</div>
                                    </div>
                                    {(analysis.verdict === 'CLOSE' || analysis.verdict === 'ADJUST') && <Info className="h-8 w-8 opacity-20" />}
                                </div>

                                <div className="p-4 rounded-md bg-muted/50 text-sm leading-relaxed whitespace-pre-wrap font-sans">
                                    {typeof analysis.text === 'object' ? JSON.stringify(analysis.text, null, 2) : analysis.text}
                                </div>
                                <div className="flex justify-end">
                                    <Button variant="outline" size="sm" onClick={handleAnalyze} disabled={loading}>
                                        Regenerate
                                    </Button>
                                </div>
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="close" className="space-y-4 py-4">
                        {position.status === 'CLOSED' ? (
                            <div className="flex flex-col items-center justify-center h-[200px] text-center space-y-4">
                                <CheckCircle2 className="h-12 w-12 text-green-500 opacity-30" />
                                <div className="text-sm text-muted-foreground">This position is already closed.</div>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                <div className="p-4 bg-red-50/30 rounded-lg border border-red-100 dark:bg-red-900/10 dark:border-red-900/30">
                                    <div className="flex items-center gap-2 mb-4">
                                        <XCircle className="h-5 w-5 text-red-600" />
                                        <h4 className="text-sm font-bold text-red-700 dark:text-red-400">Manual Position Close</h4>
                                    </div>

                                    {closeError && (
                                        <Alert variant="destructive" className="mb-4 py-2 px-3">
                                            <AlertDescription className="text-xs">{closeError}</AlertDescription>
                                        </Alert>
                                    )}

                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-2">
                                            <Label htmlFor="salePrice" className="text-xs font-semibold">Sale Price (per contract)</Label>
                                            <div className="relative">
                                                <DollarSign className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                                <Input
                                                    id="salePrice"
                                                    type="number"
                                                    step="0.01"
                                                    className="pl-9 h-10"
                                                    value={salePrice}
                                                    onChange={(e) => setSalePrice(e.target.value)}
                                                    placeholder="0.00"
                                                />
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <Label htmlFor="saleQty" className="text-xs font-semibold">Quantity to Sell (Max: {position.quantity})</Label>
                                            <div className="relative">
                                                <Hash className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                                <Input
                                                    id="saleQty"
                                                    type="number"
                                                    className="pl-9 h-10"
                                                    value={saleQty}
                                                    onChange={(e) => setSaleQty(e.target.value)}
                                                    placeholder="1"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-6 flex flex-col gap-3">
                                        <div className="text-[10px] text-muted-foreground bg-muted/50 p-2 rounded">
                                            Selling <strong>{saleQty}</strong> contracts at <strong>${salePrice}</strong> will result in a realized PnL of
                                            <strong> ${((parseFloat(salePrice) - position.entry_price) * parseInt(saleQty || '0') * 100).toFixed(2)}</strong>.
                                        </div>
                                        <Button
                                            className="w-full bg-red-600 hover:bg-red-700 text-white h-11 gap-2 text-base font-bold"
                                            onClick={handleClosePosition}
                                            disabled={isClosing}
                                        >
                                            {isClosing ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
                                            Execute Close Order
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
