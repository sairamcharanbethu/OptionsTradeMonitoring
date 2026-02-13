import React, { useState, useMemo } from 'react';
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
    CheckCircle2, ArrowRight, Flame, Trophy, BarChart3
} from 'lucide-react';
import {
    AreaChart, Area, ResponsiveContainer, XAxis, YAxis,
    CartesianGrid, Tooltip as RechartsTooltip, ReferenceLine,
    Line, ComposedChart
} from 'recharts';

// ─── US Trading-Day Helpers (matches backend) ───
function getUSMarketHolidays(year: number): Set<string> {
    const holidays = new Set<string>();
    const add = (m: number, d: number) => {
        let dt = new Date(year, m - 1, d);
        if (dt.getDay() === 6) dt = new Date(year, m - 1, d - 1);
        if (dt.getDay() === 0) dt = new Date(year, m - 1, d + 1);
        holidays.add(dt.toISOString().split('T')[0]);
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
        holidays.add(d.toISOString().split('T')[0])
    );

    // Good Friday
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const mo = Math.floor((h + l - 7 * mm + 114) / 31), dy = ((h + l - 7 * mm + 114) % 31) + 1;
    const gf = new Date(year, mo - 1, dy); gf.setDate(gf.getDate() - 2);
    holidays.add(gf.toISOString().split('T')[0]);

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
        if (dow !== 0 && dow !== 6 && !holidays.has(cursor.toISOString().split('T')[0])) count++;
        cursor.setDate(cursor.getDate() + 1);
    }
    return count;
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
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Start Date</label>
                            <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">End Date</label>
                            <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} required />
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
}: {
    goalId: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
    editEntry?: GoalEntry;
}) {
    const [entryDate, setEntryDate] = useState(editEntry?.entry_date?.split('T')[0] || format(new Date(), 'yyyy-MM-dd'));
    const [amount, setAmount] = useState(editEntry?.amount?.toString() || '');
    const [notes, setNotes] = useState(editEntry?.notes || '');
    const [saving, setSaving] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            if (editEntry) {
                await api.updateGoalEntry(goalId, editEntry.id, { entry_date: entryDate, amount: parseFloat(amount), notes });
            } else {
                await api.addGoalEntry(goalId, { entry_date: entryDate, amount: parseFloat(amount), notes: notes || undefined });
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
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Amount ($)</label>
                        <Input type="number" step="0.01" placeholder="500.00" value={amount} onChange={e => setAmount(e.target.value)} required />
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

    const [selectedGoalId, setSelectedGoalId] = useState<number | null>(null);
    const [goalDialogOpen, setGoalDialogOpen] = useState(false);
    const [editingGoal, setEditingGoal] = useState<Goal | undefined>(undefined);
    const [entryDialogOpen, setEntryDialogOpen] = useState(false);
    const [editingEntry, setEditingEntry] = useState<GoalEntry | undefined>(undefined);

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
        try {
            await api.deleteGoalEntry(activeGoalId, entryId);
            invalidateAll();
        } catch (err: any) {
            alert(err.message);
        }
    };

    // ─── Cumulative chart data ───
    const chartData = useMemo(() => {
        if (!entries.length || !activeGoal) return [];

        const sorted = [...entries].sort((a, b) =>
            new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime()
        );

        const targetAmount = Number(activeGoal.target_amount);
        const startDate = new Date(activeGoal.start_date);
        const endDate = new Date(activeGoal.end_date);
        const totalTradingDays = Math.max(1, tradingDaysBetween(startDate, endDate));
        const dailyIdeal = targetAmount / totalTradingDays;

        let cumulative = 0;
        return sorted.map(entry => {
            cumulative += Number(entry.amount);
            const entryDate = new Date(entry.entry_date);
            const tradingDaysElapsed = tradingDaysBetween(startDate, entryDate);
            const idealAtDay = dailyIdeal * tradingDaysElapsed;

            return {
                date: format(parseISO(entry.entry_date), 'MMM d'),
                earned: Math.round(cumulative * 100) / 100,
                ideal: Math.round(idealAtDay * 100) / 100,
            };
        });
    }, [entries, activeGoal]);

    // ─── Progress percentage for slider ───
    const progressPercent = insights?.percentComplete ?? 0;
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
        <div className="space-y-6">
            {/* Goal Selector Bar */}
            <Card className="border-primary/20">
                <CardContent className="py-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Target className="h-5 w-5 text-primary shrink-0" />
                            <h2 className="text-lg font-bold truncate">Goal Tracker</h2>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            {goals.length > 0 && (
                                <Select
                                    value={activeGoalId?.toString() || ''}
                                    onValueChange={v => setSelectedGoalId(parseInt(v))}
                                >
                                    <SelectTrigger className="h-9 w-[200px] text-xs">
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
                                className="gap-1 text-xs"
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
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        {/* Big Progress Card */}
                        <Card className="lg:col-span-2">
                            <CardHeader className="pb-3">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-sm font-medium text-muted-foreground">
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
                                        <div className="flex items-baseline justify-between">
                                            <div>
                                                <span className="text-3xl font-bold" style={{ color: progressColor }}>
                                                    ${insights.totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                </span>
                                                <span className="text-sm text-muted-foreground ml-2">
                                                    of ${insights.targetAmount.toLocaleString()}
                                                </span>
                                            </div>
                                            <span className="text-2xl font-bold" style={{ color: progressColor }}>
                                                {insights.percentComplete.toFixed(1)}%
                                            </span>
                                        </div>

                                        {/* Progress Bar */}
                                        <div className="relative">
                                            <div className="h-4 w-full bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className="h-full rounded-full transition-all duration-700 ease-out relative"
                                                    style={{
                                                        width: `${Math.min(100, progressPercent)}%`,
                                                        background: `linear-gradient(90deg, ${progressColor}cc, ${progressColor})`,
                                                    }}
                                                >
                                                    <div className="absolute inset-0 bg-white/20 animate-pulse rounded-full" />
                                                </div>
                                            </div>
                                            {/* Expected position marker */}
                                            <div
                                                className="absolute top-0 h-4 w-0.5 bg-foreground/40"
                                                style={{ left: `${Math.min(100, insights.expectedPercent)}%` }}
                                                title={`Expected: ${insights.expectedPercent.toFixed(1)}%`}
                                            />
                                        </div>

                                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                            <span>{format(parseISO(activeGoal.start_date), 'MMM d, yyyy')}</span>
                                            <span className="flex items-center gap-1">
                                                <div className="w-3 h-0.5 bg-foreground/40" /> Expected pace marker
                                            </span>
                                            <span>{format(parseISO(activeGoal.end_date), 'MMM d, yyyy')}</span>
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
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Daily Avg</p>
                                                <p className="text-sm font-bold">${insights.dailyAverage.toLocaleString()}</p>
                                            </div>
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Need/Day</p>
                                                <p className="text-sm font-bold text-orange-500">${insights.remainingPerDay.toLocaleString()}</p>
                                            </div>
                                            <div className="p-2.5 rounded-lg bg-background border">
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Projected</p>
                                                <p className={`text-sm font-bold ${insights.projectedTotal >= insights.targetAmount ? 'text-green-500' : 'text-red-500'}`}>
                                                    ${insights.projectedTotal.toLocaleString()}
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
                                                {insights.status === 'ON_TRACK' && `✅ You're on track. Keep averaging $${insights.dailyAverage.toLocaleString()}/day.`}
                                                {insights.status === 'AT_RISK' && `⚠️ Slightly behind. Aim for $${insights.remainingPerDay.toLocaleString()}/day to catch up.`}
                                                {insights.status === 'BEHIND' && `🔴 Behind by ${Math.abs(insights.progressDelta).toFixed(1)}%. Need $${insights.remainingPerDay.toLocaleString()}/day to recover.`}
                                            </p>
                                        </div>
                                    </>
                                ) : null}
                            </CardContent>
                        </Card>
                    </div>

                    {/* Streak Counter + Win Rate Row */}
                    {insights && insights.totalEntries > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                                                <span className="text-3xl font-bold text-orange-500">
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
                                                <span className={`text-3xl font-bold ${insights.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                                                    {insights.winRate.toFixed(1)}%
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                    {insights.wins}W – {insights.losses}L{insights.breakEven > 0 ? ` – ${insights.breakEven}BE` : ''}
                                                </span>
                                            </div>

                                            {/* Win/Loss visual bar */}
                                            <div className="flex h-2 w-full rounded-full overflow-hidden mt-2 bg-muted">
                                                <div
                                                    className="h-full bg-green-500 rounded-l-full transition-all"
                                                    style={{ width: `${insights.totalEntries > 0 ? (insights.wins / insights.totalEntries) * 100 : 0}%` }}
                                                />
                                                <div
                                                    className="h-full bg-red-500 rounded-r-full transition-all"
                                                    style={{ width: `${insights.totalEntries > 0 ? (insights.losses / insights.totalEntries) * 100 : 0}%` }}
                                                />
                                            </div>

                                            <div className="grid grid-cols-3 gap-2 mt-3">
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground uppercase">Avg Win</p>
                                                    <p className="text-xs font-bold text-green-500">+${insights.avgWin.toLocaleString()}</p>
                                                </div>
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground uppercase">Avg Loss</p>
                                                    <p className="text-xs font-bold text-red-500">-${insights.avgLoss.toLocaleString()}</p>
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
                        </div>
                    )}

                    {/* Cumulative Chart */}
                    {chartData.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-sm font-medium flex items-center gap-2">
                                    <TrendingUp className="h-4 w-4 text-primary" />
                                    Cumulative Earnings vs. Ideal Pace
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="h-[300px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={chartData}>
                                        <defs>
                                            <linearGradient id="earnedGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor={progressColor} stopOpacity={0.3} />
                                                <stop offset="95%" stopColor={progressColor} stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                        <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                                        <RechartsTooltip
                                            contentStyle={{
                                                backgroundColor: 'hsl(var(--card))',
                                                border: '1px solid hsl(var(--border))',
                                                borderRadius: '8px',
                                                fontSize: '12px'
                                            }}
                                            formatter={((value: number, name: string) => [
                                                `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                                                name === 'earned' ? 'Actual' : 'Ideal Pace'
                                            ]) as any}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="earned"
                                            stroke={progressColor}
                                            strokeWidth={2}
                                            fill="url(#earnedGradient)"
                                        />
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
                            </CardContent>
                        </Card>
                    )}

                    {/* Entry Log */}
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle className="text-lg flex items-center gap-2">
                                    <Calendar className="h-5 w-5 text-primary" />
                                    Earnings Log
                                </CardTitle>
                                <Button
                                    size="sm"
                                    onClick={() => { setEditingEntry(undefined); setEntryDialogOpen(true); }}
                                    className="gap-1 text-xs"
                                >
                                    <Plus className="h-3 w-3" />
                                    Log Entry
                                </Button>
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
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm text-left">
                                        <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                                            <tr>
                                                <th className="px-4 py-3">Date</th>
                                                <th className="px-4 py-3">Amount</th>
                                                <th className="px-4 py-3 hidden sm:table-cell">Notes</th>
                                                <th className="px-4 py-3 text-right">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {entries.map(entry => (
                                                <tr key={entry.id} className="border-b hover:bg-muted/50 transition-colors">
                                                    <td className="px-4 py-3 font-medium">
                                                        {format(parseISO(entry.entry_date), 'MMM d, yyyy')}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={`font-bold ${Number(entry.amount) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                            {Number(entry.amount) >= 0 ? '+' : ''}${Number(entry.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground truncate max-w-[200px]">
                                                        {entry.notes || '—'}
                                                    </td>
                                                    <td className="px-4 py-3 text-right">
                                                        <div className="flex items-center justify-end gap-1">
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7"
                                                                onClick={() => {
                                                                    setEditingEntry(entry);
                                                                    setEntryDialogOpen(true);
                                                                }}
                                                            >
                                                                <Edit3 className="h-3 w-3" />
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7 text-red-500 hover:text-red-700"
                                                                onClick={() => handleDeleteEntry(entry.id)}
                                                            >
                                                                <Trash2 className="h-3 w-3" />
                                                            </Button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
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

            {activeGoalId && (
                <AddEntryDialog
                    goalId={activeGoalId}
                    open={entryDialogOpen}
                    onOpenChange={open => {
                        setEntryDialogOpen(open);
                        if (!open) setEditingEntry(undefined);
                    }}
                    onSaved={invalidateAll}
                    editEntry={editingEntry}
                />
            )}
        </div>
    );
}
