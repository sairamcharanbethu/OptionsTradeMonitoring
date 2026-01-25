
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { api, Position } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { cn, parseLocalDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import {
  LayoutDashboard,
  History,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Clock,
  Settings,
  Plus,
  ArrowUpRight,
  ArrowDownRight,
  Info,
  RefreshCw,
  MoreVertical,
  CheckCircle,
  HelpCircle,
  LogOut,
  Pencil,
  Trash2,
  Table as TableIcon,
  PieChart as PieChartIcon,
  Trophy,
  Percent,
  BarChart3,
  Activity,
  AlertTriangle,
  Zap,
  Search,
  X,
  ArrowUpDown,
  MoreHorizontal,
  BrainCircuit,
  Loader2
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import UserManagement from './UserManagement';
import PositionForm from './PositionForm';
import PositionDetailsDialog from './PositionDetailsDialog';

import SettingsDialog from './SettingsDialog';
import Prediction from '@/pages/Prediction';
import { User } from '@/lib/api';

interface DashboardProps {
  user: User;
  onUserUpdate: (user: User) => void;
}

interface PortfolioStats {
  totalTrades: number;
  closedTrades: number;
  winRate: number;
  profitFactor: number;
  totalRealizedPnl: number;
  equityCurve: Array<{ date: string, pnl: number }>;
}

import { useWebSocket } from '@/hooks/useWebSocket';

export default function Dashboard({ user, onUserUpdate }: DashboardProps) {
  const { lastMessage, isConnected: wsConnected } = useWebSocket();
  const [positions, setPositions] = useState<Position[]>([]);
  const positionsRef = useRef<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<PortfolioStats | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [marketStatus, setMarketStatus] = useState<{ open: boolean; marketHours: string; timezone: string } | null>(null);
  const [isAddingPosition, setIsAddingPosition] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [priceChanges, setPriceChanges] = useState<Record<number, 'up' | 'down' | null>>({});
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<Record<number, any[]>>({});
  const [portfolioBriefing, setPortfolioBriefing] = useState<{ briefing: string; discord_message: string } | null>(null);
  const [isGeneratingBriefing, setIsGeneratingBriefing] = useState(false);

  // Filter States
  const [tickerFilter, setTickerFilter] = useState('');
  const [debouncedTicker, setDebouncedTicker] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Sorting State
  const [sortConfig, setSortConfig] = useState<{ key: 'symbol' | 'dte' | 'pnl', direction: 'asc' | 'desc' } | null>({ key: 'dte', direction: 'asc' });

  // Modal State for Details
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  // Bulk Selection State
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const toggleSelection = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPositions.length && filteredPositions.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredPositions.map(p => p.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedIds.size} positions?`)) return;

    setLoading(true);
    try {
      await api.bulkDeletePositions(Array.from(selectedIds));
      setSelectedIds(new Set());
      await loadPositions(false);
    } catch (err) {
      console.error(err);
      alert('Failed to bulk delete positions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedTicker(tickerFilter);
    }, 300);
    return () => clearTimeout(handler);
  }, [tickerFilter]);

  const handleEdit = (pos: Position) => {
    setEditingPosition(pos);
    setIsDialogOpen(true);
  };

  const handleViewDetails = (pos: Position) => {
    setSelectedPosition(pos);
    setIsDetailsOpen(true);
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this position?')) {
      try {
        await api.deletePosition(id);
        // Immediate UI update: filter out the deleted position from current state
        setPositions(prev => prev.filter(p => p.id !== id));
        loadPositions(true); // Silent reload to refresh stats/other data
      } catch (err) {
        console.error(err);
        alert('Failed to delete position. Please try again.');
      }
    }
  };

  const handleDialogChange = (open: boolean) => {
    setIsDialogOpen(open);
    if (!open) setEditingPosition(null);
  };

  async function loadMarketStatus() {
    try {
      const status = await api.getMarketStatus();
      setMarketStatus(status);
    } catch (error) {
      console.error('Failed to load market status:', error);
    }
  }

  async function loadPortfolioStats() {
    try {
      const data = await api.getPortfolioStats();
      setStats(data);
    } catch (error) {
      console.error('Failed to load portfolio stats:', error);
    }
  }

  const loadPositions = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      let data: Position[];

      if (silent && positionsRef.current.length > 0) {
        const updates = await api.getPositionUpdates();
        data = positionsRef.current.map(p => {
          if (updates[p.id]) {
            return { ...p, ...updates[p.id] };
          }
          return p;
        });
      } else {
        data = await api.getPositions();
      }

      // Track price changes for animations using the REF (previous value)
      const changes: Record<number, 'up' | 'down' | null> = {};
      data.forEach(newPos => {
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
        // Clear pulses after animation ends
        setTimeout(() => setPriceChanges({}), 2100);
      }

      setPositions(data);
      positionsRef.current = data; // Update ref for next comparison
      setLastRefreshed(new Date());
      setRefreshError(null);

      // Only reload stats if it's the first load or something likely changed
      // For silent refreshes, we might skip it or do it less often
      loadPortfolioStats();
    } catch (err) {
      console.error('Failed to load positions:', err);
      if (!silent) setRefreshError('Market offline');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []); // NO DEPENDENCIES - Decoupled from positions state

  useEffect(() => {
    loadPositions(false); // Initial full load
    loadMarketStatus();
    const intervalId = setInterval(() => {
      loadPositions(true); // Silent periodic updates
      loadMarketStatus();
    }, 30000); // refresh every 30s
    return () => clearInterval(intervalId);
  }, [loadPositions]);

  // WebSocket Price Update Handler
  useEffect(() => {
    if (lastMessage && lastMessage.type === 'PRICE_UPDATE' && lastMessage.data) {
      const quote = lastMessage.data;
      if (quote.symbol) {
        setPositions(currentPositions => {
          const updated = currentPositions.map(p => {
            if (p.symbol === quote.symbol) {
              return {
                ...p,
                current_price: quote.price,
                // Update Greeks if available
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

          positionsRef.current = updated; // Keep ref in sync
          return updated;
        });

        // Trigger flash animation
        const matchingIds = positionsRef.current.filter(p => p.symbol === quote.symbol).map(p => p.id);
        if (matchingIds.length > 0) {
          // We could optimize this, but for now relies on the polling diff logic which effectively just shows pulse
          // Actually, for immediate flash, we can set priceChanges manually here if we wanted.
        }
      }
    }
  }, [lastMessage]);

  const getPnL = (pos: Position) => {
    if (pos.current_price == null) return 0;
    return (Number(pos.current_price) - Number(pos.entry_price)) * pos.quantity * 100; // Assuming standard options contract size 100
  };

  const getRoi = (pos: Position) => {
    const cost = Number(pos.entry_price) * 100 * Number(pos.quantity);
    if (cost === 0 || !pos.entry_price || !pos.quantity) return 0;

    // For closed positions, use realized_pnl; for open positions, calculate from current price
    if (pos.status === 'CLOSED' && pos.realized_pnl !== undefined) {
      return (Number(pos.realized_pnl) / cost) * 100;
    }

    // For open positions, calculate unrealized ROI
    if (pos.current_price == null) return 0;
    const unrealizedPnl = (Number(pos.current_price) - Number(pos.entry_price)) * Number(pos.quantity) * 100;
    return (unrealizedPnl / cost) * 100;
  };

  const getDte = (expirationDate: string) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = parseLocalDate(expirationDate);
    exp.setHours(0, 0, 0, 0);
    const diffTime = exp.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };
  const filteredPositions = useMemo(() => {
    let result = positions.filter(pos => {
      // Symbol Filter
      if (debouncedTicker && !pos.symbol.toLowerCase().includes(debouncedTicker.toLowerCase())) {
        return false;
      }

      // Status Filter
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'OPEN_ONLY' && pos.status !== 'OPEN') return false;
        if (statusFilter === 'STOPPED' && pos.status !== 'STOP_TRIGGERED') return false;
        if (statusFilter === 'PROFIT' && pos.status !== 'PROFIT_TRIGGERED') return false;
        if (statusFilter === 'CLOSED' && pos.status !== 'CLOSED') return false;
        if (['OPEN', 'STOP_TRIGGERED', 'PROFIT_TRIGGERED', 'CLOSED'].includes(statusFilter) && pos.status !== statusFilter) {
          return false;
        }
      } else if (pos.status === 'CLOSED') {
        return false;
      }

      return true;
    });

    // Sorting Logic
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
          valB = b.realized_pnl || getPnL(b); // use realized pnl if available
        }

        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return result;
  }, [positions, debouncedTicker, statusFilter, sortConfig]);

  const toggleSort = (key: 'symbol' | 'dte' | 'pnl' | 'pnl_desc' | 'dte_asc') => {
    setSortConfig(current => {
      // If using the dropdown keys (with direction suffix)
      if (key === 'pnl_desc') return { key: 'pnl', direction: 'desc' };
      if (key === 'dte_asc') return { key: 'dte', direction: 'asc' };
      if (key === 'symbol') {
        if (current?.key === 'symbol') {
          return { key: 'symbol', direction: current.direction === 'asc' ? 'desc' : 'asc' };
        }
        return { key: 'symbol', direction: 'asc' };
      }

      // Default table header toggle logic
      if (current?.key === key) {
        return { key: key as any, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key: key as any, direction: 'asc' };
    });
  };

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

  const handleForceSync = async () => {
    setLoading(true);
    try {
      await api.forcePoll();
      await loadPositions(false);
    } catch (err) {
      console.error('Failed to force sync:', err);
    } finally {
      setLoading(false);
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

  return (
    <div className="container mx-auto py-8 space-y-8">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-4 rounded-lg border shadow-sm">
          <div className="flex flex-col">
            {/* ... title and status stuff ... */}
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold transition-all">Positions Monitor</h2>
              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground font-mono">
                v1.2.7 {import.meta.env.VITE_APP_BUILD_SHA && `(${import.meta.env.VITE_APP_BUILD_SHA.substring(0, 7)})`}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-[8px] sm:text-xs text-muted-foreground">Track your option trades and alerts</p>
              {marketStatus && (
                <>
                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${marketStatus.open ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} />
                    <span className={`text-[8px] sm:text-xs font-medium uppercase tracking-wider ${marketStatus.open ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      Market {marketStatus.open ? 'Open' : 'Closed'}
                    </span>
                  </div>
                </>
              )}
              {lastRefreshed && (
                <>
                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5">
                    <Activity className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">
                      Last updated {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                </>
              )}
              {refreshError && (
                <>
                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5 text-red-500 animate-pulse">
                    <AlertTriangle className="h-3 w-3" />
                    <span className="text-[10px] font-bold uppercase tracking-tighter">
                      {refreshError}
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
              <TabsTrigger value="prediction">AI Prediction</TabsTrigger>
              {user.role === 'ADMIN' && (
                <TabsTrigger value="users">Users</TabsTrigger>
              )}
            </TabsList>
            {/* Mobile Dropdown */}
            <div className="md:hidden order-2">
              <Select value={activeTab} onValueChange={setActiveTab}>
                <SelectTrigger className="h-9 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="overview">Overview</SelectItem>
                  <SelectItem value="portfolio">Portfolio</SelectItem>
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


            <Button variant="outline" size="icon" onClick={() => loadPositions(false)}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
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
                    loadPositions(false);
                    handleDialogChange(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Global Details Modal */}
        {selectedPosition && (
          <PositionDetailsDialog
            position={selectedPosition}
            open={isDetailsOpen}
            onOpenChange={setIsDetailsOpen}
            onCloseUpdate={loadPositions}
          />
        )}

        <TabsContent value="overview" className="space-y-8 mt-0">

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Active Positions
                  <Activity className="h-4 w-4" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{positions.filter(p => p.status !== 'CLOSED').length}</div>
              </CardContent>
            </Card>
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Realized PnL
                  <TrendingUp className="h-4 w-4" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text - 2xl font - bold ${totalRealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'} `}>
                  ${totalRealizedPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="md:col-span-2 hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Performance (Cumulative PnL)
                  <BarChart3 className="h-4 w-4" />
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[60px] p-0 px-6">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
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
                    {/* Ticker Search */}
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

                    {/* Bulk Actions (Visible when selected) */}
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

                    {/* Status Filter */}
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


                    {/* Sort Select */}
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
                {/* Desktop View Table */}
                <div className="hidden md:block overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[30px]">
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
                            checked={filteredPositions.length > 0 && selectedIds.size === filteredPositions.length}
                            onChange={toggleSelectAll}
                          />
                        </TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort('symbol')}>
                          <div className="flex items-center gap-1">
                            Symbol {sortConfig?.key === 'symbol' && <ArrowUpDown className="h-3 w-3" />}
                          </div>
                        </TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort('dte')}>
                          <div className="flex items-center gap-1">
                            DTE {sortConfig?.key === 'dte' && <ArrowUpDown className="h-3 w-3" />}
                          </div>
                        </TableHead>
                        <TableHead>Alerts</TableHead>
                        <TableHead>Trend</TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleSort('pnl')}>
                          <div className="flex items-center gap-1">
                            PnL {sortConfig?.key === 'pnl' && <ArrowUpDown className="h-3 w-3" />}
                          </div>
                        </TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loading ? (
                        <TableRow><TableCell colSpan={8} className="text-center py-8">Loading...</TableCell></TableRow>
                      ) : filteredPositions.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center py-12">
                            <div className="flex flex-col items-center justify-center text-muted-foreground gap-2">
                              <Search className="h-8 w-8 opacity-20" />
                              <p>No matching trades found.</p>
                              {(tickerFilter || statusFilter !== 'ALL') && (
                                <Button
                                  variant="link"
                                  onClick={() => {
                                    setTickerFilter('');
                                    setDebouncedTicker('');
                                    setStatusFilter('ALL');
                                  }}
                                  className="text-primary hover:no-underline"
                                >
                                  Clear all filters
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredPositions.map((pos) => (
                          <TableRow key={pos.id} className={cn("hover:bg-muted/50 transition-colors", pos.status !== 'OPEN' && 'bg-orange-50/50 dark:bg-orange-900/5', selectedIds.has(pos.id) && "bg-muted")}>
                            <TableCell>
                              <input
                                type="checkbox"
                                className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
                                checked={selectedIds.has(pos.id)}
                                onChange={() => toggleSelection(pos.id)}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-bold">{pos.symbol}</span>
                                <span className="text-[10px] text-muted-foreground uppercase">{pos.option_type} ${Number(pos.strike_price).toFixed(2)}</span>
                                <span className="text-[10px] text-muted-foreground font-medium">Exp: {parseLocalDate(pos.expiration_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-xs">
                                <div className={cn("font-bold", getDte(pos.expiration_date) < 7 ? "text-red-500 animate-pulse" : "text-blue-600 dark:text-blue-400")}>{getDte(pos.expiration_date)}d</div>
                                <div className="opacity-70">In: ${Number(pos.entry_price).toFixed(2)}</div>
                                <div className={cn("opacity-70 transition-colors duration-500 px-1 rounded", priceChanges[pos.id] === 'up' ? 'pulse-up' : priceChanges[pos.id] === 'down' ? 'pulse-down' : '')}>
                                  Now: ${pos.current_price != null ? Number(pos.current_price).toFixed(2) : '-'}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-[10px] space-y-1">
                                <div className="text-red-500 font-medium whitespace-nowrap">
                                  SL: ${typeof pos.stop_loss_trigger === 'number' ? pos.stop_loss_trigger.toFixed(2) : '-'}
                                </div>
                                {pos.take_profit_trigger != null && (
                                  <div className="text-green-600 font-medium whitespace-nowrap">TP: ${Number(pos.take_profit_trigger).toFixed(2)}</div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="w-[100px] min-w-[100px]">
                              <div className="h-[30px] w-full">
                                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                                  <LineChart data={historyData[pos.id] || []}>
                                    <YAxis hide domain={['auto', 'auto']} />
                                    <Line type="monotone" dataKey="price" stroke={getPnL(pos) >= 0 ? '#10b981' : '#ef4444'} strokeWidth={2} dot={false} isAnimationActive={false} />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className={cn("font-bold transition-premium p-1 rounded", getPnL(pos) >= 0 ? 'text-green-500' : 'text-red-500', priceChanges[pos.id] === 'up' ? 'pulse-up' : priceChanges[pos.id] === 'down' ? 'pulse-down' : '')}>
                                {getPnL(pos) >= 0 ? '+' : ''}{getPnL(pos).toFixed(2)}
                                <div className="text-[10px] opacity-70">
                                  ({getRoi(pos) > 0 ? '+' : ''}{getRoi(pos).toFixed(2)}%)
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              {pos.status === 'STOP_TRIGGERED' ? (
                                <Badge variant="destructive" className="text-[10px] px-1 py-0 animate-pulse">STOP</Badge>
                              ) : pos.status === 'PROFIT_TRIGGERED' ? (
                                <Badge className="bg-green-500 text-[10px] px-1 py-0 animate-pulse">PROFIT</Badge>
                              ) : pos.status === 'CLOSED' ? (
                                <Badge variant="secondary" className="text-[10px] px-1 py-0">CLOSED</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] px-1 py-0">OPEN</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-500 hover:text-blue-600" onClick={() => handleViewDetails(pos)}>
                                  <Info className="h-4 w-4" />
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="h-8 w-8 p-0">
                                      <span className="sr-only">Open menu</span>
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                    <DropdownMenuItem onClick={() => handleEdit(pos)}>
                                      <Pencil className="mr-2 h-4 w-4" />
                                      Edit Position
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => handleDelete(pos.id)}
                                      className="text-red-500 focus:text-red-500"
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Delete Position
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile View Cards */}
                <div className="md:hidden space-y-4 px-4 pb-4">
                  {loading ? (
                    <div className="text-center py-8 text-muted-foreground animate-pulse">Loading positions...</div>
                  ) : filteredPositions.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <Search className="h-8 w-8 mx-auto opacity-20 mb-2" />
                      <p>No matching trades.</p>
                      <Button variant="link" size="sm" onClick={() => { setTickerFilter(''); setDebouncedTicker(''); setStatusFilter('ALL'); }} className="mt-2">Clear filters</Button>
                    </div>
                  ) : (
                    filteredPositions.map((pos) => (
                      <Card key={pos.id} className={cn("overflow-hidden border shadow-sm", pos.status !== 'OPEN' && 'border-orange-200 dark:border-orange-900/30 bg-orange-50/20')}>
                        <CardContent className="p-4 space-y-3">
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-lg">{pos.symbol}</span>
                                <Badge variant={pos.option_type === 'CALL' ? 'default' : 'secondary'} className="text-[9px] h-4">
                                  {pos.option_type}
                                </Badge>
                              </div>
                              <p className="text-[10px] text-muted-foreground">
                                ${Number(pos.strike_price).toFixed(2)} • <span className={cn(getDte(pos.expiration_date) < 7 && "text-red-500 font-bold")}>
                                  {parseLocalDate(pos.expiration_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </span>
                              </p>
                            </div>
                            <div className="text-right">
                              <div className={cn("font-bold text-lg", getPnL(pos) >= 0 ? 'text-green-500' : 'text-red-500')}>
                                {getPnL(pos) >= 0 ? '+' : ''}{getPnL(pos).toFixed(2)}
                              </div>
                              <div className={cn("text-xs opacity-80", getPnL(pos) >= 0 ? 'text-green-600' : 'text-red-600')}>
                                {getRoi(pos) > 0 ? '+' : ''}{getRoi(pos).toFixed(1)}%
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 py-2 border-y border-muted/50 text-xs">
                            <div>
                              <p className="text-[9px] text-muted-foreground uppercase">Current Price</p>
                              <p className={cn("font-mono font-medium transition-colors duration-500 px-1 rounded", priceChanges[pos.id] === 'up' ? 'pulse-up' : priceChanges[pos.id] === 'down' ? 'pulse-down' : '')}>
                                ${pos.current_price != null ? Number(pos.current_price).toFixed(2) : '-'}
                              </p>
                            </div>
                            <div>
                              <p className="text-[9px] text-muted-foreground uppercase">Stop Loss</p>
                              <p className="font-mono font-medium text-red-500">${pos.stop_loss_trigger?.toFixed(2)}</p>
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-1">
                            {pos.status === 'OPEN' ? (
                              <Badge variant="outline" className="text-[9px]">OPEN</Badge>
                            ) : (
                              <Badge variant="destructive" className="text-[9px] animate-pulse">{pos.status === 'STOP_TRIGGERED' ? 'STOPPED' : 'PROFIT'}</Badge>
                            )}
                            <div className="flex gap-2">
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-500 hover:text-blue-600" onClick={() => handleViewDetails(pos)}>
                                <Info className="h-4 w-4" />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8">
                                    <span className="sr-only">Open menu</span>
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                  <DropdownMenuItem onClick={() => handleEdit(pos)}>
                                    <Pencil className="mr-2 h-4 w-4" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => handleDelete(pos.id)}
                                    className="text-red-500 focus:text-red-500"
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>


          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg sm:text-xl flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-500" />
                History & Analytics
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 sm:p-6 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="hidden md:table-cell">Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Realized PnL</TableHead>
                    <TableHead className="hidden md:table-cell">Loss Avoided</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.filter(p => p.status === 'CLOSED').length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No history available.</TableCell></TableRow>
                  ) : (
                    positions.filter(p => p.status === 'CLOSED').map((pos) => (
                      <TableRow key={pos.id} className="group">
                        <TableCell>
                          <div className="font-bold">{pos.symbol}</div>
                          <div className="text-[10px] text-muted-foreground uppercase">{pos.option_type} ${pos.strike_price}</div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          {Math.floor((new Date(pos.updated_at).getTime() - new Date(pos.created_at).getTime()) / (1000 * 60 * 60 * 24))} days
                        </TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">CLOSED</Badge></TableCell>
                        <TableCell>
                          <div className={`font-bold ${Number(pos.realized_pnl) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            ${Number(pos.realized_pnl).toFixed(2)}
                            <span className="ml-1 text-[10px] opacity-70">({getRoi(pos).toFixed(2)}%)</span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-blue-500 font-medium text-xs">${Number(pos.loss_avoided || 0).toFixed(2)}</span>
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" className="h-7 text-[10px] transition-opacity hover:bg-primary/10 hover:text-primary" onClick={() => api.reopenPosition(pos.id).then(() => loadPositions(false))}>
                            <RefreshCw className="h-3 w-3 mr-1" /> Reopen
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="portfolio" className="space-y-8 mt-0">
          {/* AI Portfolio Manager */}
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
                    <p className="text-xs text-muted-foreground max-w-[300px]">Reviewing all Greeks, price action, and risk scenarios for your entire portfolio.</p>
                  </div>
                </div>
              ) : portfolioBriefing ? (
                <div className="p-6 space-y-4 animate-in fade-in slide-in-from-top-4 duration-700">
                  <div className="relative">
                    <div className="p-4 rounded-xl bg-background border shadow-inner text-sm leading-relaxed whitespace-pre-wrap font-sans italic text-slate-700 dark:text-slate-300">
                      {portfolioBriefing.briefing}
                    </div>
                    <div className="absolute -top-3 -right-3">
                      <Badge className="bg-primary text-[9px] uppercase tracking-wider">Strategic Insight</Badge>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
                    <Info className="h-3 w-3" />
                    Generated by AI based on current market data and risk profile.
                  </div>
                </div>
              ) : (
                <div className="p-10 flex flex-col items-center justify-center space-y-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">
                  <Activity className="h-10 w-10 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground max-w-[280px]">Need a bird's-eye view? Click above to have AI analyze your total risk exposure and suggest strategic adjustments.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Win Rate
                  <Trophy className="h-4 w-4 text-yellow-500" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.winRate ?? 0}%</div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {stats?.closedTrades} closed trades
                </p>
              </CardContent>
            </Card>

            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Profit Factor
                  <Percent className="h-4 w-4 text-blue-500" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.profitFactor ?? 0}</div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Gross Profit / Gross Loss
                </p>
              </CardContent>
            </Card>

            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Total Realized PnL
                  <TrendingUp className="h-4 w-4 text-green-500" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${(stats?.totalRealizedPnl ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  ${stats?.totalRealizedPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Net profit across all time
                </p>
              </CardContent>
            </Card>

            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                  Avg Profit per Trade
                  <Activity className="h-4 w-4 text-purple-500" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  ${stats?.closedTrades ? (stats.totalRealizedPnl / stats.closedTrades).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '0.00'}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Realized PnL / Closed Trades
                </p>
              </CardContent>
            </Card>
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
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-xs text-muted-foreground">Total At Risk</div>
                <div className="text-lg font-bold">
                  ${exposureData.reduce((acc, d) => acc + d.value, 0).toLocaleString()}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="w-full">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-primary" />
                Equity Curve (Cumulative Realized PnL)
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
