
import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrainCircuit, Info, Loader2 } from 'lucide-react';
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

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-500 hover:text-blue-600">
                    <Info className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <span className="font-bold">{position.symbol}</span>
                        <Badge variant="outline">{position.option_type} ${position.strike_price}</Badge>
                        <span className="text-xs text-muted-foreground font-normal ml-auto">
                            Exp: {new Date(position.expiration_date).toLocaleDateString()}
                        </span>
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                        Position details, Greeks analytics, and AI-powered insights.
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="greeks" className="w-full">
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="greeks">Greeks & Stats</TabsTrigger>
                        <TabsTrigger value="ai">AI Analysis</TabsTrigger>
                    </TabsList>

                    <TabsContent value="greeks" className="space-y-4 py-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="p-4 rounded-lg bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30">
                                <div className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-1">Delta (Δ)</div>
                                <div className="text-2xl font-bold">{position.delta ? position.delta.toFixed(3) : '-'}</div>
                                <div className="text-[10px] text-muted-foreground">Prob. In-The-Money</div>
                            </div>
                            <div className="p-4 rounded-lg bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-900/30">
                                <div className="text-sm font-medium text-purple-600 dark:text-purple-400 mb-1">Theta (Θ)</div>
                                <div className="text-2xl font-bold">{position.theta ? position.theta.toFixed(3) : '-'}</div>
                                <div className="text-[10px] text-muted-foreground">$ Decay per Day</div>
                            </div>
                            <div className="p-4 rounded-lg bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30">
                                <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400 mb-1">Gamma (Γ)</div>
                                <div className="text-2xl font-bold">{position.gamma ? position.gamma.toFixed(4) : '-'}</div>
                                <div className="text-[10px] text-muted-foreground">Delta Sensitivity</div>
                            </div>
                            <div className="p-4 rounded-lg bg-orange-50/50 dark:bg-orange-900/10 border border-orange-100 dark:border-orange-900/30">
                                <div className="text-sm font-medium text-orange-600 dark:text-orange-400 mb-1">Vega (ν)</div>
                                <div className="text-2xl font-bold">{position.vega ? position.vega.toFixed(3) : '-'}</div>
                                <div className="text-[10px] text-muted-foreground">Volatility Sensitivity</div>
                            </div>
                        </div>

                        <div className="p-4 rounded-lg bg-muted/50">
                            <div className="flex justify-between items-center">
                                <span className="font-medium">Implied Volatility (IV)</span>
                                <span className="font-mono font-bold text-lg">{position.iv ? position.iv.toFixed(2) + '%' : 'N/A'}</span>
                            </div>
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
