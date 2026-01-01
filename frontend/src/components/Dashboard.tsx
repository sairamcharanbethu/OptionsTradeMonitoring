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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from '@/components/ui/dialog';
import { TrendingDown, TrendingUp, AlertTriangle, Plus, Pencil, Trash2, RefreshCw } from 'lucide-react';
import PositionForm from './PositionForm';

export default function Dashboard() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);

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

  useEffect(() => {
    loadPositions();
  }, []);

  async function loadPositions() {
    try {
      const data = await api.getPositions();
      setPositions(data);
    } catch (err) {
      console.error(err);
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

  return (
    <div className="container mx-auto py-8 space-y-8">
      {/* ... keeping previous content same until History table ... */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Positions Monitor</h1>
          <p className="text-muted-foreground mt-1">Track your option trades and alerts</p>
        </div>
        <div className="flex gap-2">
            <Button variant="outline" size="icon" onClick={loadPositions}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
            <DialogTrigger asChild>
                <Button>
                <Plus className="mr-2 h-4 w-4" />
                Track Position
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{positions.filter(p => p.status === 'OPEN' || p.status === 'STOP_TRIGGERED').length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Realized PnL</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${positions.reduce((acc, p) => acc + (p.realized_pnl || 0), 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              ${positions.reduce((acc, p) => acc + (p.realized_pnl || 0), 0).toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Tracker</CardTitle>
        </CardHeader>
        {/* ... Active Tracker table same ... */}
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Peak</TableHead>
                <TableHead>Stop Loss</TableHead>
                <TableHead>PnL</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-4">Loading...</TableCell>
                </TableRow>
              ) : positions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-4 text-muted-foreground">No positions tracked yet.</TableCell>
                </TableRow>
              ) : (
                positions.filter(p => p.status === 'OPEN' || p.status === 'STOP_TRIGGERED').map((pos) => (
                  <TableRow key={pos.id} className={pos.status === 'STOP_TRIGGERED' ? 'bg-red-50 dark:bg-red-900/10' : ''}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span>{pos.symbol}</span>
                        <span className="text-xs text-muted-foreground">{pos.option_type} ${pos.strike_price}</span>
                      </div>
                    </TableCell>
                    <TableCell>${pos.entry_price} (Premium)</TableCell>
                    <TableCell>${pos.current_price || '-'} (Premium)</TableCell>
                    <TableCell>${pos.trailing_high_price || '-'} (Peak)</TableCell>
                    <TableCell className="text-orange-500 font-medium">
                      ${pos.stop_loss_trigger ? Number(pos.stop_loss_trigger).toFixed(2) : '-'} (Stop)
                    </TableCell>
                    <TableCell className={getPnL(pos) >= 0 ? 'text-green-500' : 'text-red-500'}>
                      ${getPnL(pos).toFixed(2)}
                      <span className="ml-2 text-xs opacity-75">
                         ({getRoi(pos) > 0 ? '+' : ''}{getRoi(pos).toFixed(2)}%)
                      </span>
                    </TableCell>
                    <TableCell>
                      {pos.status === 'STOP_TRIGGERED' ? (
                         <Badge variant="destructive" className="animate-pulse">SUGGEST CLOSE</Badge>
                      ) : (
                         <Badge variant="outline">OPEN</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {pos.status === 'STOP_TRIGGERED' && (
                            <Button size="sm" variant="destructive" onClick={async () => {
                                if(confirm(`Confirm closing ${pos.symbol} at current price?`)) {
                                    await api.closePosition(pos.id);
                                    loadPositions();
                                }
                            }}>
                                Close Now
                            </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(pos)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-700" onClick={() => handleDelete(pos.id)}>
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
          <CardTitle>History & Analytics</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Realized PnL</TableHead>
                <TableHead>Loss Avoided</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.filter(p => p.status === 'CLOSED').length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">No closed positions yet.</TableCell>
                </TableRow>
              ) : (
                positions.filter(p => p.status === 'CLOSED').map((pos) => (
                  <TableRow key={pos.id}>
                    <TableCell className="font-medium">{pos.symbol}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="destructive">CLOSED</Badge>
                        <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-6 text-xs text-muted-foreground hover:text-primary"
                            onClick={async () => {
                                if(confirm('Reopen this position? It will track from current market price.')) {
                                    await api.reopenPosition(pos.id);
                                    loadPositions();
                                }
                            }}
                        >
                            <RefreshCw className="h-3 w-3 mr-1" /> Reopen
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className={Number(pos.realized_pnl) >= 0 ? 'text-green-500' : 'text-red-500'}>
                      ${Number(pos.realized_pnl).toFixed(2)}
                      <span className="ml-2 text-xs opacity-75">
                         ({getRoi(pos) > 0 ? '+' : ''}{getRoi(pos).toFixed(2)}%)
                      </span>
                    </TableCell>
                    <TableCell className="text-blue-500 font-medium">
                      ${Number(pos.loss_avoided || 0).toFixed(2)}
                    </TableCell>
                    <TableCell>{new Date(pos.updated_at).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
