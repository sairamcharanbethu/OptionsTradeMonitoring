import React, { useState, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, Goal, GoalEntry, GoalInsights } from '@/lib/api';
import { useGoals, useGoalEntries, useGoalInsights, GOAL_QUERY_KEYS } from '@/hooks/useGoalData';
import { format, parseISO } from 'date-fns';
import {
    Card, CardContent, CardHeader, CardTitle
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger
} from '@/components/ui/dialog';
import {
    Target, Plus, Trash2, Edit3, TrendingUp, TrendingDown,
    Calendar, DollarSign, Loader2, Rocket, AlertTriangle,
    CheckCircle2, ArrowRight, Flame, Trophy, BarChart3, Check, X
} from 'lucide-react';
import {
    Area, ResponsiveContainer, XAxis, YAxis,
    CartesianGrid, Tooltip as RechartsTooltip, ReferenceLine,
    Line, ComposedChart, Bar, Cell
} from 'recharts';

// ─── US Trading-Day Helpers (matches backend) ───
function marketDateKey(date: Date): string {
    return format(date, 'yyyy-MM-dd');
}

function getUSMarketHolidays(year: number): Set<string> {
    const holidays = new Set<string>();
    const add = (m: number, d: number) => {
        let dt = new Date(year, m - 1, d);
        if (dt.getDay() === 6) dt = new Date(year, m - 1, d - 1);
        if (dt.getDay() === 0) dt = new Date(year, m - 1, d + 1);
        holidays.add(marketDateKey(dt));
    };
    add(1, 1); add(6, 19); add(7, 4); add(12, 25);

    const nthWeekday = (month: number, wd: number, n: number) => {
        const first = new Date(year, month - 1, 1);
        let d = 1 + ((wd - first.getDay() + 7) % 7) + (n - 1) * 7;
        return new Date(year, month - 1, d);
    };
    const lastWeekday = (month: number, wd: number) => {
        const last = new Date(year, month, 0);
        return new Date(year, month - 1, last.getDate() - ((last.getDay() - wd + 7) % 7));
    };

    [nthWeekday(1, 1, 3), nthWeekday(2, 1, 3), lastWeekday(5, 1),
    nthWeekday(9, 1, 1), nthWeekday(11, 4, 4)].forEach(d =>
        holidays.add(marketDateKey(d))
    );

    // Good Friday
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const mo = Math.floor((h + l - 7 * mm + 114) / 31), dy = ((h + l - 7 * mm + 114) % 31) + 1;
    const gf = new Date(year, mo - 1, dy); gf.setDate(gf.getDate() - 2);
    holidays.add(marketDateKey(gf));

    return holidays;
}

function tradingDaysBetween(from: Date, to: Date): number {
    if (to <= from) return 0;
    const holidays = new Set<string>();
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++)
        getUSMarketHolidays(y).forEach(h => holidays.add(h));
    let count = 0;
    const cursor = new Date(from); cursor.setHours(0, 0, 0, 0);
    const end = new Date(to); end.setHours(0, 0, 0, 0);
    while (cursor < end) {
        const dow = cursor.getDay();
        if (dow !== 0 && dow !== 6 && !holidays.has(marketDateKey(cursor))) count++;
        cursor.setDate(cursor.getDate() + 1);
    }
    return count;
}

function parseGoalDate(value: string): Date {
    const d = new Date(value);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function toDateKey(date: Date): string {
    return marketDateKey(date);
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function addTradingDays(date: Date, days: number): Date {
    const holidays = new Set<string>();
    const startYear = date.getFullYear();
    for (let y = startYear; y <= startYear + 5; y++)
        getUSMarketHolidays(y).forEach(h => holidays.add(h));

    const cursor = new Date(date);
    cursor.setHours(0, 0, 0, 0);
    let added = 0;
    while (added < days) {
        cursor.setDate(cursor.getDate() + 1);
        const dow = cursor.getDay();
        if (dow !== 0 && dow !== 6 && !holidays.has(toDateKey(cursor))) {
            added++;
        }
    }
    return cursor;
}

// ─── Status Badge Component ───
function StatusBadge({ status }: { status: string }) {
    const config: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
        COMPLETED: { label: 'Goal Reached! 🎉', className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30', icon: <CheckCircle2 className="h-3 w-3" /> },
        AHEAD: { label: 'Ahead of Pace', className: 'bg-green-500/15 text-green-600 border-green-500/30', icon: <Rocket className="h-3 w-3" /> },
        ON_TRACK: { label: 'On Track', className: 'bg-blue-500/15 text-blue-600 border-blue-500/30', icon: <TrendingUp className="h-3 w-3" /> },
        AT_RISK: { label: 'At Risk', className: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30', icon: <AlertTriangle className="h-3 w-3" /> },
        BEHIND: { label: 'Behind Pace', className: 'bg-red-500/15 text-red-600 border-red-500/30', icon: <TrendingDown className="h-3 w-3" /> },
    };
    const c = config[status] || config.ON_TRACK;
    return (
        <Badge variant="outline" className={`${c.className} gap-1.5 px-3 py-1 text-xs font-semibold`}>
            {c.icon} {c.label}
        </Badge>
    );
}

// ─── Create/Edit Goal Dialog ───
function GoalFormDialog({
    goal,
    open,
    onOpenChange,
    onSaved
}: {
    goal?: Goal;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
}) {
    const [name, setName] = useState(goal?.name || '');
    const [targetAmount, setTargetAmount] = useState(goal?.target_amount?.toString() || '');
    const [startDate, setStartDate] = useState(goal?.start_date?.split('T')[0] || new Date().getFullYear() + '-01-01');
    const [endDate, setEndDate] = useState(goal?.end_date?.split('T')[0] || new Date().getFullYear() + '-12-31');
    const [saving, setSaving] = useState(false);

    // Reset form when dialog opens or goal changes
    useEffect(() => {
        if (open) {
            setName(goal?.name || '');
            setTargetAmount(goal?.target_amount?.toString() || '');
            setStartDate(goal?.start_date?.split('T')[0] || new Date().getFullYear() + '-01-01');
            setEndDate(goal?.end_date?.split('T')[0] || new Date().getFullYear() + '-12-31');
            setSaving(false);
        }
    }, [open, goal]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            if (goal) {
                await api.updateGoal(goal.id, { name, target_amount: parseFloat(targetAmount), start_date: startDate, end_date: endDate });
            } else {
                await api.createGoal({ name, target_amount: parseFloat(targetAmount), start_date: startDate, end_date: endDate });
            }
            onSaved();
            onOpenChange(false);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[450px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Target className="h-5 w-5 text-primary" />
                        {goal ? 'Edit Goal' : 'Create New Goal'}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Goal Name</label>
                        <Input placeholder="e.g. 2026 Income Goal" value={name} onChange={e => setName(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Target Amount ($)</label>
                        <Input type="number" step="0.01" min="1" placeholder="75000" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} required />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Start Date</label>
                            <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="[color-scheme:light] dark:[color-scheme:dark]" required />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">End Date</label>
                            <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="[color-scheme:light] dark:[color-scheme:dark]" required />
                        </div>
                    </div>
                    <Button type="submit" className="w-full" disabled={saving}>
                        {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                        {goal ? 'Update Goal' : 'Create Goal'}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// ─── Add Entry Dialog ───
function AddEntryDialog({
    goalId,
    open,
    onOpenChange,
    onSaved,
    editEntry,
    usdToCadRate,
}: {
    goalId: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
    editEntry?: GoalEntry;
    usdToCadRate: number;
}) {
    const [entryDate, setEntryDate] = useState(editEntry?.entry_date?.split('T')[0] || format(new Date(), 'yyyy-MM-dd'));
    const [amount, setAmount] = useState(editEntry?.amount?.toString() || '');
    const [notes, setNotes] = useState(editEntry?.notes || '');
    const [saving, setSaving] = useState(false);
    const [currency, setCurrency] = useState<'USD' | 'CAD'>('USD');

    // Reset form when dialog opens or entry changes
    useEffect(() => {
        if (open) {
            setEntryDate(editEntry?.entry_date?.split('T')[0] || format(new Date(), 'yyyy-MM-dd'));
            setAmount(editEntry?.amount?.toString() || '');
            setNotes(editEntry?.notes || '');
            setSaving(false);
            setCurrency('USD');
        }
    }, [open, editEntry]);

    const parsedAmount = parseFloat(amount);
    const hasValidAmount = amount !== '' && !isNaN(parsedAmount);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            // Always store in USD — convert from CAD if needed
            const amountUSD = currency === 'CAD' ? parsedAmount / usdToCadRate : parsedAmount;
            if (editEntry) {
                await api.updateGoalEntry(goalId, editEntry.id, { entry_date: entryDate, amount: amountUSD, notes });
            } else {
                await api.addGoalEntry(goalId, { entry_date: entryDate, amount: amountUSD, notes: notes || undefined });
            }
            onSaved();
            onOpenChange(false);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[400px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <DollarSign className="h-5 w-5 text-green-500" />
                        {editEntry ? 'Edit Entry' : 'Log Earnings'}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Date</label>
                        <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} required />
                    </div>

                    {/* Amount field with currency toggle */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium">Amount ({currency})</label>
                            {/* USD / CAD pill toggle */}
                            <div className="flex items-center bg-muted/50 p-0.5 rounded-md">
                                <button
                                    type="button"
                                    onClick={() => setCurrency('USD')}
                                    className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors ${
                                        currency === 'USD'
                                            ? 'bg-background shadow-sm text-foreground'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                >
                                    USD
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setCurrency('CAD')}
                                    className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors ${
                                        currency === 'CAD'
                                            ? 'bg-background shadow-sm text-foreground'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                >
                                    CAD
                                </button>
                            </div>
                        </div>
                        <Input
                            type="number"
                            step="0.01"
                            placeholder={currency === 'CAD' ? '685.00' : '500.00'}
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                            required
                        />
                        {/* Live conversion preview */}
                        {hasValidAmount && (
                            <p className="text-xs text-muted-foreground">
                                {currency === 'CAD' ? (
                                    <>≈ <span className="font-medium text-foreground">${(parsedAmount / usdToCadRate).toFixed(2)} USD</span> will be saved&nbsp;&bull;&nbsp;Rate: {usdToCadRate.toFixed(4)} CAD/USD</>
                                ) : (
                                    <>≈ <span className="font-medium text-foreground">${(parsedAmount * usdToCadRate).toFixed(2)} CAD</span>&nbsp;&bull;&nbsp;Rate: {usdToCadRate.toFixed(4)} CAD/USD</>
                                )}
                            </p>
                        )}
                        {/* Always show rate hint even without an amount */}
                        {!hasValidAmount && (
                            <p className="text-xs text-muted-foreground">
                                Live rate: 1 USD = {usdToCadRate.toFixed(4)} CAD
                            </p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium">Notes (optional)</label>
                        <Input placeholder="e.g. SPY calls profit" value={notes} onChange={e => setNotes(e.target.value)} />
                    </div>
                    <Button type="submit" className="w-full" disabled={saving}>
                        {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                        {editEntry ? 'Update Entry' : 'Add Entry'}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}


// ─── Main GoalTracker Component ───
export default function GoalTracker() {
    const queryClient = useQueryClient();
    const { data: goals = [], isLoading: goalsLoading } = useGoals();

    const [usdToCadRate, setUsdToCadRate] = useState<number>(1.37);

    useEffect(() => {
        fetch('https://open.er-api.com/v6/latest/USD')
            .then(res => res.json())
            .then(data => {
                if (data && data.rates && data.rates.CAD) {
                    setUsdToCadRate(data.rates.CAD);
                }
            })
            .catch(err => console.error('Failed to fetch exchange rate:', err));
    }, []);

    const formatCurrency = (val: number, includeCAD = true, fractionDigits = 2, showPlus = false): React.ReactNode => {
        const isNegative = val < 0;
        const absVal = Math.abs(val);
        const prefix = isNegative ? '-' : (showPlus ? '+' : '');
        const usdStr = `${prefix}$${absVal.toLocaleString(undefined, { 
            minimumFractionDigits: fractionDigits, 
            maximumFractionDigits: fractionDigits 
        })}`;
        
        if (!includeCAD) {
            return usdStr;
        }
        
        const cadVal = absVal * usdToCadRate;
        const cadStr = `${prefix}$${cadVal.toLocaleString(undefined, { 
            minimumFractionDigits: fractionDigits, 
            maximumFractionDigits: fractionDigits 
        })} CAD`;
        
        return (
            <span>
                {usdStr} <span className="text-[0.75em] text-muted-foreground font-normal">({cadStr})</span>
            </span>
        );
    };

    const [selectedGoalId, setSelectedGoalId] = useState<number | null>(null);
    const [goalDialogOpen, setGoalDialogOpen] = useState(false);
    const [editingGoal, setEditingGoal] = useState<Goal | undefined>(undefined);
    const [entryDialogOpen, setEntryDialogOpen] = useState(false);
    const [editingEntry, setEditingEntry] = useState<GoalEntry | undefined>(undefined);

    // New features state
    const [timeframe, setTimeframe] = useState<'1W' | '1M' | '3M' | 'YTD' | 'ALL'>('ALL');
    const [inlineEditId, setInlineEditId] = useState<number | null>(null);
    const [inlineAmount, setInlineAmount] = useState('');
    const [inlineNotes, setInlineNotes] = useState('');
    const [inlineSaving, setInlineSaving] = useState(false);

    // Auto-select first goal
    const activeGoalId = selectedGoalId ?? (goals.length > 0 ? goals[0].id : null);

    const { data: entries = [], isLoading: entriesLoading } = useGoalEntries(activeGoalId);
    const { data: insights, isLoading: insightsLoading } = useGoalInsights(activeGoalId);

    const activeGoal = goals.find(g => g.id === activeGoalId);

    const invalidateAll = () => {
        queryClient.invalidateQueries({ queryKey: GOAL_QUERY_KEYS.goals });
        if (activeGoalId) {
            queryClient.invalidateQueries({ queryKey: GOAL_QUERY_KEYS.goalEntries(activeGoalId) });
            queryClient.invalidateQueries({ queryKey: GOAL_QUERY_KEYS.goalInsights(activeGoalId) });
        }
    };

    const handleDeleteGoal = async () => {
        if (!activeGoalId) return;
        if (!confirm('Delete this goal and all its entries?')) return;
        try {
            await api.deleteGoal(activeGoalId);
            setSelectedGoalId(null);
            invalidateAll();
        } catch (err: any) {
            alert(err.message);
        }
    };

    const handleDeleteEntry = async (entryId: number) => {
        if (!activeGoalId) return;
        if (!confirm('Delete this earning entry?')) return;
        try {
            await api.deleteGoalEntry(activeGoalId, entryId);
            invalidateAll();
        } catch (err: any) {
            alert(err.message);
        }
    };

    const handleInlineSave = async (entryId: number) => {
        if (!activeGoalId) return;
        const parsedInlineAmount = parseFloat(inlineAmount);
        if (inlineAmount.trim() === '' || !Number.isFinite(parsedInlineAmount)) {
            alert('Enter a valid amount before saving.');
            return;
        }
        setInlineSaving(true);
        try {
            const entry = entries.find(e => e.id === entryId);
            if (!entry) throw new Error("Entry not found");
            await api.updateGoalEntry(activeGoalId, entryId, {
                entry_date: entry.entry_date.split('T')[0],
                amount: parsedInlineAmount,
                notes: inlineNotes || undefined
            });
            setInlineEditId(null);
            invalidateAll();
        } catch (err: any) {
            alert(err.message);
        } finally {
            setInlineSaving(false);
        }
    };

    // ─── Cumulative chart data ───
    const chartData = useMemo(() => {
        if (!entries.length || !activeGoal) return [];

        const sorted = [...entries].sort((a, b) =>
            new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime()
        );

        const targetAmount = Number(activeGoal.target_amount);
        const startDate = parseGoalDate(activeGoal.start_date);
        const endDate = parseGoalDate(activeGoal.end_date);
        const totalTradingDays = Math.max(1, tradingDaysBetween(startDate, addDays(endDate, 1)));
        const dailyIdeal = targetAmount / totalTradingDays;

        let cumulative = 0;
        return sorted.map(entry => {
            cumulative += Number(entry.amount);
            const entryDate = parseGoalDate(entry.entry_date);

            const tradingDaysElapsed = tradingDaysBetween(startDate, entryDate);
            const idealAtDay = dailyIdeal * tradingDaysElapsed;

            return {
                date: format(entryDate, 'MMM d'),
                rawDate: entryDate,
                earned: Math.round(cumulative * 100) / 100,
                ideal: Math.round(idealAtDay * 100) / 100,
                dailyAmount: Number(entry.amount),
            };
        });
    }, [entries, activeGoal]);

    // Apply Timeframe Filter
    const { filteredChartData, filteredEntries } = useMemo(() => {
        if (timeframe === 'ALL') return { filteredChartData: chartData, filteredEntries: entries };

        const now = new Date();
        now.setHours(0, 0, 0, 0);
        let cutoff = new Date(now);

        if (timeframe === '1W') cutoff.setDate(now.getDate() - 7);
        else if (timeframe === '1M') cutoff.setMonth(now.getMonth() - 1);
        else if (timeframe === '3M') cutoff.setMonth(now.getMonth() - 3);
        else if (timeframe === 'YTD') cutoff = new Date(now.getFullYear(), 0, 1);

        const fEntries = entries.filter(e => {
            const localDate = parseGoalDate(e.entry_date);
            return localDate >= cutoff;
        });

        const fChart = chartData.filter(d => d.rawDate >= cutoff);

        return { filteredChartData: fChart, filteredEntries: fEntries };
    }, [chartData, entries, timeframe]);

    const dailySummaries = useMemo(() => {
        const byDate = new Map<string, { date: Date; amount: number; count: number }>();
        for (const entry of entries) {
            const date = parseGoalDate(entry.entry_date);
            const key = toDateKey(date);
            const current = byDate.get(key) || { date, amount: 0, count: 0 };
            current.amount += Number(entry.amount);
            current.count += 1;
            byDate.set(key, current);
        }
        return [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
    }, [entries]);

    const bestWorstDays = useMemo(() => {
        const profitDays = dailySummaries.filter(day => day.amount > 0);
        const lossDays = dailySummaries.filter(day => day.amount < 0);
        return {
            best: profitDays.length > 0 ? profitDays.reduce((best, day) => day.amount > best.amount ? day : best, profitDays[0]) : null,
            worst: lossDays.length > 0 ? lossDays.reduce((worst, day) => day.amount < worst.amount ? day : worst, lossDays[0]) : null
        };
    }, [dailySummaries]);

    const monthlyBreakdown = useMemo(() => {
        if (!activeGoal) return [];
        const targetAmount = Number(activeGoal.target_amount);
        const goalStart = parseGoalDate(activeGoal.start_date);
        const goalEnd = parseGoalDate(activeGoal.end_date);
        const totalTradingDays = Math.max(1, tradingDaysBetween(goalStart, addDays(goalEnd, 1)));
        const amountsByMonth = new Map<string, number>();

        for (const entry of entries) {
            const date = parseGoalDate(entry.entry_date);
            const key = format(date, 'yyyy-MM');
            amountsByMonth.set(key, (amountsByMonth.get(key) || 0) + Number(entry.amount));
        }

        const months: Array<{ key: string; label: string; earned: number; pace: number; delta: number }> = [];
        const cursor = new Date(goalStart.getFullYear(), goalStart.getMonth(), 1);
        const lastMonth = new Date(goalEnd.getFullYear(), goalEnd.getMonth(), 1);

        while (cursor <= lastMonth) {
            const monthStart = new Date(cursor);
            const monthEndExclusive = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            const overlapStart = monthStart < goalStart ? goalStart : monthStart;
            const overlapEnd = monthEndExclusive > addDays(goalEnd, 1) ? addDays(goalEnd, 1) : monthEndExclusive;
            const tradingDays = Math.max(0, tradingDaysBetween(overlapStart, overlapEnd));
            const pace = (targetAmount / totalTradingDays) * tradingDays;
            const key = format(monthStart, 'yyyy-MM');
            const earned = amountsByMonth.get(key) || 0;
            months.push({
                key,
                label: format(monthStart, 'MMM yyyy'),
                earned,
                pace,
                delta: earned - pace
            });
            cursor.setMonth(cursor.getMonth() + 1);
        }

        return months;
    }, [entries, activeGoal]);

    const heatmapWeeks = useMemo(() => {
        const amountsByDate = new Map(dailySummaries.map(day => [toDateKey(day.date), day.amount]));
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = addDays(today, -55);
        const weeks: Array<Array<{ key: string; date: Date; amount: number }>> = [];

        for (let week = 0; week < 8; week++) {
            const days = [];
            for (let day = 0; day < 7; day++) {
                const date = addDays(start, week * 7 + day);
                const key = toDateKey(date);
                days.push({ key, date, amount: amountsByDate.get(key) || 0 });
            }
            weeks.push(days);
        }

        return weeks;
    }, [dailySummaries]);

    const milestoneProgress = useMemo(() => {
        if (!activeGoal) return [];
        const targetAmount = Number(activeGoal.target_amount);
        const milestones = [25, 50, 75, 100];
        const reached = new Map<number, { date: Date; amount: number }>();
        let cumulative = 0;

        for (const day of dailySummaries) {
            cumulative += day.amount;
            for (const marker of milestones) {
                if (!reached.has(marker) && cumulative >= targetAmount * (marker / 100)) {
                    reached.set(marker, { date: day.date, amount: cumulative });
                }
            }
        }

        return milestones.map(marker => ({
            marker,
            target: targetAmount * (marker / 100),
            reached: reached.get(marker) || null
        }));
    }, [dailySummaries, activeGoal]);

    const heatmapMaxAmount = Math.max(1, ...dailySummaries.map(day => Math.abs(day.amount)));
    const paceDeltaAmount = insights
        ? insights.totalEarned - (insights.targetAmount * (insights.expectedPercent / 100))
        : 0;
    const remainingAmount = insights ? Math.max(0, insights.targetAmount - insights.totalEarned) : 0;
    const requiredMonthlyPace = insights ? Math.max(0, insights.remainingPerDay * 21) : 0;
    const forecastText = useMemo(() => {
        if (!insights) return null;
        if (insights.totalEarned >= insights.targetAmount) return 'Goal reached';
        if (insights.dailyAverage <= 0) return 'Forecast unavailable until average turns positive';
        const tradingDaysNeeded = Math.ceil((insights.targetAmount - insights.totalEarned) / insights.dailyAverage);
        const forecastDate = addTradingDays(new Date(), Math.max(1, tradingDaysNeeded));
        const goalEnd = parseGoalDate(activeGoal?.end_date || new Date().toISOString());
        const timing = forecastDate <= goalEnd ? 'Projected finish' : 'Projected after target date';
        return `${timing}: ${format(forecastDate, 'MMM d, yyyy')}`;
    }, [insights, activeGoal]);
    const paceDeltaIsAhead = paceDeltaAmount >= 0;
    const getHeatmapCellClass = (amount: number) => {
        if (amount === 0) return 'bg-muted border-border/60';
        const intensity = Math.min(1, Math.abs(amount) / heatmapMaxAmount);
        if (amount > 0) {
            if (intensity >= 0.75) return 'bg-green-500 border-green-400';
            if (intensity >= 0.4) return 'bg-green-500/70 border-green-500/50';
            return 'bg-green-500/35 border-green-500/30';
        }
        if (intensity >= 0.75) return 'bg-red-500 border-red-400';
        if (intensity >= 0.4) return 'bg-red-500/70 border-red-500/50';
        return 'bg-red-500/35 border-red-500/30';
    };

    // ─── Progress percentage for slider ───
    const progressPercent = insights?.percentComplete ?? 0;
    const clampedProgressPercent = Math.max(0, Math.min(100, progressPercent));
    const clampedExpectedPercent = Math.max(0, Math.min(100, insights?.expectedPercent ?? 0));
    const progressColor = insights?.status === 'COMPLETED' ? '#10b981'
        : insights?.status === 'AHEAD' ? '#22c55e'
            : insights?.status === 'ON_TRACK' ? '#3b82f6'
                : insights?.status === 'AT_RISK' ? '#eab308'
                    : '#ef4444';

    if (goalsLoading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-4 sm:space-y-6">
            {/* Goal Selector Bar */}
            <Card className="border-primary/20">
                <CardContent className="py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            <Target className="h-5 w-5 text-primary shrink-0" />
                            <h2 className="text-lg font-bold truncate">Goal Tracker</h2>
                        </div>

                        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                            {goals.length > 0 && (
                                <Select
                                    value={activeGoalId?.toString() || ''}
                                    onValueChange={v => setSelectedGoalId(parseInt(v))}
                                >
                                    <SelectTrigger className="h-9 min-w-0 flex-1 text-xs sm:w-[200px] sm:flex-none">
                                        <SelectValue placeholder="Select a goal" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {goals.map(g => (
                                            <SelectItem key={g.id} value={g.id.toString()}>
                                                {g.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}

                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => { setEditingGoal(undefined); setGoalDialogOpen(true); }}
                                className="flex-1 gap-1 text-xs sm:flex-none"
                            >
                                <Plus className="h-3 w-3" />
                                New Goal
                            </Button>

                            {activeGoal && (
                                <>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-9 w-9"
                                        onClick={() => { setEditingGoal(activeGoal); setGoalDialogOpen(true); }}
                                    >
                                        <Edit3 className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-9 w-9 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                                        onClick={handleDeleteGoal}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {!activeGoal ? (
                <Card>
                    <CardContent className="py-16 text-center">
                        <Target className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                        <p className="text-lg font-semibold mb-2">No Goals Yet</p>
                        <p className="text-sm text-muted-foreground mb-4">Set your first earnings goal and start tracking progress.</p>
                        <Button onClick={() => { setEditingGoal(undefined); setGoalDialogOpen(true); }}>
                            <Plus className="h-4 w-4 mr-2" />
                            Create Your First Goal
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <>
                    {/* Progress Bar + Insights Row */}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        {/* Big Progress Card */}
                        <Card className="lg:col-span-2">
                            <CardHeader className="pb-3">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <CardTitle className="min-w-0 text-sm font-medium text-muted-foreground">
                                        Progress to {activeGoal.name}
                                    </CardTitle>
                                    {insights && <StatusBadge status={insights.status} />}
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {insightsLoading ? (
                                    <div className="flex justify-center py-4">
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                    </div>
                                ) : insights ? (
                                    <>
                                        <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                                            <div className="min-w-0">
                                                <span className="break-words text-xl font-bold sm:text-3xl" style={{ color: progressColor }}>
                                                    {formatCurrency(insights.totalEarned, true, 2)}
                                                </span>
                                                <span className="text-xs sm:text-sm text-muted-foreground ml-0 sm:ml-2 block sm:inline">
                                                    of {formatCurrency(insights.targetAmount, true, 0)}
                                                </span>
                                            </div>
                                            <span className="self-start text-xl font-bold sm:self-auto sm:text-2xl" style={{ color: progressColor }}>
                                                {insights.percentComplete.toFixed(1)}%
                                            </span>
                                        </div>

                                        {/* Progress Bar */}
                                        <div className="relative">
                                            <div className="h-4 w-full bg-muted rounded-full relative overflow-hidden">
                                                <div
                                                    className="h-full w-full origin-left rounded-full transition-transform duration-300 ease-out relative"
                                                    style={{
                                                        transform: `scaleX(${clampedProgressPercent / 100})`,
                                                        background: `linear-gradient(90deg, ${progressColor}cc, ${progressColor})`,
                                                    }}
                                                >
                                                    <div className="absolute inset-0 bg-white/15 rounded-full" />
                                                </div>

                                                {/* Milestone Markers */}
                                                {[25, 50, 75].map(marker => (
                                                    <div
                                                        key={marker}
                                                        className="absolute top-0 bottom-0 border-l-[1.5px] border-background z-10"
                                                        style={{ left: `${marker}%`, opacity: clampedProgressPercent > marker ? 0.3 : 0.6 }}
                                                    >
                                                        <span className={`absolute -bottom-5 -translate-x-1/2 text-[10px] font-bold ${clampedProgressPercent >= marker ? 'text-foreground' : 'text-muted-foreground'}`}>{marker}%</span>
                                                    </div>
                                                ))}
                                            </div>
                                            {/* Expected position marker */}
                                            <div
                                                className="absolute top-0 h-4 w-0.5 bg-foreground/40"
                                                style={{ left: `${clampedExpectedPercent}%` }}
                                                title={`Expected: ${insights.expectedPercent.toFixed(1)}%`}
                                            />
                                        </div>

                                        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                            <span>{format(parseISO(activeGoal.start_date), 'MMM d, yyyy')}</span>
                                            <span className="hidden items-center gap-1 sm:flex">
                                                <div className="w-3 h-0.5 bg-foreground/40" /> Expected pace marker
                                            </span>
                                            <span>{format(parseISO(activeGoal.end_date), 'MMM d, yyyy')}</span>
                                        </div>

                                        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                                            <div className="flex items-center gap-2 text-sm">
                                                <ArrowRight className={`h-4 w-4 ${paceDeltaIsAhead ? 'text-green-500' : 'text-red-500'}`} />
                                                <span className="font-medium">
                                                    {paceDeltaIsAhead ? 'Ahead by ' : 'Behind by '}
                                                    <span className={paceDeltaIsAhead ? 'text-green-500' : 'text-red-500'}>
                                                        {formatCurrency(Math.abs(paceDeltaAmount), true, 2)}
                                                    </span>
                                                </span>
                                            </div>
                                            <span className="text-xs text-muted-foreground">
                                                Expected now: {formatCurrency(insights.targetAmount * (insights.expectedPercent / 100), true, 2)}
                                            </span>
                                        </div>
                                    </>
                                ) : null}
                            </CardContent>
                        </Card>

                        {/* Pacing Insights Card */}
                        <Card className="bg-gradient-to-br from-card to-muted/30">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                    <Flame className="h-4 w-4 text-orange-500" />
                                    Pacing Insights
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {insightsLoading ? (
                                    <div className="flex justify-center py-6">
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                    </div>
                                ) : insights ? (
                                    <>
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Daily Avg</p>
                                                <p className="break-words text-sm font-bold">{formatCurrency(insights.dailyAverage, true, 2)}</p>
                                            </div>
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Need/Day</p>
                                                <p className="break-words text-sm font-bold text-orange-500">{formatCurrency(insights.remainingPerDay, true, 2)}</p>
                                            </div>
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Projected</p>
                                                <p className={`break-words text-sm font-bold ${insights.projectedTotal >= insights.targetAmount ? 'text-green-500' : 'text-red-500'}`}>
                                                    {formatCurrency(insights.projectedTotal, true, 2)}
                                                </p>
                                            </div>
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Days Left</p>
                                                <p className="text-sm font-bold">{insights.daysRemaining}</p>
                                            </div>
                                        </div>

                                        <div className="pt-2 border-t">
                                            <p className="text-xs text-muted-foreground leading-relaxed">
                                                {insights.status === 'COMPLETED' && '🎯 Congratulations! You\'ve reached your goal!'}
                                                {insights.status === 'AHEAD' && `🚀 Great pace! You're ${insights.progressDelta.toFixed(1)}% ahead of schedule.`}
                                                {insights.status === 'ON_TRACK' && (
                                                    <span>✅ You're on track. Keep averaging {formatCurrency(insights.dailyAverage, true, 2)}/day.</span>
                                                )}
                                                {insights.status === 'AT_RISK' && (
                                                    <span>⚠️ Slightly behind. Aim for {formatCurrency(insights.remainingPerDay, true, 2)}/day to catch up.</span>
                                                )}
                                                {insights.status === 'BEHIND' && (
                                                    <span>🔴 Behind by {Math.abs(insights.progressDelta).toFixed(1)}%. Need {formatCurrency(insights.remainingPerDay, true, 2)}/day to recover.</span>
                                                )}
                                            </p>
                                        </div>
                                    </>
                                ) : null}
                            </CardContent>
                        </Card>
                    </div>

                    {insights && (
                        <Card>
                            <CardContent className="py-4">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                    <div className="rounded-md border bg-background p-3">
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Remaining</p>
                                        <p className="mt-1 break-words text-lg font-bold">{formatCurrency(remainingAmount, true, 2)}</p>
                                    </div>
                                    <div className="rounded-md border bg-background p-3">
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Need / Trading Day</p>
                                        <p className="mt-1 break-words text-lg font-bold text-orange-500">{formatCurrency(insights.remainingPerDay, true, 2)}</p>
                                    </div>
                                    <div className="rounded-md border bg-background p-3">
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Required Monthly Pace</p>
                                        <p className="mt-1 break-words text-lg font-bold">{formatCurrency(requiredMonthlyPace, true, 2)}</p>
                                    </div>
                                    <div className="rounded-md border bg-background p-3">
                                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Forecast</p>
                                        <p className="mt-1 text-sm font-semibold leading-snug">{forecastText}</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {milestoneProgress.length > 0 && (
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium flex items-center gap-2">
                                    <Trophy className="h-4 w-4 text-yellow-500" />
                                    Milestones
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                                    {milestoneProgress.map(item => {
                                        const isReached = item.reached !== null;
                                        return (
                                            <div key={item.marker} className={`rounded-md border p-3 ${isReached ? 'bg-green-500/10 border-green-500/25' : 'bg-muted/30'}`}>
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className={`text-sm font-bold ${isReached ? 'text-green-500' : 'text-muted-foreground'}`}>{item.marker}%</span>
                                                    {isReached ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Target className="h-4 w-4 text-muted-foreground" />}
                                                </div>
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    {formatCurrency(item.target, false, 0)}
                                                </p>
                                                <p className="mt-2 text-xs font-medium">
                                                    {item.reached ? format(item.reached.date, 'MMM d, yyyy') : 'Not reached yet'}
                                                </p>
                                            </div>
                                        );
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Streak Counter + Win Rate Row */}
                    {insights && insights.totalEntries > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                            {/* Streak Counter */}
                            <Card className="border-orange-500/20">
                                <CardContent className="py-5">
                                    <div className="flex items-start gap-4">
                                        <div className="p-3 rounded-xl bg-orange-500/10">
                                            <Flame className="h-7 w-7 text-orange-500" />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current Streak</p>
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-2xl sm:text-3xl font-bold text-orange-500">
                                                    {insights.currentStreak}
                                                </span>
                                                <span className="text-sm text-muted-foreground">
                                                    profitable {insights.currentStreak === 1 ? 'day' : 'days'}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-3 mt-2">
                                                <div className="flex items-center gap-1.5">
                                                    <Trophy className="h-3.5 w-3.5 text-yellow-500" />
                                                    <span className="text-xs text-muted-foreground">
                                                        Best: <span className="font-semibold text-foreground">{insights.longestStreak} days</span>
                                                    </span>
                                                </div>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-2">
                                                {insights.currentStreak >= insights.longestStreak && insights.currentStreak > 1
                                                    ? '🔥 You\'re on your best streak ever!'
                                                    : insights.currentStreak >= 5
                                                        ? '🔥 Great run! Keep the momentum going.'
                                                        : insights.currentStreak >= 3
                                                            ? '💪 Solid streak building up!'
                                                            : insights.currentStreak > 0
                                                                ? 'Keep going — every day counts.'
                                                                : 'Log a profitable day to start a streak!'}
                                            </p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Win Rate */}
                            <Card className="border-blue-500/20">
                                <CardContent className="py-5">
                                    <div className="flex items-start gap-4">
                                        <div className="p-3 rounded-xl bg-blue-500/10">
                                            <BarChart3 className="h-7 w-7 text-blue-500" />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</p>
                                            <div className="flex items-baseline gap-2">
                                                <span className={`text-2xl sm:text-3xl font-bold ${insights.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                                                    {insights.winRate.toFixed(1)}%
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                    {insights.wins}W – {insights.losses}L{insights.breakEven > 0 ? ` – ${insights.breakEven}BE` : ''}
                                                </span>
                                            </div>

                                            {/* Win/Loss visual bar */}
                                            <div className="flex h-2 w-full rounded-full overflow-hidden mt-2 bg-muted">
                                                <div
                                                    className="h-full bg-green-500 rounded-l-full transition-[width] duration-200 ease-out"
                                                    style={{ width: `${insights.totalEntries > 0 ? (insights.wins / insights.totalEntries) * 100 : 0}%` }}
                                                />
                                                <div
                                                    className="h-full bg-red-500 rounded-r-full transition-[width] duration-200 ease-out"
                                                    style={{ width: `${insights.totalEntries > 0 ? (insights.losses / insights.totalEntries) * 100 : 0}%` }}
                                                />
                                            </div>

                                            <div className="grid grid-cols-3 gap-2 mt-3">
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground uppercase">Avg Win</p>
                                                    <p className="text-xs font-bold text-green-500">{formatCurrency(insights.avgWin, true, 2, true)}</p>
                                                </div>
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground uppercase">Avg Loss</p>
                                                    <p className="text-xs font-bold text-red-500">{formatCurrency(-insights.avgLoss, true, 2)}</p>
                                                </div>
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground uppercase">Profit Factor</p>
                                                    <p className={`text-xs font-bold ${(insights.profitFactor ?? 0) >= 1 ? 'text-green-500' : 'text-red-500'}`}>
                                                        {insights.profitFactor != null ? insights.profitFactor.toFixed(2) : '∞'}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="border-green-500/20">
                                <CardContent className="py-5">
                                    <div className="flex items-start gap-4">
                                        <div className="p-3 rounded-xl bg-green-500/10">
                                            <TrendingUp className="h-7 w-7 text-green-500" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Best Day</p>
                                            <p className="text-2xl sm:text-3xl font-bold text-green-500">
                                                {bestWorstDays.best ? formatCurrency(bestWorstDays.best.amount, true, 2, true) : '$0.00'}
                                            </p>
                                            <p className="mt-2 text-xs text-muted-foreground">
                                                {bestWorstDays.best ? `${format(bestWorstDays.best.date, 'MMM d, yyyy')} - ${bestWorstDays.best.count} entr${bestWorstDays.best.count === 1 ? 'y' : 'ies'}` : 'No profitable day yet'}
                                            </p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="border-red-500/20">
                                <CardContent className="py-5">
                                    <div className="flex items-start gap-4">
                                        <div className="p-3 rounded-xl bg-red-500/10">
                                            <TrendingDown className="h-7 w-7 text-red-500" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Worst Day</p>
                                            <p className={`text-2xl sm:text-3xl font-bold ${bestWorstDays.worst ? 'text-red-500' : 'text-muted-foreground'}`}>
                                                {bestWorstDays.worst ? formatCurrency(bestWorstDays.worst.amount, true, 2) : 'No losses'}
                                            </p>
                                            <p className="mt-2 text-xs text-muted-foreground">
                                                {bestWorstDays.worst ? `${format(bestWorstDays.worst.date, 'MMM d, yyyy')} - ${bestWorstDays.worst.count} entr${bestWorstDays.worst.count === 1 ? 'y' : 'ies'}` : 'No loss day yet'}
                                            </p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    )}

                    {/* Cumulative Chart */}
                    {chartData.length > 0 && (
                        <Card>
                            <CardHeader className="pb-2">
                                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                                        <TrendingUp className="h-4 w-4 text-primary" />
                                        Cumulative Earnings vs. Ideal Pace
                                    </CardTitle>
                                    <div className="flex w-full overflow-x-auto rounded-md bg-muted/50 p-1 sm:w-auto">
                                        {(['1W', '1M', '3M', 'YTD', 'ALL'] as const).map(t => (
                                            <button
                                                key={t}
                                                onClick={() => setTimeframe(t)}
                                                className={`min-w-12 flex-1 rounded px-3 py-1 text-xs font-medium transition-colors sm:flex-none ${timeframe === t ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                                            >
                                                {t}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="h-[250px] sm:h-[300px]">
                                {filteredChartData.length === 0 ? (
                                    <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                                        No entries in the selected timeframe.
                                    </div>
                                ) : (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart data={filteredChartData}>
                                            <defs>
                                                <linearGradient id="earnedGradient" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor={progressColor} stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor={progressColor} stopOpacity={0} />
                                                </linearGradient>
                                            </defs>
                                            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                            <YAxis
                                                tick={{ fontSize: 11 }}
                                                domain={[dataMin => Math.min(0, dataMin), 'auto']}
                                                tickFormatter={v => {
                                                    const isNegative = v < 0;
                                                    const absV = Math.abs(v);
                                                    if (absV >= 1000) {
                                                        return `${isNegative ? '-' : ''}$${(absV / 1000).toFixed(0)}k`;
                                                    }
                                                    return `${isNegative ? '-' : ''}$${absV}`;
                                                }}
                                            />
                                            <RechartsTooltip
                                                contentStyle={{
                                                    backgroundColor: 'hsl(var(--card))',
                                                    border: '1px solid hsl(var(--border))',
                                                    borderRadius: '8px',
                                                    fontSize: '12px'
                                                }}
                                                formatter={((value: number, name: string) => [
                                                    formatCurrency(value, true, 2),
                                                    name === 'earned' ? 'Actual' : 'Ideal Pace'
                                                ]) as any}
                                            />
                                            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                                            <Bar dataKey="earned" radius={[4, 4, 0, 0]} maxBarSize={40}>
                                                {filteredChartData.map((entry, index) => (
                                                    <Cell key={`cell-${index}`} fill={(entry.dailyAmount < 0 || entry.earned < entry.ideal) ? '#ef4444' : '#22c55e'} />
                                                ))}
                                            </Bar>
                                            <Line
                                                type="monotone"
                                                dataKey="ideal"
                                                stroke="#94a3b8"
                                                strokeWidth={1.5}
                                                strokeDasharray="6 3"
                                                dot={false}
                                            />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {entries.length > 0 && (
                        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                            <Card className="xl:col-span-3">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                                        <BarChart3 className="h-4 w-4 text-primary" />
                                        Monthly Breakdown
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="p-0 sm:p-6 sm:pt-0">
                                    <div className="space-y-2 p-3 sm:hidden">
                                        {monthlyBreakdown.map(month => (
                                            <div key={month.key} className="rounded-md border bg-background p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <span className="font-medium">{month.label}</span>
                                                    <span className={`font-semibold ${month.delta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                        {formatCurrency(month.delta, false, 2, month.delta > 0)}
                                                    </span>
                                                </div>
                                                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                                    <div>
                                                        <p className="text-muted-foreground">Earned</p>
                                                        <p className={`font-semibold ${month.earned >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                            {formatCurrency(month.earned, false, 2, month.earned > 0)}
                                                        </p>
                                                    </div>
                                                    <div>
                                                        <p className="text-muted-foreground">Pace</p>
                                                        <p className="font-semibold">{formatCurrency(month.pace, false, 2)}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="hidden overflow-x-auto sm:block">
                                        <table className="w-full text-sm text-left">
                                            <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                                                <tr>
                                                    <th className="px-4 py-3">Month</th>
                                                    <th className="px-4 py-3 text-right">Earned</th>
                                                    <th className="px-4 py-3 text-right">Pace</th>
                                                    <th className="px-4 py-3 text-right">Delta</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {monthlyBreakdown.map(month => (
                                                    <tr key={month.key} className="border-b last:border-0 hover:bg-muted/40">
                                                        <td className="px-4 py-3 font-medium">{month.label}</td>
                                                        <td className={`px-4 py-3 text-right font-semibold ${month.earned >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                            {formatCurrency(month.earned, false, 2, month.earned > 0)}
                                                        </td>
                                                        <td className="px-4 py-3 text-right text-muted-foreground">
                                                            {formatCurrency(month.pace, false, 2)}
                                                        </td>
                                                        <td className={`px-4 py-3 text-right font-semibold ${month.delta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                            {formatCurrency(month.delta, false, 2, month.delta > 0)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="xl:col-span-2">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                                        <Calendar className="h-4 w-4 text-primary" />
                                        Earnings Heatmap
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="flex justify-center gap-1 overflow-x-auto pb-1 sm:justify-start">
                                        {heatmapWeeks.map((week, weekIndex) => (
                                            <div key={weekIndex} className="grid grid-rows-7 gap-1">
                                                {week.map(day => (
                                                    <div
                                                        key={day.key}
                                                        className={`h-5 w-5 rounded border ${getHeatmapCellClass(day.amount)}`}
                                                        title={`${format(day.date, 'MMM d, yyyy')}: ${day.amount >= 0 ? '+' : ''}$${day.amount.toFixed(2)}`}
                                                    />
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex flex-col gap-2 text-[10px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                                        <span>8 weeks</span>
                                        <div className="flex items-center gap-1">
                                            <span>Loss</span>
                                            <span className="h-3 w-3 rounded bg-red-500/70" />
                                            <span className="h-3 w-3 rounded bg-muted border" />
                                            <span className="h-3 w-3 rounded bg-green-500/70" />
                                            <span>Profit</span>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    )}

                    {/* Entry Log */}
                    <Card>
                        <CardHeader>
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <CardTitle className="text-lg flex items-center gap-2">
                                    <Calendar className="h-5 w-5 text-primary" />
                                    Earnings Log
                                </CardTitle>
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                                    {entries.length > 0 && timeframe !== 'ALL' && (
                                        <span className="text-xs text-muted-foreground">
                                            Showing {filteredEntries.length} of {entries.length}
                                        </span>
                                    )}
                                    <Button
                                        size="sm"
                                        onClick={() => { setEditingEntry(undefined); setEntryDialogOpen(true); }}
                                        className="w-full gap-1 text-xs sm:w-auto"
                                    >
                                        <Plus className="h-3 w-3" />
                                        Log Entry
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="p-0 sm:p-6">
                            {entriesLoading ? (
                                <div className="flex justify-center py-8">
                                    <Loader2 className="h-5 w-5 animate-spin" />
                                </div>
                            ) : entries.length === 0 ? (
                                <div className="text-center py-10 text-muted-foreground">
                                    <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-30" />
                                    <p className="text-sm">No entries yet. Start logging your daily earnings!</p>
                                </div>
                            ) : filteredEntries.length === 0 ? (
                                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                                    No entries in the selected timeframe.
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-3 p-3 sm:hidden">
                                        {filteredEntries.map(entry => {
                                                const isEditing = inlineEditId === entry.id;
                                                const inlineAmountNumber = parseFloat(inlineAmount);
                                                const inlineAmountIsValid = inlineAmount.trim() !== '' && Number.isFinite(inlineAmountNumber);
                                                const entryAmount = Number(entry.amount);
                                                return (
                                                    <div key={entry.id} className={`rounded-md border bg-background p-3 ${isEditing ? 'border-primary/40 bg-muted/30' : ''}`}>
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <p className="text-xs font-semibold text-muted-foreground">{format(parseGoalDate(entry.entry_date), 'MMM d, yyyy')}</p>
                                                                {isEditing ? (
                                                                    <Input
                                                                        type="number"
                                                                        step="0.01"
                                                                        value={inlineAmount}
                                                                        onChange={e => setInlineAmount(e.target.value)}
                                                                        className="mt-2 h-8 text-sm"
                                                                    />
                                                                ) : (
                                                                    <p className={`mt-1 text-lg font-bold ${entryAmount >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                                        {formatCurrency(entryAmount, true, 2, entryAmount >= 0)}
                                                                    </p>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-1">
                                                                {isEditing ? (
                                                                    <>
                                                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500 hover:bg-green-500/10 hover:text-green-600" onClick={() => handleInlineSave(entry.id)} disabled={inlineSaving || !inlineAmountIsValid} title="Save entry">
                                                                            {inlineSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                                                        </Button>
                                                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-500/10 hover:text-red-600" onClick={() => setInlineEditId(null)} disabled={inlineSaving} title="Cancel edit">
                                                                            <X className="h-3.5 w-3.5" />
                                                                        </Button>
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            className="h-8 w-8"
                                                                            title="Edit entry"
                                                                            onClick={() => {
                                                                                setInlineEditId(entry.id);
                                                                                setInlineAmount(entry.amount.toString());
                                                                                setInlineNotes(entry.notes || '');
                                                                            }}
                                                                        >
                                                                            <Edit3 className="h-3.5 w-3.5" />
                                                                        </Button>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            className="h-8 w-8 text-red-500 hover:text-red-700"
                                                                            title="Delete entry"
                                                                            onClick={() => handleDeleteEntry(entry.id)}
                                                                        >
                                                                            <Trash2 className="h-3.5 w-3.5" />
                                                                        </Button>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                        {isEditing ? (
                                                            <Input
                                                                value={inlineNotes}
                                                                onChange={e => setInlineNotes(e.target.value)}
                                                                className="mt-3 h-8 text-xs"
                                                                placeholder="Notes"
                                                            />
                                                        ) : entry.notes ? (
                                                            <p className="mt-2 break-words text-xs text-muted-foreground">{entry.notes}</p>
                                                        ) : null}
                                                    </div>
                                                );
                                        })}
                                    </div>

                                    <div className="hidden overflow-x-auto sm:block">
                                            <table className="w-full text-sm text-left">
                                                <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                                                    <tr>
                                                        <th className="px-4 py-3">Date</th>
                                                        <th className="px-4 py-3">Amount</th>
                                                        <th className="px-4 py-3">Notes</th>
                                                        <th className="px-4 py-3 text-right">Actions</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredEntries.map(entry => {
                                                        const isEditing = inlineEditId === entry.id;
                                                        const inlineAmountNumber = parseFloat(inlineAmount);
                                                        const inlineAmountIsValid = inlineAmount.trim() !== '' && Number.isFinite(inlineAmountNumber);
                                                        return (
                                                            <tr key={entry.id} className={`border-b hover:bg-muted/50 transition-colors ${isEditing ? 'bg-muted/30' : ''}`}>
                                                                <td className="px-4 py-3 font-medium">
                                                                    {format(parseGoalDate(entry.entry_date), 'MMM d, yyyy')}
                                                                </td>
                                                                <td className="px-4 py-3">
                                                                    {isEditing ? (
                                                                        <Input type="number" step="0.01" value={inlineAmount} onChange={e => setInlineAmount(e.target.value)} className="h-8 w-[100px] text-xs" />
                                                                    ) : (
                                                                        <span className={`font-bold ${Number(entry.amount) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                                            {formatCurrency(Number(entry.amount), true, 2, Number(entry.amount) >= 0)}
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[200px]">
                                                                    {isEditing ? (
                                                                        <Input value={inlineNotes} onChange={e => setInlineNotes(e.target.value)} className="h-8 text-xs" />
                                                                    ) : (
                                                                        entry.notes || '-'
                                                                    )}
                                                                </td>
                                                                <td className="px-4 py-3 text-right">
                                                                    {isEditing ? (
                                                                        <div className="flex items-center justify-end gap-1">
                                                                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-500 hover:bg-green-500/10 hover:text-green-600" onClick={() => handleInlineSave(entry.id)} disabled={inlineSaving || !inlineAmountIsValid} title="Save entry">
                                                                                {inlineSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                                                            </Button>
                                                                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:bg-red-500/10 hover:text-red-600" onClick={() => setInlineEditId(null)} disabled={inlineSaving} title="Cancel edit">
                                                                                <X className="h-3 w-3" />
                                                                            </Button>
                                                                        </div>
                                                                    ) : (
                                                                        <div className="flex items-center justify-end gap-1">
                                                                            <Button
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                className="h-7 w-7"
                                                                                title="Edit entry"
                                                                                onClick={() => {
                                                                                    setInlineEditId(entry.id);
                                                                                    setInlineAmount(entry.amount.toString());
                                                                                    setInlineNotes(entry.notes || '');
                                                                                }}
                                                                            >
                                                                                <Edit3 className="h-3 w-3" />
                                                                            </Button>
                                                                            <Button
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                className="h-7 w-7 text-red-500 hover:text-red-700"
                                                                                title="Delete entry"
                                                                                onClick={() => handleDeleteEntry(entry.id)}
                                                                            >
                                                                                <Trash2 className="h-3 w-3" />
                                                                            </Button>
                                                                        </div>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </>
                                )}
                        </CardContent>
                    </Card>
                </>
            )}

            {/* Dialogs */}
            <GoalFormDialog
                goal={editingGoal}
                open={goalDialogOpen}
                onOpenChange={setGoalDialogOpen}
                onSaved={invalidateAll}
            />

            {
                activeGoalId && (
                    <AddEntryDialog
                        goalId={activeGoalId}
                        open={entryDialogOpen}
                        onOpenChange={open => {
                            setEntryDialogOpen(open);
                            if (!open) setEditingEntry(undefined);
                        }}
                        onSaved={invalidateAll}
                        editEntry={editingEntry}
                        usdToCadRate={usdToCadRate}
                    />
                )
            }
        </div >
    );
}
