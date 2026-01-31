import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    LineChart,
    Line,
    YAxis,
    ResponsiveContainer,
} from 'recharts';
import {
    ArrowUpDown,
    MoreHorizontal,
    Pencil,
    Trash2,
    Info,
    Search
} from 'lucide-react';
import { cn, parseLocalDate, getDte, getPnL, getRoi } from '@/lib/utils';
import { Position } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';

interface PositionsTableProps {
    positions: Position[];
    loading: boolean;
    selectedIds: Set<number>;
    sortConfig: { key: 'symbol' | 'dte' | 'pnl', direction: 'asc' | 'desc' } | null;
    priceChanges: Record<number, 'up' | 'down' | null>;
    historyData: Record<number, any[]>;
    tickerFilter: string;
    statusFilter: string;
    onSort: (key: 'symbol' | 'dte' | 'pnl') => void;
    onToggleSelection: (id: number) => void;
    onToggleSelectAll: () => void;
    onClearFilters: () => void;
    // onViewDetails removed, internal navigation used
    onEdit: (pos: Position) => void;
    onDelete: (id: number) => void;
}

export function PositionsTable({
    positions,
    loading,
    selectedIds,
    sortConfig,
    priceChanges,
    historyData,
    tickerFilter,
    statusFilter,
    onSort,
    onToggleSelection,
    onToggleSelectAll,
    onClearFilters,
    // onViewDetails,
    onEdit,
    onDelete
}: PositionsTableProps) {
    const navigate = useNavigate();

    return (
        <>
            {/* Desktop View Table */}
            <div className="hidden md:block overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-[30px]">
                                <input
                                    type="checkbox"
                                    className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
                                    checked={positions.length > 0 && selectedIds.size === positions.length}
                                    onChange={onToggleSelectAll}
                                />
                            </TableHead>
                            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onSort('symbol')}>
                                <div className="flex items-center gap-1">
                                    Symbol {sortConfig?.key === 'symbol' && <ArrowUpDown className="h-3 w-3" />}
                                </div>
                            </TableHead>
                            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onSort('dte')}>
                                <div className="flex items-center gap-1">
                                    DTE {sortConfig?.key === 'dte' && <ArrowUpDown className="h-3 w-3" />}
                                </div>
                            </TableHead>
                            <TableHead>Alerts</TableHead>
                            <TableHead>Trend</TableHead>
                            <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onSort('pnl')}>
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
                        ) : positions.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={8} className="text-center py-12">
                                    <div className="flex flex-col items-center justify-center text-muted-foreground gap-2">
                                        <Search className="h-8 w-8 opacity-20" />
                                        <p>No matching trades found.</p>
                                        {(tickerFilter || statusFilter !== 'ALL') && (
                                            <Button
                                                variant="link"
                                                onClick={onClearFilters}
                                                className="text-primary hover:no-underline"
                                            >
                                                Clear all filters
                                            </Button>
                                        )}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : (
                            positions.map((pos) => (
                                <TableRow key={pos.id} className={cn("hover:bg-muted/50 transition-colors", pos.status !== 'OPEN' && 'bg-orange-50/50 dark:bg-orange-900/5', selectedIds.has(pos.id) && "bg-muted")}>
                                    <TableCell>
                                        <input
                                            type="checkbox"
                                            className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
                                            checked={selectedIds.has(pos.id)}
                                            onChange={() => onToggleSelection(pos.id)}
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
                                            <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-500 hover:text-blue-600" onClick={() => navigate(`/positions/${pos.id}`)}>
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
                                                    <DropdownMenuItem onClick={() => onEdit(pos)}>
                                                        <Pencil className="mr-2 h-4 w-4" />
                                                        Edit Position
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        onClick={() => onDelete(pos.id)}
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
                ) : positions.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <Search className="h-8 w-8 mx-auto opacity-20 mb-2" />
                        <p>No matching trades.</p>
                        <Button variant="link" size="sm" onClick={onClearFilters} className="mt-2">Clear filters</Button>
                    </div>
                ) : (
                    positions.map((pos) => (
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
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-500 hover:text-blue-600" onClick={() => navigate(`/positions/${pos.id}`)}>
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
                                                <DropdownMenuItem onClick={() => onEdit(pos)}>
                                                    <Pencil className="mr-2 h-4 w-4" />
                                                    Edit
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    onClick={() => onDelete(pos.id)}
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
        </>
    );
}
