import React, { useEffect, useState } from 'react';
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
import { TrendingDown, TrendingUp, AlertTriangle, Plus, Pencil, Trash2, RefreshCw, BarChart3, PieChart as PieChartIcon, Activity, Search, X, Zap, CheckCircle } from 'lucide-react';
import {
  LineChart,
  Line,
  ResponsiveContainer,
  YAxis,
  XAxis,
  Tooltip,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell
} from 'recharts';
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
import { User } from '@/lib/api';

interface DashboardProps {
  user: User;
  onUserUpdate: (user: User) => void;
}

export default function Dashboard({ user, onUserUpdate }: DashboardProps) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [marketStatus, setMarketStatus] = useState<{ open: boolean; marketHours: string } | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Filter States
  const [tickerFilter, setTickerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [dteFilter, setDteFilter] = useState('');

  const handleEdit = (pos: Position) => {
    setEditingPosition(pos);
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this position?')) {
      try {
        await api.deletePosition(id);
        loadPositions();
      } catch (err) {
        console.error(err);
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

  useEffect(() => {
    loadPositions();
    loadMarketStatus();
    const statusInterval = setInterval(loadMarketStatus, 60000);
    const positionsInterval = setInterval(loadPositions, 5000);
    return () => {
      clearInterval(statusInterval);
      clearInterval(positionsInterval);
    };
  }, []);

  async function loadPositions() {
    try {
      const data = await api.getPositions();
      setPositions(data);
      setLastRefreshed(new Date());
      setRefreshError(null);
    } catch (err) {
      console.error('Failed to load positions:', err);
      setRefreshError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  const getPnL = (pos: Position) => {
    if (!pos.current_price) return 0;
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
    if (!pos.current_price) return 0;
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

  const [historyData, setHistoryData] = useState<Record<number, any[]>>({});

  const filteredPositions = positions.filter(pos => {
    // Symbol Filter
    if (tickerFilter && !pos.symbol.toLowerCase().includes(tickerFilter.toLowerCase())) {
      return false;
    }

    // Status Filter
    if (statusFilter !== 'ALL') {
      if (statusFilter === 'OPEN_ONLY' && pos.status !== 'OPEN') return false;
      if (statusFilter === 'STOPPED' && pos.status !== 'STOP_TRIGGERED') return false;
      if (statusFilter === 'PROFIT' && pos.status !== 'PROFIT_TRIGGERED') return false;
      if (statusFilter === 'CLOSED' && pos.status !== 'CLOSED') return false;
      // Handle direct matches if needed
      if (['OPEN', 'STOP_TRIGGERED', 'PROFIT_TRIGGERED', 'CLOSED'].includes(statusFilter) && pos.status !== statusFilter) {
        return false;
      }
    } else {
      // Default view: exclude CLOSED if "ALL" is not literally selected but we just want active ones?
      // Actually, user said "filters", lets keep it simple: ALL shows everything.
    }

    // DTE Filter
    if (dteFilter) {
      const dte = getDte(pos.expiration_date);
      if (dte > parseInt(dteFilter)) return false;
    }

    return true;
  });

  useEffect(() => {
    positions.forEach(pos => {
      if ((pos.status === 'OPEN' || pos.status === 'STOP_TRIGGERED' || pos.status === 'PROFIT_TRIGGERED') && !historyData[pos.id]) {
        api.getPositionHistory(pos.id).then(data => {
          setHistoryData(prev => ({ ...prev, [pos.id]: data }));
        });
      }
    });
  }, [positions]);

  const totalRealizedPnL = positions.reduce((acc, p) => acc + (p.realized_pnl || 0), 0);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const exposureData = Object.entries(
    positions.filter(p => p.status !== 'CLOSED').reduce((acc, p) => {
      acc[p.symbol] = (acc[p.symbol] || 0) + (p.entry_price * p.quantity * 100);
      return acc;
    }, {} as Record<string, number>)
  ).map(([name, value]) => ({ name, value }));

  async function handleForceSync() {
    try {
      setLoading(true);
      setRefreshError(null);
      await api.forcePoll();
      await loadPositions();
      setLastRefreshed(new Date());
    } catch (err) {
      console.error('Force sync failed:', err);
      setRefreshError('Sync failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto py-8 space-y-8">
      <Tabs defaultValue="overview" className="space-y-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-card p-4 rounded-lg border shadow-sm">
          <div className="flex flex-col">
            {/* ... title and status stuff ... */}
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-bold transition-all">Positions Monitor</h1>
              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground font-mono">v1.2.0</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-[10px] sm:text-sm text-muted-foreground">Track your option trades and alerts</p>
              {marketStatus && (
                <>
                  <span className="text-[10px] text-muted-foreground mr-1">|</span>
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${marketStatus.open ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} />
                    <span className={`text-[10px] font-medium uppercase tracking-wider ${marketStatus.open ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
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
                      Refreshed at {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
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
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {user.role === 'ADMIN' && (
                <TabsTrigger value="users">Users</TabsTrigger>
              )}
            </TabsList>
            <SettingsDialog user={user} onUpdate={onUserUpdate} />
            <Button variant="outline" size="sm" className="hidden sm:flex gap-1 text-xs" onClick={handleForceSync} disabled={loading}>
              <Zap className={`h-3 w-3 ${loading ? 'text-yellow-500 animate-pulse' : 'text-yellow-500'}`} />
              Force Sync
            </Button>
            <Button variant="outline" size="icon" className="sm:hidden" onClick={handleForceSync} disabled={loading}>
              <Zap className={`h-4 w-4 ${loading ? 'text-yellow-500 animate-pulse' : 'text-yellow-500'}`} />
            </Button>


            <Button variant="outline" size="icon" onClick={loadPositions}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
              <DialogTrigger asChild>
                <Button className="rounded-full sm:rounded-md w-10 h-10 sm:w-auto sm:h-10 p-0 sm:px-4">
                  <Plus className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Track Position</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[600px]">
                <DialogHeader>
                  <DialogTitle>{editingPosition ? 'Edit Position' : 'Track New Position'}</DialogTitle>
                </DialogHeader>
                <PositionForm
                  position={editingPosition || undefined}
                  onSuccess={() => {
                    loadPositions();
                    handleDialogChange(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>

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
                <div className={`text-2xl font-bold ${totalRealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
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

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
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

                    {/* DTE Filter */}
                    <div className="relative min-w-[100px]">
                      <Input
                        type="number"
                        placeholder="Max DTE"
                        value={dteFilter}
                        onChange={(e) => setDteFilter(e.target.value)}
                        className="h-9 text-xs w-full sm:w-[100px]"
                      />
                      <div className="absolute right-2 top-2.5 pointer-events-none text-[10px] text-muted-foreground">
                        DTE
                      </div>
                    </div>

                    {(tickerFilter || statusFilter !== 'ALL' || dteFilter) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTickerFilter('');
                          setStatusFilter('ALL');
                          setDteFilter('');
                        }}
                        className="h-8 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 sm:p-6 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="hidden md:table-cell">Entry/Current</TableHead>
                      <TableHead>Alerts</TableHead>
                      <TableHead>Trend</TableHead>
                      <TableHead>PnL</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow><TableCell colSpan={7} className="text-center py-8">Loading...</TableCell></TableRow>
                    ) : filteredPositions.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No matching trades.</TableCell></TableRow>
                    ) : (
                      filteredPositions.map((pos) => (
                        <TableRow key={pos.id} className={pos.status !== 'OPEN' ? 'bg-orange-50/50 dark:bg-orange-900/5' : ''}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-bold">{pos.symbol}</span>
                              <span className="text-[10px] text-muted-foreground uppercase">{pos.option_type} ${Number(pos.strike_price).toFixed(2)}</span>
                              <span className="text-[10px] text-muted-foreground">Exp: {parseLocalDate(pos.expiration_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <div className="text-xs">
                              <div>In: ${Number(pos.entry_price).toFixed(2)}</div>
                              <div className="font-bold">Now: ${pos.current_price ? Number(pos.current_price).toFixed(2) : '-'}</div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-[10px] space-y-1">
                              <div className="text-red-500 font-medium whitespace-nowrap">SL: ${pos.stop_loss_trigger?.toFixed(2)}</div>
                              {pos.take_profit_trigger && (
                                <div className="text-green-600 font-medium whitespace-nowrap">TP: ${pos.take_profit_trigger.toFixed(2)}</div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="w-[100px] min-w-[100px]">
                            <div className="h-[30px]">
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={historyData[pos.id] || []}>
                                  <YAxis hide domain={['auto', 'auto']} />
                                  <Line type="monotone" dataKey="price" stroke={getPnL(pos) >= 0 ? '#10b981' : '#ef4444'} strokeWidth={2} dot={false} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className={`font-bold ${getPnL(pos) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
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
                            ) : (
                              <Badge variant="outline" className="text-[10px] px-1 py-0">OPEN</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <PositionDetailsDialog position={pos} onCloseUpdate={loadPositions} />
                              {(pos.status === 'STOP_TRIGGERED' || pos.status === 'PROFIT_TRIGGERED') && (
                                <Button size="icon" variant="ghost" className="h-8 w-8 text-green-500 hover:text-green-600 hover:bg-green-50" onClick={() => api.closePosition(pos.id).then(loadPositions)}>
                                  <CheckCircle className="h-4 w-4" />
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(pos)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-red-400 hover:text-red-600" onClick={() => handleDelete(pos.id)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

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
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
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
                          <Button variant="ghost" size="sm" className="h-7 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => api.reopenPosition(pos.id).then(loadPositions)}>
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

        {user.role === 'ADMIN' && (
          <TabsContent value="users" className="mt-0">
            <UserManagement />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
