import React, { useState, useEffect, useRef } from 'react';
import { useSignals, QUERY_KEYS } from '@/hooks/useDashboardData';
import { api, Signal } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import {
  Terminal as TerminalIcon,
  ShieldAlert,
  TrendingUp,
  Play,
  XCircle,
  Database,
  AlertCircle,
  HelpCircle,
  Activity,
  ChevronRight,
  Check,
  X,
  RefreshCw,
  Info
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export default function DayTradingTerminal() {
  const queryClient = useQueryClient();
  const { data: signals = [], isLoading, isFetching, refetch } = useSignals(5000);

  // States
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [cliInput, setCliInput] = useState('');
  const [cliLogs, setCliLogs] = useState<string[]>([
    'SS-CLI [Version 1.0.0]',
    '(c) 2026 Options Monitor. All rights reserved.',
    '',
    'System status: ONLINE',
    'Connection status: CONNECTED TO POSTGRES DB',
    'Type "help" to list terminal commands.'
  ]);
  const [countdown, setCountdown] = useState(5);

  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-refresh countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => (prev <= 1 ? 5 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Reset countdown on fetch complete
  useEffect(() => {
    setCountdown(5);
  }, [signals]);

  // Scroll logs to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cliLogs]);

  // Get currently selected signal object
  const selectedSignal = signals.find(s => s.id === selectedSignalId) || null;

  // Set default selected signal when signals load
  useEffect(() => {
    if (signals.length > 0 && selectedSignalId === null) {
      setSelectedSignalId(signals[0].id);
    }
  }, [signals, selectedSignalId]);

  // Helper to add log line
  const addLog = (message: string) => {
    setCliLogs(prev => [...prev, `> ${message}`]);
  };

  // Commands Handler
  const handleCommand = async (cmdStr: string) => {
    const trimmed = cmdStr.trim();
    if (!trimmed) return;

    addLog(`options-monitor:~$ ${trimmed}`);
    const parts = trimmed.split(' ');
    const command = parts[0].toLowerCase();
    const arg = parts[1];

    switch (command) {
      case 'help':
        setCliLogs(prev => [
          ...prev,
          'Available Commands:',
          '  help               - Display this help message',
          '  seed               - Seed the database with sample trade signals',
          '  clear              - Wipe all signals in the database',
          '  exec <id>          - Execute trade for signal with given ID',
          '  cancel <id>        - Cancel trade for signal with given ID',
          '  refresh            - Refetch trade signals from the database',
          '  cls / clear_screen - Clear the terminal output log'
        ]);
        break;

      case 'cls':
      case 'clear_screen':
        setCliLogs([]);
        break;

      case 'seed':
        try {
          addLog('Executing database seeding...');
          const res = await api.seedSignals();
          if (res.success) {
            setCliLogs(prev => [...prev, `SUCCESS: Seeded ${res.insertedCount} mock signals into Postgres.`]);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
          }
        } catch (err: any) {
          setCliLogs(prev => [...prev, `ERROR: ${err.message || 'Seeding failed'}`]);
        }
        break;

      case 'clear':
        try {
          addLog('Wiping signals table...');
          const res = await api.clearSignals();
          if (res.success) {
            setCliLogs(prev => [...prev, `SUCCESS: ${res.message}`]);
            setSelectedSignalId(null);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
          }
        } catch (err: any) {
          setCliLogs(prev => [...prev, `ERROR: ${err.message || 'Clear failed'}`]);
        }
        break;

      case 'exec':
      case 'execute':
        if (!arg) {
          setCliLogs(prev => [...prev, 'ERROR: Missing ID argument. Usage: exec <id>']);
          break;
        }
        const execId = parseInt(arg);
        if (isNaN(execId)) {
          setCliLogs(prev => [...prev, 'ERROR: ID must be a numeric value.']);
          break;
        }
        try {
          addLog(`Setting signal ${execId} status to EXECUTED...`);
          await api.updateSignalStatus(execId, 'EXECUTED');
          setCliLogs(prev => [...prev, `SUCCESS: Signal #${execId} is now EXECUTED.`]);
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
        } catch (err: any) {
          setCliLogs(prev => [...prev, `ERROR: ${err.message || 'Execution failed'}`]);
        }
        break;

      case 'cancel':
        if (!arg) {
          setCliLogs(prev => [...prev, 'ERROR: Missing ID argument. Usage: cancel <id>']);
          break;
        }
        const cancelId = parseInt(arg);
        if (isNaN(cancelId)) {
          setCliLogs(prev => [...prev, 'ERROR: ID must be a numeric value.']);
          break;
        }
        try {
          addLog(`Setting signal ${cancelId} status to CANCELLED...`);
          await api.updateSignalStatus(cancelId, 'CANCELLED');
          setCliLogs(prev => [...prev, `SUCCESS: Signal #${cancelId} has been CANCELLED.`]);
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
        } catch (err: any) {
          setCliLogs(prev => [...prev, `ERROR: ${err.message || 'Cancellation failed'}`]);
        }
        break;

      case 'refresh':
        addLog('Querying Postgres DB manually...');
        refetch();
        setCliLogs(prev => [...prev, 'Refetched signals successfully.']);
        break;

      default:
        setCliLogs(prev => [...prev, `Command not recognized: "${command}". Type "help" for a list of commands.`]);
        break;
    }

    setCliInput('');
  };

  // Click handler wrapper
  const handleQuickStatus = async (id: number, status: 'EXECUTED' | 'CANCELLED') => {
    try {
      await api.updateSignalStatus(id, status);
      setCliLogs(prev => [...prev, `CLI EVENT: Updated signal #${id} status to ${status}.`]);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    } catch (err: any) {
      alert(`Failed to update status: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 font-mono bg-zinc-950 text-emerald-400 p-4 rounded-xl border border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.05)]">
      {/* Terminal Title Bar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-emerald-500/20 pb-4 gap-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-5 w-5 text-emerald-400 animate-pulse" />
          <div className="flex flex-col">
            <h2 className="text-lg font-bold uppercase tracking-widest text-emerald-300">DAY_TRADING_MONITOR_CLI</h2>
            <span className="text-[10px] text-emerald-500/80">Active channels: QQQ, SPY | Connection: Postgres via Fastify</span>
          </div>
        </div>

        <div className="flex items-center gap-3 self-stretch sm:self-auto justify-between sm:justify-end">
          <div className="flex items-center gap-2 text-xs bg-emerald-950/40 border border-emerald-500/30 px-3 py-1.5 rounded">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isFetching ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isFetching ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
            </span>
            <span>
              {isFetching ? 'POLLING DB...' : `AUTO-SYNC IN: ${countdown}s`}
            </span>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCommand('seed')}
              className="h-8 border-emerald-500/30 hover:border-emerald-400 hover:bg-emerald-950/30 text-emerald-400 text-xs gap-1"
            >
              <Database className="h-3 w-3" />
              Seed Signals
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCommand('clear')}
              className="h-8 border-red-500/30 hover:border-red-400 hover:bg-red-950/30 text-red-400 text-xs gap-1"
            >
              <XCircle className="h-3 w-3" />
              Clear All
            </Button>
          </div>
        </div>
      </div>

      {/* Terminal Stats Box */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 bg-zinc-900/50 p-4 border border-emerald-500/10 rounded">
        <div>
          <span className="text-[10px] text-emerald-500/70 block uppercase">TOTAL SIGNALS</span>
          <span className="text-2xl font-bold text-emerald-300">{signals.length}</span>
        </div>
        <div>
          <span className="text-[10px] text-emerald-500/70 block uppercase">ACTIVE PENDING</span>
          <span className="text-2xl font-bold text-yellow-500">
            {signals.filter(s => s.status === 'PENDING').length}
          </span>
        </div>
        <div>
          <span className="text-[10px] text-emerald-500/70 block uppercase">CALL / PUT BIAS</span>
          <span className="text-2xl font-bold text-sky-400">
            {signals.filter(s => s.signal_type === 'CALL').length} / {signals.filter(s => s.signal_type === 'PUT').length}
          </span>
        </div>
        <div>
          <span className="text-[10px] text-emerald-500/70 block uppercase">AVG CONFIDENCE</span>
          <span className="text-2xl font-bold text-emerald-400">
            {signals.length > 0
              ? `${Math.round(signals.reduce((acc, s) => acc + s.confidence_score, 0) / signals.length)}%`
              : '0%'
            }
          </span>
        </div>
      </div>

      {/* Main Grid: Processes (Signals List) + Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Table List (Process Monitor) */}
        <div className="xl:col-span-2 overflow-hidden flex flex-col border border-emerald-500/20 rounded bg-zinc-900/30">
          <div className="p-3 bg-zinc-900 border-b border-emerald-500/20 flex justify-between items-center">
            <span className="text-xs font-bold text-emerald-300">ACTIVE TRADING SIGNALS (PROCESS_TABLE)</span>
            <span className="text-[10px] text-emerald-500/60">Click row to inspect details</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/80 border-b border-emerald-500/10 text-emerald-500/80 font-bold">
                  <th className="p-3">ID</th>
                  <th className="p-3">SYMBOL</th>
                  <th className="p-3">TYPE</th>
                  <th className="p-3">BIAS</th>
                  <th className="p-3">PRICE</th>
                  <th className="p-3">TRIGGER</th>
                  <th className="p-3">SL</th>
                  <th className="p-3">TP</th>
                  <th className="p-3">CONF</th>
                  <th className="p-3 text-center">GRADE</th>
                  <th className="p-3">STATUS</th>
                  <th className="p-3 text-right">CONTROLS</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && signals.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-12 text-center text-emerald-500/60">
                      <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-emerald-400" />
                      RETRIEVING FROM POSTGRES...
                    </td>
                  </tr>
                ) : signals.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-12 text-center text-red-500/80">
                      [NO SIGNALS FOUND IN DATABASE]
                      <div className="text-[10px] text-emerald-600 mt-2">
                        Type 'seed' in command line below to insert sample data.
                      </div>
                    </td>
                  </tr>
                ) : (
                  signals.map(sig => {
                    const isSelected = sig.id === selectedSignalId;
                    const signalTime = new Date(sig.created_at).toLocaleTimeString('en-US', { hour12: false });
                    const biasColor =
                      sig.signal_type === 'CALL'
                        ? 'text-green-500'
                        : sig.signal_type === 'PUT'
                          ? 'text-red-500'
                          : 'text-zinc-500';

                    const statusBadgeClass =
                      sig.status === 'PENDING'
                        ? 'bg-yellow-950/80 text-yellow-400 border border-yellow-500/30'
                        : sig.status === 'EXECUTED'
                          ? 'bg-green-950/80 text-green-400 border border-green-500/30 animate-pulse'
                          : 'bg-red-950/80 text-red-400 border border-red-500/30';

                    return (
                      <tr
                        key={sig.id}
                        onClick={() => setSelectedSignalId(sig.id)}
                        className={`border-b border-emerald-500/10 hover:bg-emerald-950/10 cursor-pointer transition-colors ${
                          isSelected ? 'bg-emerald-950/25 border-l-2 border-l-emerald-400' : ''
                        }`}
                      >
                        <td className="p-3 font-semibold text-emerald-500">#{sig.id}</td>
                        <td className="p-3 font-bold text-emerald-200 underline decoration-dotted">{sig.symbol}</td>
                        <td className={`p-3 font-bold ${biasColor}`}>{sig.signal_type}</td>
                        <td className="p-3 text-[10px] tracking-tighter text-emerald-400/80">
                          {sig.trade_bias}
                        </td>
                        <td className="p-3 text-emerald-300 font-mono">${sig.current_price.toFixed(2)}</td>
                        <td className="p-3 font-mono">
                          {sig.entry_trigger ? `$${sig.entry_trigger.toFixed(2)}` : '-'}
                        </td>
                        <td className="p-3 font-mono text-red-400/95">
                          {sig.stop_loss ? `$${sig.stop_loss.toFixed(2)}` : '-'}
                        </td>
                        <td className="p-3 font-mono text-green-400/95">
                          {sig.target_price ? `$${sig.target_price.toFixed(2)}` : '-'}
                        </td>
                        <td className="p-3 font-mono font-bold text-sky-400">{sig.confidence_score}%</td>
                        <td className="p-3 text-center">
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-300 font-semibold">
                            {sig.setup_grade || 'B'}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${statusBadgeClass}`}>
                            {sig.status}
                          </span>
                        </td>
                        <td className="p-3 text-right" onClick={e => e.stopPropagation()}>
                          {sig.status === 'PENDING' ? (
                            <div className="flex justify-end gap-1">
                              <button
                                onClick={() => handleQuickStatus(sig.id, 'EXECUTED')}
                                className="h-6 w-6 flex items-center justify-center rounded bg-emerald-950 hover:bg-emerald-900 border border-emerald-500/30 text-emerald-400 transition-colors"
                                title="Execute Setup"
                              >
                                <Play className="h-3 w-3" />
                              </button>
                              <button
                                onClick={() => handleQuickStatus(sig.id, 'CANCELLED')}
                                className="h-6 w-6 flex items-center justify-center rounded bg-red-950/80 hover:bg-red-900/80 border border-red-500/30 text-red-400 transition-colors"
                                title="Cancel Setup"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-emerald-500/40 italic">LOCKED</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detailed Inspector Panel */}
        <div className="border border-emerald-500/20 rounded bg-zinc-900/20 flex flex-col h-[400px] xl:h-auto overflow-hidden">
          <div className="p-3 bg-zinc-900 border-b border-emerald-500/20 flex justify-between items-center">
            <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5 text-emerald-400" />
              SIGNAL_INSPECTOR v1.0
            </span>
            {selectedSignal && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                {selectedSignal.symbol} #{selectedSignal.id}
              </Badge>
            )}
          </div>

          <div className="p-4 flex-1 overflow-y-auto space-y-4 text-xs">
            {!selectedSignal ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-emerald-500/40">
                <HelpCircle className="h-10 w-10 opacity-30 mb-2" />
                Select a signal from the left process monitor table to inspect its indicators.
              </div>
            ) : (
              <div className="space-y-4 animate-in fade-in duration-300">
                {/* Meta details */}
                <div className="grid grid-cols-2 gap-2 border-b border-emerald-500/10 pb-3">
                  <div>
                    <span className="text-[10px] text-emerald-500/60 block">MARKET DATE</span>
                    <span className="font-semibold text-emerald-300">{selectedSignal.market_date || '-'}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-emerald-500/60 block">CREATED AT</span>
                    <span className="font-semibold text-emerald-300">
                      {new Date(selectedSignal.created_at).toLocaleTimeString('en-US')}
                    </span>
                  </div>
                </div>

                {/* Indicators Block */}
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                    <Activity className="h-3 w-3" /> TECHNICAL_INDICATORS
                  </span>
                  {selectedSignal.indicators ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">VWAP</span>
                        <span>{selectedSignal.indicators.vwap ? `$${Number(selectedSignal.indicators.vwap).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">ATR14</span>
                        <span>{selectedSignal.indicators.atr14 ? `$${Number(selectedSignal.indicators.atr14).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">EMA 9</span>
                        <span>{selectedSignal.indicators.ema9 ? `$${Number(selectedSignal.indicators.ema9).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">EMA 21</span>
                        <span>{selectedSignal.indicators.ema21 ? `$${Number(selectedSignal.indicators.ema21).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">ORH (15m)</span>
                        <span>{selectedSignal.indicators.openingRangeHigh ? `$${Number(selectedSignal.indicators.openingRangeHigh).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">ORL (15m)</span>
                        <span>{selectedSignal.indicators.openingRangeLow ? `$${Number(selectedSignal.indicators.openingRangeLow).toFixed(2)}` : 'N/A'}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No technical data available.</div>
                  )}
                </div>

                {/* GEX Blocks */}
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                    <TrendingUp className="h-3 w-3" /> GAMMA_EXPOSURE_PROFILE
                  </span>
                  {selectedSignal.gex ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">Net GEX</span>
                        <span className={Number(selectedSignal.gex.netGex) >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {selectedSignal.gex.netGex ? `${Number(selectedSignal.gex.netGex).toLocaleString()}` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">GEX Regime</span>
                        <span className="font-semibold text-emerald-300">{selectedSignal.gex.regime || 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">Flip Strike</span>
                        <span>{selectedSignal.gex.flipStrike ? `$${Number(selectedSignal.gex.flipStrike).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">Call Wall</span>
                        <span>{selectedSignal.gex.callWall ? `$${Number(selectedSignal.gex.callWall).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">Put Wall</span>
                        <span>{selectedSignal.gex.putWall ? `$${Number(selectedSignal.gex.putWall).toFixed(2)}` : 'N/A'}</span>
                      </div>
                      <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                        <span className="text-emerald-500/70">Flow Dir.</span>
                        <span className="font-semibold text-sky-400 text-[10px]">{selectedSignal.gex.flowDirection || 'N/A'}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No GEX data available.</div>
                  )}
                </div>

                {/* Volatility Block */}
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                    <Activity className="h-3 w-3" /> VOLATILITY
                  </span>
                  {selectedSignal.volatility ? (
                    <div className="flex gap-4 justify-between bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="text-emerald-500/70">VIX:</span>
                        <span className="font-semibold text-emerald-200">
                          {selectedSignal.volatility.vixQuote ? Number(selectedSignal.volatility.vixQuote).toFixed(2) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-emerald-500/70">VIX Daily Chg:</span>
                        <span className={`font-semibold ${Number(selectedSignal.volatility.vixChangePercent) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                          {selectedSignal.volatility.vixChangePercent ? `${Number(selectedSignal.volatility.vixChangePercent).toFixed(2)}%` : 'N/A'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No VIX data available.</div>
                  )}
                </div>

                {/* Block Reasons / No Trade reasons */}
                {selectedSignal.no_trade_reasons && selectedSignal.no_trade_reasons.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold text-red-400 uppercase flex items-center gap-1">
                      <ShieldAlert className="h-3.5 w-3.5 text-red-500 animate-pulse" /> NO_TRADE_BLOCK_REASONS
                    </span>
                    <ul className="bg-red-950/15 border border-red-500/20 p-3 rounded text-[11px] space-y-1.5">
                      {selectedSignal.no_trade_reasons.map((reason, idx) => (
                        <li key={idx} className="flex gap-2 text-red-300">
                          <span className="text-red-500 font-bold select-none">[!]</span>
                          <span>{reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Terminal Command Line Interface (CLI Panel) */}
      <div className="flex flex-col border border-emerald-500/20 rounded overflow-hidden">
        <div className="p-2 bg-zinc-900 border-b border-emerald-500/20 text-xs text-emerald-300 font-bold flex items-center gap-1.5">
          <TerminalIcon className="h-3.5 w-3.5" />
          INTERACTIVE_SHELL_LOGGER
        </div>

        {/* CLI Logs Display */}
        <div className="h-44 bg-zinc-950 p-3 overflow-y-auto font-mono text-xs leading-relaxed text-emerald-400/90 select-text selection:bg-emerald-800 selection:text-white">
          {cliLogs.map((log, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {log}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* CLI Input Form */}
        <form
          onSubmit={e => {
            e.preventDefault();
            handleCommand(cliInput);
          }}
          className="flex bg-zinc-900/60 border-t border-emerald-500/10"
        >
          <div className="flex items-center px-3 text-emerald-500 font-bold select-none border-r border-emerald-500/10 text-xs">
            options-monitor:~$
          </div>
          <input
            type="text"
            value={cliInput}
            onChange={e => setCliInput(e.target.value)}
            placeholder='Type "help" for a list of available commands...'
            className="flex-1 bg-transparent p-2.5 text-xs text-emerald-300 font-mono focus:outline-none placeholder-emerald-800/60"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="px-4 text-xs font-bold text-emerald-500 hover:text-emerald-300 border-l border-emerald-500/10 hover:bg-emerald-950/20 transition-colors"
          >
            EXECUTE
          </button>
        </form>
      </div>
    </div>
  );
}
