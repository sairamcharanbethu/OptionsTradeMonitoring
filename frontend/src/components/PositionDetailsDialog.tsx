import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrainCircuit, Info, Loader2, TrendingUp, TrendingDown, Target, ShieldAlert, Clock, Calendar } from 'lucide-react';
import { Position, api } from '@/lib/api';

interface PositionDetailsDialogProps {
    position: Position;
}

export default function PositionDetailsDialog({ position }: PositionDetailsDialogProps) {
    const [analysis, setAnalysis] = useState<{ verdict: string, text: string } | null>(null);
    const [loading, setLoading] = useState(false);

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

    const formatCurrency = (val: number | undefined) => val ? `$${val.toFixed(2)}` : '-';
    const formatPercent = (val: number | undefined) => val ? `${val.toFixed(2)}%` : '-';

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
    const dte = Math.ceil((new Date(position.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
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
                    <DialogTitle className="flex items-center gap-2">
                        <span className="font-bold">{position.symbol}</span>
                        <Badge variant={position.option_type === 'CALL' ? 'default' : 'secondary'} className="uppercase">
                            {position.option_type} ${position.strike_price}
                        </Badge>
                        <Badge variant="outline" className={isProfit ? 'text-green-600 border-green-200 bg-green-50' : 'text-red-600 border-red-200 bg-red-50'}>
                            {unrealizedPnlPct > 0 ? '+' : ''}{unrealizedPnlPct.toFixed(2)}%
                        </Badge>
                        <span className={`text-xs font-normal ml-auto ${dte <= 7 ? 'text-orange-600 font-bold' : 'text-muted-foreground'}`}>
                            {dte}d left
                        </span>
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                        Exp: {new Date(position.expiration_date).toLocaleDateString()} • Break Even: ${breakEven.toFixed(2)}
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="details" className="w-full">
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="details">Details & Greeks</TabsTrigger>
                        <TabsTrigger value="ai">AI Analysis</TabsTrigger>
                    </TabsList>

                    <TabsContent value="details" className="space-y-6 py-4">
                        {/* PERFORMANCE SECTION */}
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

                        {/* GREEKS SECTION */}
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

                        {/* RISK MANAGEMENT SECTION */}
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

                        {/* META SECTION */}
                        <div className="pt-4 border-t flex flex-col gap-1 text-[10px] text-muted-foreground">
                            <div className="flex items-center gap-2">
                                <Clock className="h-3 w-3" /> Last Updated: {new Date(position.updated_at).toLocaleString()}
                            </div>
                            <div className="flex items-center gap-2">
                                <Calendar className="h-3 w-3" /> Opened: {new Date(position.created_at).toLocaleString()}
                            </div>
                            <div>Internal ID: #{position.id}</div>
                        </div>
                    </TabsContent>

                    <TabsContent value="ai" className="space-y-4 py-4 min-h-[300px]">
                        {!analysis && !loading && (
                            <div className="flex flex-col items-center justify-center h-[200px] text-center space-y-4">
                                <BrainCircuit className="h-12 w-12 text-muted-foreground opacity-30" />
                                <div className="max-w-[80%] text-sm text-muted-foreground">
                                    Generate an AI analysis of this position using your local Mistral model. It will consider the Greeks, Price Action, and Time Decay.
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
                                <span className="text-sm text-muted-foreground animate-pulse">Consulting Mistral...</span>
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
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
