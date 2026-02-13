
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { api, Position, User } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { usePositions, usePortfolioStats, useMarketStatus, useClosedPositions, QUERY_KEYS } from '@/hooks/useDashboardData';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  Activity,
  TrendingUp,
  BarChart3,
  Search,
  X,
  Plus,
  Zap,
  RefreshCw,
  AlertTriangle,
  ArrowUpDown,
  Trash2,
  BrainCircuit,
  Loader2,
  Info,
  Trophy,
  Percent,
  PieChart as PieChartIcon,
  ChevronLeft,
  ChevronRight,
  Target
} from 'lucide-react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  CartesianGrid,
  XAxis,
  YAxis
} from 'recharts';

import UserManagement from './UserManagement';
import PositionForm from './PositionForm';

import SettingsDialog from './SettingsDialog';
import Prediction from '@/pages/Prediction';
import LiveAnalysis from '@/pages/LiveAnalysis';
import GoalTracker from './GoalTracker';
import { StatsCard } from './StatsCard';
import { PositionsTable } from './PositionsTable';
import { cn, getDte, getPnL, getRoi } from '@/lib/utils';

interface DashboardProps {
  user: User;
  onUserUpdate: (user: User) => void;
}

export default function Dashboard({ user, onUserUpdate }: DashboardProps) {
  const queryClient = useQueryClient();
  const { data: positions = [], isLoading: loading, error: queryError, refetch: refetchPositions } = usePositions();
  const { data: stats } = usePortfolioStats();
  const { data: marketStatus } = useMarketStatus();

  // Local state for UI
  const [activeTab, setActiveTab] = useState('overview');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);

  const [tickerFilter, setTickerFilter] = useState('');
  const [debouncedTicker, setDebouncedTicker] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: 'symbol' | 'dte' | 'pnl', direction: 'asc' | 'desc' } | null>({ key: 'dte', direction: 'asc' });
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [priceChanges, setPriceChanges] = useState<Record<number, 'up' | 'down' | null>>({});
  const positionsRef = useRef<Position[]>([]);

  // Briefing state
  const [portfolioBriefing, setPortfolioBriefing] = useState<{ briefing: string; discord_message: string } | null>(null);
  const [isGeneratingBriefing, setIsGeneratingBriefing] = useState(false);

  // History pagination - server-side
  const [historyPage, setHistoryPage] = useState(1);
  const HISTORY_PAGE_SIZE = 10;
  const { data: closedHistory, refetch: refetchClosedHistory } = useClosedPositions(historyPage, HISTORY_PAGE_SIZE);

  // WebSocket Integration
  const { lastMessage } = useWebSocket();

  // Debounce search
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedTicker(tickerFilter);
    }, 300);
    return () => clearTimeout(handler);
  }, [tickerFilter]);

  // Sync ref for comparison
  useEffect(() => {
    if (positions) {
      // Calculate price changes for animation
      const changes: Record<number, 'up' | 'down' | null> = {};
      positions.forEach(newPos => {
        const oldPos = positionsRef.current.find(p => p.id === newPos.id);
        if (oldPos && oldPos.current_price != null && newPos.current_price != null) {
          if (Number(newPos.current_price) > Number(oldPos.current_price)) {
            changes[newPos.id] = 'up';
          } else if (Number(newPos.current_price) < Number(oldPos.current_price)) {
            changes[newPos.id] = 'down';
          }
        }
      });

      if (Object.keys(changes).length > 0) {
        setPriceChanges(changes);
        setTimeout(() => setPriceChanges({}), 2100);
      }
      positionsRef.current = positions;
    }
  }, [positions]);

  // WebSocket Price Update Handler
  useEffect(() => {
    if (lastMessage && lastMessage.type === 'PRICE_UPDATE' && lastMessage.data) {
      const quote = lastMessage.data;
      if (quote.symbol) {
        queryClient.setQueryData(QUERY_KEYS.positions, (currentPositions: Position[] | undefined) => {
          if (!currentPositions) return currentPositions;

          return currentPositions.map(p => {
            if (p.symbol === quote.symbol) {
              return {
                ...p,
                current_price: quote.price,
                delta: quote.greeks?.delta ?? p.delta,
                theta: quote.greeks?.theta ?? p.theta,
                gamma: quote.greeks?.gamma ?? p.gamma,
                vega: quote.greeks?.vega ?? p.vega,
                iv: quote.iv ?? p.iv,
                underlying_price: quote.underlying_price ?? p.underlying_price
              };
            }
            return p;
          });
        });
      }
    }
  }, [lastMessage, queryClient]);

  // Compute Derived Data
  const filteredPositions = useMemo(() => {
    let result = positions.filter(pos => {
      if (debouncedTicker && !pos.symbol.toLowerCase().includes(debouncedTicker.toLowerCase())) return false;
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'OPEN_ONLY' && pos.status !== 'OPEN') return false;
        if (statusFilter === 'STOPPED' && pos.status !== 'STOP_TRIGGERED') return false;
        if (statusFilter === 'PROFIT' && pos.status !== 'PROFIT_TRIGGERED') return false;
        if (statusFilter === 'CLOSED' && pos.status !== 'CLOSED') return false;
        if (['OPEN', 'STOP_TRIGGERED', 'PROFIT_TRIGGERED', 'CLOSED'].includes(statusFilter) && pos.status !== statusFilter) return false;
      } else if (pos.status === 'CLOSED') {
        return false;
      }
      return true;
    });

    if (sortConfig) {
      result = [...result].sort((a, b) => {
        let valA: any, valB: any;
        if (sortConfig.key === 'symbol') {
          valA = a.symbol;
          valB = b.symbol;
        } else if (sortConfig.key === 'dte') {
          valA = getDte(a.expiration_date);
          valB = getDte(b.expiration_date);
        } else if (sortConfig.key === 'pnl') {
          valA = getPnL(a);
          valB = b.realized_pnl || getPnL(b);
        }
        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return result;
  }, [positions, debouncedTicker, statusFilter, sortConfig]);

  const totalRealizedPnL = useMemo(() =>
    positions.reduce((acc, p) => acc + (p.realized_pnl || 0), 0)
    , [positions]);

  const exposureData = useMemo(() =>
    Object.entries(
      positions.filter(p => p.status !== 'CLOSED').reduce((acc, p) => {
        acc[p.symbol] = (acc[p.symbol] || 0) + (p.entry_price * p.quantity * 100);
        return acc;
      }, {} as Record<string, number>)
    ).map(([name, value]) => ({ name, value }))
    , [positions]);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

  // Handlers
  const handleEdit = (pos: Position) => {
    setEditingPosition(pos);
    setIsDialogOpen(true);
  };



  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this position?')) {
      try {
        await api.deletePosition(id);
        // Optimistic update or refetch
        queryClient.setQueryData(QUERY_KEYS.positions, (old: Position[] | undefined) =>
          old ? old.filter(p => p.id !== id) : []
        );
      } catch (err) {
        console.error(err);
        alert('Failed to delete position.');
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedIds.size} positions?`)) return;
    try {
      await api.bulkDeletePositions(Array.from(selectedIds));
      setSelectedIds(new Set());
      refetchPositions();
    } catch (err) {
      console.error(err);
      alert('Failed to bulk delete positions.');
    }
  };

  const handleForceSync = async () => {
    try {
      await api.forcePoll();
      refetchPositions();
    } catch (err) {
      console.error('Failed to force sync:', err);
    }
  };

  const handleGenerateBriefing = async () => {
    setIsGeneratingBriefing(true);
    try {
      const data = await api.getPortfolioBriefing();
      setPortfolioBriefing(data);
    } catch (err) {
      console.error('Failed to generate briefing:', err);
      alert('Failed to generate AI briefing. Please ensure Ollama or OpenRouter is configured.');
    } finally {
      setIsGeneratingBriefing(false);
    }
  };

  const toggleSort = (key: 'symbol' | 'dte' | 'pnl') => {
    setSortConfig(current => {
      if (current?.key === key) {
        return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const toggleSelection = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPositions.length && filteredPositions.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredPositions.map(p => p.id)));
    }
  };

  // Need to gather history data for the sparklines
  // In the original, this was fetched separately or assumed available? 
  // Wait, `historyData` state was in original but where was it populated?
  // It wasn't populated in the `loadPositions` function I saw.
  // It might have been missing or I missed it.
  // Let's assume we fetch history for visible rows or just ignore it for now if it requires N+1 calls
  // Original `Dashboard.tsx` had `const [historyData, setHistoryData] = useState<Record<number, any[]>>({});`
  // But I don't see it being set in the code I viewed.
  // For now I will pass an empty object or implement a fetch if needed.
  // The line chart component just needs data.
  // I'll keep the `historyData` state but it might be empty.
  const [historyData, setHistoryData] = useState<Record<number, any[]>>({});
  // Ideally we should fetch history for positions.

  return (
    <div className="container mx-auto py-8 space-y-8">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">

        {/* Header Section */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-4 rounded-lg border shadow-sm">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold transition-all">Positions Monitor</h2>
              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground font-mono">
                v1.3.0 {import.meta.env.VITE_APP_BUILD_SHA && `(${import.meta.env.VITE_APP_BUILD_SHA.substring(0, 7)})`}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-[8px] sm:text-xs text-muted-foreground">Track your options with structured queries</p>
              {marketStatus && (
                <>
                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${marketStatus.open ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} />
                    <span className={`text-[8px] sm:text-xs font-medium uppercase tracking-wider ${marketStatus.open ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      Market {marketStatus.open ? 'Open' : 'Closed'}
                    </span>
                  </div>

                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5" title="Questrade API Connection">
                    <div className={`w-2 h-2 rounded-full ${(marketStatus as any).connectionStatus === 'CONNECTED' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500 animate-pulse'}`} />
                    <span className={`text-[8px] sm:text-xs font-medium uppercase tracking-wider ${(marketStatus as any).connectionStatus === 'CONNECTED' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      Broker {(marketStatus as any).connectionStatus === 'CONNECTED' ? 'Live' : 'Offline'}
                    </span>
                  </div>
                </>
              )}
              {queryError && (
                <>
                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5 text-red-500 animate-pulse">
                    <AlertTriangle className="h-3 w-3" />
                    <span className="text-[10px] font-bold uppercase tracking-tighter">
                      Offline
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <TabsList className="hidden md:flex order-2 md:order-1">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
              <TabsTrigger value="goals">Goals</TabsTrigger>
              <TabsTrigger value="live-analysis">Live Analysis</TabsTrigger>
              <TabsTrigger value="prediction">AI Prediction</TabsTrigger>
              {user.role === 'ADMIN' && (
                <TabsTrigger value="users">Users</TabsTrigger>
              )}
            </TabsList>
            <div className="md:hidden order-2">
              <Select value={activeTab} onValueChange={setActiveTab}>
                <SelectTrigger className="h-9 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="overview">Overview</SelectItem>
                  <SelectItem value="portfolio">Portfolio</SelectItem>
                  <SelectItem value="goals">Goals</SelectItem>
                  <SelectItem value="live-analysis">Live Analysis</SelectItem>
                  <SelectItem value="prediction">AI Prediction</SelectItem>
                  {user.role === 'ADMIN' && (
                    <SelectItem value="users">Users</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <SettingsDialog user={user} onUpdate={onUserUpdate} />
            <Button variant="outline" size="sm" className="hidden md:flex gap-1 text-xs" onClick={handleForceSync} disabled={loading}>
              <Zap className={`h-3 w-3 ${loading ? 'text-yellow-500 animate-pulse' : 'text-yellow-500'}`} />
              Force Sync
            </Button>
            <Button variant="outline" size="icon" className="md:hidden" onClick={handleForceSync} disabled={loading}>
              <Zap className={`h-4 w-4 ${loading ? 'text-yellow-500 animate-pulse' : 'text-yellow-500'}`} />
            </Button>

            <Button variant="outline" size="icon" onClick={() => refetchPositions()}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>

            <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) setEditingPosition(null); }}>
              <DialogTrigger asChild>
                <Button className="rounded-full md:rounded-md w-9 h-9 md:w-auto md:h-10 p-0 md:px-4 text-xs md:text-sm">
                  <Plus className="h-4 w-4 md:mr-2" />
                  <span className="hidden md:inline">Track Position</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[600px]">
                <DialogHeader>
                  <DialogTitle>{editingPosition ? 'Edit Position' : 'Track New Position'}</DialogTitle>
                </DialogHeader>
                <PositionForm
                  position={editingPosition || undefined}
                  onSuccess={() => {
                    refetchPositions();
                    setIsDialogOpen(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Details Modal removed - now using separate page */}

        <TabsContent value="overview" className="space-y-8 mt-0">
          {/* Stats Cards Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <StatsCard
              title="Active Positions"
              value={positions.filter(p => p.status !== 'CLOSED').length}
              icon={Activity}
            />
            <StatsCard
              title="Realized PnL"
              value={`$${totalRealizedPnL.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
              icon={TrendingUp}
              valueClassName={totalRealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'}
            />
            {/* Performance Chart Card */}
            <Card className="md:col-span-2 hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Performance (Cumulative PnL)
                  <BarChart3 className="h-4 w-4" />
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[60px] p-0 px-6">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={
                    positions
                      .filter(p => p.status === 'CLOSED')
                      .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
                      .reduce((acc: any[], p: any) => {
                        const prev = acc.length > 0 ? acc[acc.length - 1].pnl : 0;
                        acc.push({ pnl: prev + p.realized_pnl });
                        return acc;
                      }, [])
                  }>
                    <defs>
                      <linearGradient id="pnlColor" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="pnl" stroke="#10b981" fillOpacity={1} fill="url(#pnlColor)" isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <CardTitle className="text-lg sm:text-xl flex items-center gap-2">
                    <Activity className="h-5 w-5 text-blue-500" />
                    Active Tracker
                  </CardTitle>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative group min-w-[120px]">
                      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground group-focus-within:text-primary transition-colors" />
                      <Input
                        placeholder="Ticker..."
                        value={tickerFilter}
                        onChange={(e) => setTickerFilter(e.target.value)}
                        className="pl-8 h-9 text-xs w-full sm:w-[120px]"
                      />
                      {tickerFilter && (
                        <button
                          onClick={() => setTickerFilter('')}
                          className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {selectedIds.size > 0 && (
                      <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                        <Badge variant="secondary" className="h-9 px-3 flex gap-2 items-center">
                          {selectedIds.size} Selected
                          <div className="h-4 w-[1px] bg-border mx-1" />
                          <button
                            onClick={handleBulkDelete}
                            className="text-red-500 hover:text-red-700 font-bold flex items-center gap-1"
                          >
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </button>
                        </Badge>
                      </div>
                    )}

                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="h-9 text-xs w-[130px]">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">All Status</SelectItem>
                        <SelectItem value="OPEN">Open</SelectItem>
                        <SelectItem value="STOP_TRIGGERED">Stopped</SelectItem>
                        <SelectItem value="PROFIT_TRIGGERED">Profit Hit</SelectItem>
                        <SelectItem value="CLOSED">Closed</SelectItem>
                      </SelectContent>
                    </Select>

                    <Select
                      value={sortConfig ? `${sortConfig.key}_${sortConfig.direction}` : ''}
                      onValueChange={(val) => {
                        if (val === 'symbol_asc') setSortConfig({ key: 'symbol', direction: 'asc' });
                        if (val === 'dte_asc') setSortConfig({ key: 'dte', direction: 'asc' });
                        if (val === 'pnl_desc') setSortConfig({ key: 'pnl', direction: 'desc' });
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs w-[140px]">
                        <div className="flex items-center gap-2">
                          <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
                          <SelectValue placeholder="Sort By" />
                        </div>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dte_asc">Nearest Expiry</SelectItem>
                        <SelectItem value="symbol_asc">Symbol (A-Z)</SelectItem>
                        <SelectItem value="pnl_desc">Highest PnL</SelectItem>
                      </SelectContent>
                    </Select>

                    {(tickerFilter || statusFilter !== 'ALL') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTickerFilter('');
                          setDebouncedTicker('');
                          setStatusFilter('ALL');
                        }}
                        className="h-8 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 sm:p-6">
                <PositionsTable
                  positions={filteredPositions}
                  loading={loading}
                  selectedIds={selectedIds}
                  sortConfig={sortConfig}
                  priceChanges={priceChanges}
                  historyData={historyData}
                  tickerFilter={tickerFilter}
                  statusFilter={statusFilter}
                  onSort={toggleSort}
                  onToggleSelection={toggleSelection}
                  onToggleSelectAll={toggleSelectAll}
                  onClearFilters={() => {
                    setTickerFilter('');
                    setDebouncedTicker('');
                    setStatusFilter('ALL');
                  }}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              </CardContent>
            </Card>
          </div>

          {/* History / Closed Positions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg sm:text-xl flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-500" />
                History & Analytics
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 sm:p-6 overflow-x-auto">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                    <tr>
                      <th className="px-4 py-3">Symbol</th>
                      <th className="px-4 py-3 hidden md:table-cell">Duration</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Realized PnL</th>
                      <th className="px-4 py-3 hidden md:table-cell">Loss Avoided</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!closedHistory || closedHistory.positions.length === 0 ? (
                      <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">No history available.</td></tr>
                    ) : (
                      closedHistory.positions.map((pos) => (
                        <tr key={pos.id} className="border-b hover:bg-muted/50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-bold">{pos.symbol}</div>
                            <div className="text-[10px] text-muted-foreground uppercase">{pos.option_type} ${pos.strike_price}</div>
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                            {Math.floor((new Date(pos.updated_at).getTime() - new Date(pos.created_at).getTime()) / (1000 * 60 * 60 * 24))} days
                          </td>
                          <td className="px-4 py-3"><Badge variant="outline" className="text-[10px]">CLOSED</Badge></td>
                          <td className="px-4 py-3">
                            <div className={`font-bold ${Number(pos.realized_pnl) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                              ${Number(pos.realized_pnl).toFixed(2)}
                              <span className="ml-1 text-[10px] opacity-70">({getRoi(pos).toFixed(2)}%)</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <span className="text-blue-500 font-medium text-xs">${Number(pos.loss_avoided || 0).toFixed(2)}</span>
                          </td>
                          <td className="px-4 py-3">
                            <Button variant="ghost" size="sm" className="h-7 text-[10px] transition-opacity hover:bg-primary/10 hover:text-primary" onClick={() => api.reopenPosition(pos.id).then(() => { refetchPositions(); refetchClosedHistory(); })}>
                              <RefreshCw className="h-3 w-3 mr-1" /> Reopen
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {closedHistory && closedHistory.totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <span className="text-xs text-muted-foreground">
                    Showing {(historyPage - 1) * HISTORY_PAGE_SIZE + 1}-{Math.min(historyPage * HISTORY_PAGE_SIZE, closedHistory.total)} of {closedHistory.total}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setHistoryPage(p => Math.max(1, p - 1))}
                      disabled={historyPage === 1}
                      className="h-8 w-8 p-0"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm font-medium">
                      {historyPage} / {closedHistory.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setHistoryPage(p => Math.min(closedHistory.totalPages, p + 1))}
                      disabled={historyPage === closedHistory.totalPages}
                      className="h-8 w-8 p-0"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="portfolio" className="space-y-8 mt-0">
          <Card className="border-primary/20 bg-primary/5 shadow-premium overflow-hidden group">
            <CardHeader className="pb-3 border-b border-primary/10">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2 text-primary">
                  <BrainCircuit className="h-5 w-5 animate-pulse" />
                  AI Portfolio Manager
                </CardTitle>
                <Button
                  size="sm"
                  onClick={handleGenerateBriefing}
                  disabled={isGeneratingBriefing}
                  className="gap-2 shadow-sm transition-all hover:shadow-primary/25"
                >
                  {isGeneratingBriefing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  {portfolioBriefing ? 'Regenerate Briefing' : 'Generate Holistic Analysis'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isGeneratingBriefing ? (
                <div className="p-12 flex flex-col items-center justify-center space-y-4 text-center">
                  <div className="relative">
                    <BrainCircuit className="h-12 w-12 text-primary animate-pulse" />
                    <Loader2 className="h-16 w-16 text-primary/30 animate-spin absolute -top-2 -left-2" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-bold text-primary">AI Strategy Engine Working...</p>
                    <p className="text-xs text-muted-foreground max-w-[300px]">Reviewing all Greeks, price action, and risk scenarios.</p>
                  </div>
                </div>
              ) : portfolioBriefing ? (
                <div className="p-6 space-y-4 animate-in fade-in slide-in-from-top-4 duration-700">
                  <div className="relative">
                    <div className="p-4 rounded-xl bg-background border shadow-inner text-sm leading-relaxed whitespace-pre-wrap font-sans italic text-slate-700 dark:text-slate-300">
                      {portfolioBriefing.briefing}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-10 flex flex-col items-center justify-center space-y-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">
                  <Activity className="h-10 w-10 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground max-w-[280px]">Need a bird's-eye view? Click above to have AI analyze your total risk exposure.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <StatsCard title="Win Rate" value={`${stats?.winRate ?? 0}%`} icon={Trophy} description={`${stats?.closedTrades ?? 0} closed trades`} />
            <StatsCard title="Profit Factor" value={stats?.profitFactor ?? 0} icon={Percent} description="Gross Profit / Gross Loss" />
            <StatsCard title="Total Realized PnL" value={`$${(stats?.totalRealizedPnl ?? 0).toLocaleString()}`} icon={TrendingUp} valueClassName={(stats?.totalRealizedPnl ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'} />
            <StatsCard title="Avg Profit/Trade" value={`$${stats?.closedTrades ? (stats.totalRealizedPnl / stats.closedTrades).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '0.00'}`} icon={Activity} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <PieChartIcon className="h-4 w-4 text-orange-500" />
                Capital Exposure
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[250px] flex items-center justify-center relative">
              {exposureData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={exposureData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {exposureData.map((_entry, index) => (
                        <Cell key={`cell - ${index} `} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-muted-foreground text-sm">No active allocation</div>
              )}
            </CardContent>
          </Card>

          <Card className="w-full">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-primary" />
                Equity Curve
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[400px]">
              {stats?.equityCurve && stats.equityCurve.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.equityCurve}>
                    <defs>
                      <linearGradient id="equityColor" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickFormatter={(value) => `$${value}`}
                    />
                    <RechartsTooltip
                      labelFormatter={(label) => new Date(label).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      formatter={(value: any) => [`$${Number(value || 0).toLocaleString()}`, 'Total PnL']}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="pnl"
                      stroke="hsl(var(--primary))"
                      fillOpacity={1}
                      fill="url(#equityColor)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
                  <BarChart3 className="h-12 w-12 opacity-10" />
                  <p>Close some positions to see your equity curve.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="goals" className="space-y-6 mt-0">
          <GoalTracker />
        </TabsContent>

        <TabsContent value="live-analysis" className="mt-0">
          <LiveAnalysis />
        </TabsContent>

        <TabsContent value="prediction" className="mt-0">
          <Prediction />
        </TabsContent>

        {user.role === 'ADMIN' && (
          <TabsContent value="users" className="mt-0">
            <UserManagement />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
