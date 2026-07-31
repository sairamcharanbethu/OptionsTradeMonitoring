import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  X
} from 'lucide-react';
import {
  QUERY_KEYS,
  usePositions,
  useScannerLogs,
  useSettings,
  useSignals,
  useStrategyState,
  useTradeUsage
} from '@/hooks/useDashboardData';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, Position, Signal, SignalRiskAssessment } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';

type LifecycleTone = 'idle' | 'armed' | 'active' | 'manage' | 'complete' | 'blocked';
type ServicesHealth = Awaited<ReturnType<typeof api.getServicesHealth>>;

const money = (value: unknown, decimals = 2) => {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(decimals)}` : '—';
};

const number = (value: unknown, decimals = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : '—';
};

const time = (value?: string | number | null) => {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : '—';
};

const relativeAge = (seconds: unknown) => {
  const age = Number(seconds);
  if (!Number.isFinite(age)) return 'No snapshot';
  if (age < 1) return 'Live';
  if (age < 60) return `${age.toFixed(1)}s ago`;
  return `${Math.round(age / 60)}m ago`;
};

const lifecycleTone = (state: string): LifecycleTone => {
  if (state === 'ACTIVE') return 'active';
  if (state === 'MANAGE' || state === 'EXTENDED') return 'manage';
  if (state === 'ARMED') return 'armed';
  if (state === 'COMPLETED') return 'complete';
  if (['INVALIDATED', 'TRACKING_ABORTED', 'FAILED'].includes(state)) return 'blocked';
  return 'idle';
};

const toneClasses: Record<LifecycleTone, string> = {
  idle: 'border-zinc-800 bg-zinc-900/55 text-zinc-300',
  armed: 'border-amber-500/30 bg-amber-950/15 text-amber-200',
  active: 'border-emerald-500/35 bg-emerald-950/20 text-emerald-100',
  manage: 'border-sky-500/35 bg-sky-950/20 text-sky-100',
  complete: 'border-teal-500/30 bg-teal-950/20 text-teal-100',
  blocked: 'border-rose-500/30 bg-rose-950/15 text-rose-100'
};

const stateCopy = (state: string, side: string | null) => {
  switch (state) {
    case 'ARMED':
      return {
        eyebrow: 'Setup forming',
        title: `${side || 'Directional'} setup armed`,
        description: 'The plan is frozen. Entry remains locked until every confirmation is live.'
      };
    case 'ACTIVE':
      return {
        eyebrow: 'Entry window',
        title: `${side || 'Directional'} entry is active`,
        description: 'Review the planned contract and confirm this order while the snapshot remains fresh.'
      };
    case 'MANAGE':
    case 'EXTENDED':
      return {
        eyebrow: 'Position management',
        title: `${side || 'Directional'} trade is being managed`,
        description: 'The strategy now owns invalidation protection and target progression.'
      };
    case 'COMPLETED':
      return {
        eyebrow: 'Lifecycle complete',
        title: 'Strategy target completed',
        description: 'The setup is closed to new entries and the linked position is exiting or reconciled.'
      };
    case 'INVALIDATED':
    case 'TRACKING_ABORTED':
    case 'FAILED':
      return {
        eyebrow: 'Setup closed',
        title: state === 'INVALIDATED' ? 'Strategy invalidated' : 'Strategy tracking stopped',
        description: 'No new order is allowed. Review the exit and broker reconciliation state.'
      };
    default:
      return {
        eyebrow: 'Market watch',
        title: 'Waiting for a qualified SPY setup',
        description: 'No action is required. The strategy will surface one plan when its gates align.'
      };
  }
};

const optionSide = (signal: Signal | null, strategySignal: Record<string, any> | null) => {
  if (signal?.signal_type === 'CALL' || signal?.signal_type === 'PUT') return signal.signal_type;
  if (strategySignal?.favoring === 'calls') return 'CALL';
  if (strategySignal?.favoring === 'puts') return 'PUT';
  return null;
};

const getExecutionMode = (settings: Record<string, string>) => {
  if (settings.shadow_trading_enabled === 'true') {
    return { label: 'Shadow simulation', live: false };
  }
  if (settings.execution_broker === 'wealthsimple_snaptrade' && settings.snaptrade_auto_trade === 'true') {
    return { label: 'Wealthsimple live', live: true };
  }
  return { label: 'Simulation · live off', live: false };
};

const Metric = ({
  label,
  value,
  detail,
  tone = 'text-zinc-100'
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) => (
  <div className="min-w-0 py-2">
    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</div>
    <div className={`mt-1 truncate font-mono text-sm font-semibold tabular-nums ${tone}`} title={value}>{value}</div>
    {detail && <div className="mt-0.5 truncate text-[10px] text-zinc-500" title={detail}>{detail}</div>}
  </div>
);

const Level = ({
  label,
  value,
  tone = 'text-zinc-100'
}: {
  label: string;
  value: unknown;
  tone?: string;
}) => (
  <div className="min-w-0 border-l border-zinc-800 pl-3 first:border-l-0 first:pl-0">
    <div className="text-[10px] font-medium text-zinc-500">{label}</div>
    <div className={`mt-1 font-mono text-base font-semibold tabular-nums ${tone}`}>{money(value)}</div>
  </div>
);

const PositionSummary = ({ position }: { position: Position }) => {
  const entry = Number(position.entry_price || 0);
  const current = Number(position.current_price || entry);
  const openPnl = (current - entry) * Number(position.quantity || 0) * 100;
  return (
    <section className="rounded-xl border border-sky-500/25 bg-sky-950/10 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-300">Linked position</div>
          <div className="mt-1 text-base font-semibold text-zinc-100">
            {position.symbol} {position.option_type} {money(position.strike_price)}
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            {position.quantity} contract{Number(position.quantity) === 1 ? '' : 's'} · {position.execution_status || position.status}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className={`font-mono text-xl font-semibold tabular-nums ${openPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {openPnl >= 0 ? '+' : ''}{money(openPnl)}
          </div>
          <div className="text-[10px] text-zinc-500">estimated open P&amp;L</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 border-t border-sky-500/15 pt-3 sm:grid-cols-4">
        <Metric label="Entry premium" value={money(position.entry_price)} />
        <Metric label="Current premium" value={money(position.current_price)} />
        <Metric label="Protected stop" value={money(position.suggested_stop_loss)} />
        <Metric label="Exit target" value={money(position.suggested_take_profit_1)} />
      </div>
      {position.execution_error && (
        <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
          {position.execution_error}
        </div>
      )}
    </section>
  );
};

export default function DayTradingTerminal() {
  const queryClient = useQueryClient();
  const { isConnected, lastMessage } = useWebSocket();
  const { data: signals = [], isLoading: signalsLoading, refetch: refetchSignals } = useSignals(5000);
  const { data: strategyState, refetch: refetchStrategy } = useStrategyState(isConnected ? 10000 : 1000);
  const { data: settings = {} } = useSettings();
  const { data: tradeUsage } = useTradeUsage();
  const { data: positions = [] } = usePositions(5000);
  const { data: logs = [] } = useScannerLogs(15000);
  const [services, setServices] = useState<ServicesHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [executeSignal, setExecuteSignal] = useState<Signal | null>(null);
  const [executing, setExecuting] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [riskAssessment, setRiskAssessment] = useState<SignalRiskAssessment | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);
  const riskRequestRef = useRef(0);

  const strategySignal = strategyState?.signal || null;
  const strategySetupId = strategyState?.setupId || null;
  const currentSignal = useMemo(() => {
    const strategyMatches = signals
      .filter(signal => signal.symbol === 'SPY' && signal.engine_version === 'signal-only-v2')
      .sort((a, b) => {
        const aCurrent = strategySetupId && a.strategy_setup_id === strategySetupId ? 1 : 0;
        const bCurrent = strategySetupId && b.strategy_setup_id === strategySetupId ? 1 : 0;
        if (aCurrent !== bCurrent) return bCurrent - aCurrent;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    return strategyMatches[0] || null;
  }, [signals, strategySetupId]);

  const lifecycle = String(
    currentSignal?.lifecycle_status
      || strategySignal?.state
      || strategySignal?.signal_phase
      || 'WAIT'
  ).toUpperCase();
  const side = optionSide(currentSignal, strategySignal);
  const setup = side === 'PUT'
    ? strategySignal?.put_setup
    : side === 'CALL'
      ? strategySignal?.call_setup
      : null;
  const option = currentSignal?.option_details || setup?.option || {};
  const quoteAge = setup?.option?.quote_age_seconds == null ? Number.NaN : Number(setup.option.quote_age_seconds);
  const lifecycleData = strategySignal?.lifecycle || currentSignal?.strategy_snapshot?.lifecycle || {};
  const targets = Array.isArray(option.targets)
    ? option.targets
    : Array.isArray(setup?.targets)
      ? setup.targets
      : [currentSignal?.target_price].filter(value => value != null);
  const confirmations = Array.isArray(strategySignal?.confirmations)
    ? strategySignal.confirmations
    : Array.isArray(currentSignal?.strategy_snapshot?.confirmations)
      ? currentSignal?.strategy_snapshot?.confirmations
      : [];
  const strategyBlockers = Array.from(new Set([
    ...(strategySignal?.blockers || []),
    ...(currentSignal?.no_trade_reasons || [])
  ].filter(Boolean))) as string[];
  const executionMode = getExecutionMode(settings);
  const dayTradingEnabled = settings.day_trading_enabled !== 'false';
  const configuredMaxContracts = Math.max(1, Number(settings.contracts_per_trade || 1));
  const plannedContracts = Math.max(0, Number(option.planned_contracts || 0));
  const orderQuantity = plannedContracts > 0
    ? Math.min(configuredMaxContracts, plannedContracts)
    : configuredMaxContracts;
  const plannedLimit = Number(option.planned_limit_price || option.mark || 0);
  const orderDebit = plannedLimit > 0 && plannedContracts > 0 ? plannedLimit * orderQuantity * 100 : 0;
  const strategyDebitLimit = Number(option.strategy_max_total_debit_dollars || settings.strategy_max_total_debit_dollars || 0);
  const snapshotAge = Number(strategyState?.ageSeconds);
  const freshSnapshot = Number.isFinite(snapshotAge) && snapshotAge >= 0 && snapshotAge <= 20;
  const usageRemaining = Number(tradeUsage?.remaining ?? 0);
  const entryAllowed = currentSignal?.entry_allowed === true
    && currentSignal.lifecycle_status === 'ACTIVE'
    && lifecycleData.entry_allowed !== false;
  const liveMissing = executionMode.live
    ? [
        settings.snaptrade_trading_account_id ? null : 'Select a Wealthsimple account',
        settings.live_trading_acknowledged === 'true' ? null : 'Acknowledge live trading'
      ].filter(Boolean) as string[]
    : [];
  const executionBlockers = [
    !dayTradingEnabled ? 'Day trading is disabled' : null,
    currentSignal && currentSignal.status !== 'PENDING' ? `Signal is ${currentSignal.status.toLowerCase()}` : null,
    lifecycle !== 'ACTIVE' ? `Lifecycle is ${lifecycle}` : null,
    !entryAllowed ? 'Entry window is not open' : null,
    !freshSnapshot ? 'Strategy snapshot is stale' : null,
    !Number.isFinite(quoteAge) || quoteAge > 15 ? 'Selected option quote is stale or missing' : null,
    usageRemaining <= 0 ? 'Daily trade limit reached' : null,
    plannedContracts <= 0 ? 'Strategy has no executable contract quantity' : null,
    ...liveMissing,
    currentSignal?.execution_error || null
  ].filter(Boolean) as string[];
  const canExecute = Boolean(currentSignal && executionBlockers.length === 0);
  const linkedPosition = useMemo(() => positions.find(position => {
    const strategyPosition = position as Position & { signal_id?: number; strategy_setup_id?: string };
    return strategyPosition.status !== 'CLOSED' && (
      strategyPosition.signal_id === currentSignal?.id
      || (strategySetupId && strategyPosition.strategy_setup_id === strategySetupId)
    );
  }) || null, [positions, currentSignal?.id, strategySetupId]);
  const lifecycleView = stateCopy(lifecycle, side);
  const currentTone = lifecycleTone(lifecycle);
  const primaryGex = strategySignal?.gex || strategySignal?.zerogex_decision || currentSignal?.gex || {};
  const gexAge = primaryGex.provider_age_seconds == null ? Number.NaN : Number(primaryGex.provider_age_seconds);
  const staleReviewReason = !freshSnapshot
    ? 'Strategy snapshot is stale'
    : Number.isFinite(gexAge) && gexAge > 20
      ? 'GEX snapshot is stale'
      : null;
  const reviewDataFresh = !staleReviewReason;
  const recentSignals = signals
    .filter(signal => signal.symbol === 'SPY' && signal.engine_version === 'signal-only-v2')
    .slice(0, 8);
  const recentLogs = logs.filter(log => log.symbol === 'SPY').slice(0, 6);

  const fetchHealth = async () => {
    try {
      setHealthError(null);
      setServices(await api.getServicesHealth());
    } catch (error: any) {
      setHealthError(error.message || 'Unable to load runtime health');
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([
      refetchSignals(),
      refetchStrategy(),
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions }),
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage }),
      fetchHealth()
    ]);
    setRefreshing(false);
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  useEffect(() => {
    riskRequestRef.current += 1;
    setRiskAssessment(null);
    setRiskError(null);
    setRiskLoading(false);
  }, [currentSignal?.id, currentSignal?.lifecycle_status]);

  const runAdHocRiskReview = async () => {
    if (!currentSignal?.id || settings.day_trading_ai_enabled === 'false' || !reviewDataFresh) return;
    const requestId = ++riskRequestRef.current;
    const signalId = currentSignal.id;
    setRiskLoading(true);
    setRiskError(null);
    try {
      const assessment = await api.getSignalRiskAssessment(signalId);
      if (requestId !== riskRequestRef.current) return;
      setRiskAssessment(assessment);
    } catch (error: any) {
      if (requestId !== riskRequestRef.current) return;
      setRiskError(error.message || 'Fresh AI setup review failed');
    } finally {
      if (requestId === riskRequestRef.current) setRiskLoading(false);
    }
  };

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'STRATEGY_SNAPSHOT_UPDATED' && lastMessage.data) {
      queryClient.setQueryData(QUERY_KEYS.strategyState, lastMessage.data);
    }
    if (lastMessage.type === 'STRATEGY_STATE_CHANGED') {
      if (lastMessage.data) queryClient.setQueryData(QUERY_KEYS.strategyState, lastMessage.data);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    }
    if (['NEW_SIGNAL', 'SIGNAL_UPDATED'].includes(lastMessage.type)) {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    }
    if (['POSITION_UPDATED', 'TRADE_UPDATED'].includes(lastMessage.type)) {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
    }
  }, [lastMessage, queryClient]);

  const requestExecution = () => {
    setActionMessage(null);
    if (!currentSignal || !canExecute) {
      setActionMessage({
        tone: 'error',
        text: executionBlockers[0] || 'This setup is not executable.'
      });
      return;
    }
    setExecuteSignal(currentSignal);
  };

  const confirmExecution = async () => {
    if (!executeSignal) return;
    setExecuting(true);
    setActionMessage(null);
    try {
      const result = await api.updateSignalStatus(executeSignal.id, 'EXECUTED');
      setActionMessage({
        tone: 'success',
        text: result.execution_status
          ? `Order accepted: ${result.execution_status}`
          : 'Execution request accepted.'
      });
      setExecuteSignal(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage })
      ]);
    } catch (error: any) {
      setActionMessage({ tone: 'error', text: error.message || 'Execution request failed.' });
      setExecuteSignal(null);
    } finally {
      setExecuting(false);
    }
  };

  const cancelSetup = async () => {
    if (!currentSignal) return;
    setActionMessage(null);
    try {
      await api.updateSignalStatus(currentSignal.id, 'CANCELLED');
      setActionMessage({ tone: 'success', text: 'Setup dismissed for this account.' });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    } catch (error: any) {
      setActionMessage({ tone: 'error', text: error.message || 'Could not dismiss this setup.' });
    }
  };

  const strategyHealth = services?.strategyEngine;
  const ibkrHealth = services?.marketData?.ibkr || services?.streams?.ibkr;
  const systemReady = strategyHealth?.status === 'UP' && ibkrHealth?.connected === true;

  return (
    <main className="mx-auto w-full max-w-[1440px] space-y-4 text-zinc-100">
      <section className="overflow-hidden rounded-2xl border border-zinc-800/90 bg-[#0d0f12] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        <header className="flex flex-col gap-4 border-b border-zinc-800 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Day trading</span>
              <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300">SPY · signal-only-v2</Badge>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-zinc-50 sm:text-3xl">One signal. One decision.</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-500">
              Follow the strategy lifecycle from setup formation through guarded execution and position management.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/system-health"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
            >
              {systemReady ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" /> : <CircleAlert className="h-3.5 w-3.5 text-amber-400" />}
              System health
              <ArrowUpRight className="h-3 w-3" />
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshAll}
              disabled={refreshing}
              className="h-9 border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
            >
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-2 gap-x-4 border-b border-zinc-800 px-4 sm:grid-cols-3 sm:px-6 lg:grid-cols-6">
          <Metric
            label="Strategy"
            value={strategyHealth?.status || (freshSnapshot ? 'LIVE' : 'STARTING')}
            detail={relativeAge(strategyState?.ageSeconds)}
            tone={freshSnapshot ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="IBKR"
            value={ibkrHealth?.connected ? 'Connected' : 'Unavailable'}
            detail={ibkrHealth?.mode ? `${ibkrHealth.mode} · ${ibkrHealth.port || '—'}` : 'market data'}
            tone={ibkrHealth?.connected ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="Execution"
            value={executionMode.label}
            detail={executionMode.live ? 'real orders enabled' : 'no live orders'}
            tone={executionMode.live ? 'text-amber-300' : 'text-sky-300'}
          />
          <Metric
            label="Daily capacity"
            value={`${tradeUsage?.used ?? 0} / ${tradeUsage?.max ?? settings.max_trades_per_day ?? 2}`}
            detail={`${tradeUsage?.remaining ?? 0} remaining`}
            tone={usageRemaining > 0 ? 'text-zinc-100' : 'text-rose-300'}
          />
          <Metric
            label="App updates"
            value={isConnected ? 'Live' : 'Polling'}
            detail={isConnected ? 'socket connected' : 'refresh fallback'}
            tone={isConnected ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="Market"
            value={services?.scanner?.status === 'MARKET_CLOSED' ? 'Closed' : 'Monitoring'}
            detail={time(services?.generatedAt)}
          />
        </div>

        <section className={`m-3 rounded-xl border p-4 sm:m-5 sm:p-6 ${toneClasses[currentTone]}`}>
          <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] opacity-70">{lifecycleView.eyebrow}</span>
                <span className="rounded-md border border-current/20 bg-black/15 px-2 py-1 font-mono text-[10px] font-semibold">{lifecycle}</span>
                {side && (
                  <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${
                    side === 'CALL'
                      ? 'border-emerald-500/25 bg-emerald-950/30 text-emerald-200'
                      : 'border-rose-500/25 bg-rose-950/30 text-rose-200'
                  }`}>
                    {side}
                  </span>
                )}
              </div>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.025em] text-zinc-50 sm:text-3xl">{lifecycleView.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">{lifecycleView.description}</p>

              <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Level label="SPY spot" value={strategySignal?.spot || currentSignal?.current_price} />
                <Level label="Entry trigger" value={setup?.trigger || currentSignal?.entry_trigger} tone="text-emerald-200" />
                <Level label="Invalidation" value={setup?.invalidation || currentSignal?.stop_loss} tone="text-rose-200" />
                <Level label={`Target ${option.exit_target_number || 2}`} value={currentSignal?.target_price || targets[1] || targets[0]} tone="text-sky-200" />
              </div>

              {strategyBlockers.length > 0 && lifecycle !== 'ACTIVE' && (
                <div className="mt-5 rounded-lg border border-amber-500/20 bg-black/15 px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">What is blocking entry</div>
                  <div className="mt-2 space-y-1.5">
                    {strategyBlockers.slice(0, 4).map(blocker => (
                      <div key={blocker} className="flex items-start gap-2 text-xs leading-relaxed text-zinc-300">
                        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span>{blocker}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <aside className="rounded-xl border border-zinc-800/90 bg-black/20 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Next action</div>
              {lifecycle === 'ACTIVE' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Review the planned order</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Confirmation remains manual. The backend rechecks lifecycle, freshness, quote quality and debit limits.
                  </p>
                  <Button
                    className="mt-5 h-11 w-full bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500"
                    onClick={requestExecution}
                    disabled={!canExecute}
                  >
                    <Play className="mr-2 h-4 w-4" />
                    Review order
                  </Button>
                  {!canExecute && (
                    <div className="mt-3 text-xs leading-relaxed text-amber-300">{executionBlockers[0]}</div>
                  )}
                  {currentSignal && (
                    <button
                      type="button"
                      onClick={cancelSetup}
                      className="mt-3 w-full text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      Dismiss this setup
                    </button>
                  )}
                </>
              ) : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Let the lifecycle manage</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Monitor the protected invalidation and target progression. No second entry is allowed.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-950/20 px-3 py-2 text-xs text-sky-200">
                    <Activity className="h-4 w-4" />
                    Exit monitor active
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">No order to review</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Stay flat until the lifecycle opens a fresh ACTIVE entry window.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    <Clock3 className="h-4 w-4" />
                    Waiting automatically
                  </div>
                </>
              )}
            </aside>
          </div>
        </section>
      </section>

      {actionMessage && (
        <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
          actionMessage.tone === 'success'
            ? 'border-emerald-500/25 bg-emerald-950/15 text-emerald-200'
            : 'border-rose-500/25 bg-rose-950/15 text-rose-200'
        }`}>
          {actionMessage.tone === 'success'
            ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
            : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{actionMessage.text}</span>
        </div>
      )}

      {linkedPosition && <PositionSummary position={linkedPosition} />}

      <section className="rounded-xl border border-zinc-800 bg-[#101216] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Hard risk limits</div>
          <div className="grid flex-1 grid-cols-2 gap-x-5 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Premium at risk" value={orderDebit > 0 ? money(orderDebit) : '—'} tone="text-amber-200" />
            <Metric label="Debit ceiling" value={strategyDebitLimit > 0 ? money(strategyDebitLimit) : '—'} />
            <Metric label="Quantity" value={`${orderQuantity}`} detail={`strategy planned ${plannedContracts || '—'}`} />
            <Metric label="Invalidation" value={money(setup?.invalidation || currentSignal?.stop_loss)} tone="text-rose-200" />
            <Metric label="Strategy age" value={relativeAge(snapshotAge)} tone={freshSnapshot ? 'text-emerald-300' : 'text-rose-300'} />
            <Metric label="GEX age" value={Number.isFinite(gexAge) ? `${number(gexAge, 1)}s` : '—'} tone={Number.isFinite(gexAge) && gexAge > 20 ? 'text-rose-300' : 'text-zinc-100'} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Optional AI review
            </div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">Explain this setup in plain language</h3>
            <p className="mt-1 text-xs text-zinc-500">Runs only when requested. Hard strategy limits remain authoritative.</p>
          </div>
          <div className="flex items-center gap-2">
            {riskAssessment && (
              <Badge variant="outline" className={`font-mono text-[10px] ${
                riskAssessment.verdict === 'ALIGNED'
                  ? 'border-emerald-500/30 bg-emerald-950/25 text-emerald-300'
                  : riskAssessment.verdict === 'CONFLICTED'
                    ? 'border-rose-500/30 bg-rose-950/25 text-rose-300'
                    : 'border-amber-500/30 bg-amber-950/25 text-amber-300'
              }`}>
                {riskAssessment.verdict.replace('_', ' ')}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-sky-500/25 bg-sky-950/15 text-[10px] text-sky-200 hover:bg-sky-950/30"
              onClick={runAdHocRiskReview}
              disabled={!currentSignal || riskLoading || settings.day_trading_ai_enabled === 'false' || !reviewDataFresh}
              title={staleReviewReason || 'Review the current setup using all available strategy and GEX evidence'}
            >
              {riskLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Review setup with AI
            </Button>
          </div>
        </div>

        {(!Number.isFinite(quoteAge) || quoteAge > 15) && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-3 text-xs text-amber-200">
            Option quote is stale or missing. AI can explain the directional setup, but its verdict remains WAIT and execution stays blocked.
          </div>
        )}

        {settings.day_trading_ai_enabled === 'false' ? (
          <div className="mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            AI risk management is disabled in Day Trading settings.
          </div>
        ) : staleReviewReason ? (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-3 text-xs text-amber-200">
            AI review is paused: {staleReviewReason}. Wait for fresh strategy data.
          </div>
        ) : riskLoading ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reviewing this setup and its protected risk plan…
          </div>
        ) : riskAssessment ? (
          <>
            <p className="mt-4 text-sm font-medium leading-relaxed text-zinc-200">{riskAssessment.summary}</p>
            <div className="mt-4 divide-y divide-zinc-800 rounded-lg bg-zinc-950/55 px-3">
              {[
                ['Setup', riskAssessment.likelyPath, 'text-sky-300'],
                ['GEX', riskAssessment.gexRead, 'text-sky-300'],
                ['If it works', riskAssessment.ifRight, 'text-emerald-300'],
                ['Failure', riskAssessment.ifWrong, 'text-rose-300']
              ].map(([label, statement, tone]) => (
                <div key={label} className="grid gap-1 py-2.5 sm:grid-cols-[5rem_1fr] sm:gap-3">
                  <div className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${tone}`}>{label}</div>
                  <div className="text-xs leading-relaxed text-zinc-300">{statement}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-sky-500/15 bg-sky-950/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs leading-relaxed text-zinc-300"><span className="font-semibold text-sky-200">Safest action:</span> {riskAssessment.action}</div>
              <div className="shrink-0 font-mono text-xs text-zinc-400">
                Max planned debit {riskAssessment.maxPlannedLoss != null ? money(riskAssessment.maxPlannedLoss) : '—'}
              </div>
            </div>
            <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/35">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
                Evidence and risk flags
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="grid gap-3 border-t border-zinc-800 p-3 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-300">Supporting data</div>
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {riskAssessment.supportingFactors.length > 0
                      ? riskAssessment.supportingFactors.map((item, index) => <div key={`${item}-${index}`}>• {item}</div>)
                      : <div>No additional supporting evidence identified.</div>}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-300">Risk flags</div>
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {riskAssessment.riskFlags.length > 0
                      ? riskAssessment.riskFlags.map((item, index) => <div key={`${item}-${index}`}>• {item}</div>)
                      : <div>No additional risk flags identified.</div>}
                  </div>
                </div>
              </div>
            </details>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] leading-relaxed text-zinc-600">
              <span>Reviewed {time(riskAssessment.generatedAt)}</span>
              <span>Strategy {relativeAge(snapshotAge)}</span>
              <span>GEX {Number.isFinite(gexAge) ? `${number(gexAge, 1)}s old` : 'age unavailable'}</span>
              <span>AI is advisory only.</span>
            </div>
          </>
        ) : (
          <div className={`mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-xs ${riskError ? 'border-rose-500/25 text-rose-200' : 'border-zinc-800 text-zinc-500'}`}>
            {riskError || (currentSignal ? 'No AI review has been requested for this setup.' : 'A persisted strategy setup is required for AI review.')}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <article className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Planned contract</div>
              <h3 className="mt-1 break-all text-base font-semibold text-zinc-100">
                {option.ticker || option.local_symbol || (side ? `SPY ${side}` : 'No contract selected')}
              </h3>
            </div>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-950 font-mono text-[10px] text-zinc-300">
              {option.expiry || currentSignal?.option_expiration_date || '—'}
            </Badge>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-5 border-y border-zinc-800 py-2 sm:grid-cols-4">
            <Metric label="Strike" value={money(option.strike)} />
            <Metric label="Bid / ask" value={`${money(option.bid)} / ${money(option.ask)}`} />
            <Metric label="Planned limit" value={money(plannedLimit)} />
            <Metric label="Spread" value={option.spreadPct != null ? `${number(option.spreadPct)}%` : '—'} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-zinc-950/70 p-3">
              <div className="text-[10px] text-zinc-500">Strategy quantity</div>
              <div className="mt-1 font-mono text-lg font-semibold text-zinc-100">{plannedContracts || '—'}</div>
            </div>
            <div className="rounded-lg bg-zinc-950/70 p-3">
              <div className="text-[10px] text-zinc-500">Your maximum</div>
              <div className="mt-1 font-mono text-lg font-semibold text-zinc-100">{configuredMaxContracts}</div>
            </div>
            <div className="rounded-lg bg-zinc-950/70 p-3">
              <div className="text-[10px] text-zinc-500">Order debit</div>
              <div className="mt-1 font-mono text-lg font-semibold text-zinc-100">{orderDebit > 0 ? money(orderDebit) : '—'}</div>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Final quantity is the lower of the strategy plan and your maximum. Live execution cannot exceed the strategy limit or debit ceiling.
          </p>
        </article>

        <article className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Why this setup</div>
          <h3 className="mt-1 text-base font-semibold text-zinc-100">Confirmations and GEX context</h3>
          <div className="mt-4 space-y-2">
            {confirmations.length > 0 ? confirmations.slice(0, 5).map((confirmation: any, index: number) => {
              const label = typeof confirmation === 'string'
                ? confirmation
                : confirmation.label || confirmation.name || confirmation.reason || JSON.stringify(confirmation);
              return (
                <div key={`${label}-${index}`} className="flex items-start gap-2 rounded-lg bg-zinc-950/55 px-3 py-2 text-xs text-zinc-300">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="leading-relaxed">{label}</span>
                </div>
              );
            }) : (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center text-xs text-zinc-500">
                Confirmations will appear when a setup is armed.
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-3">
            <Metric label="GEX regime" value={String(primaryGex.regime || primaryGex.gamma_regime || '—')} />
            <Metric label="Gamma flip" value={money(primaryGex.flip || primaryGex.gamma_flip)} />
            <Metric label="Provider age" value={primaryGex.provider_age_seconds != null ? `${number(primaryGex.provider_age_seconds, 1)}s` : '—'} />
          </div>
        </article>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-[#101216]">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 sm:px-5">
            <div>
              <div className="text-sm font-semibold text-zinc-100">History and diagnostics</div>
              <div className="mt-0.5 text-xs text-zinc-500">Previous signals, scanner evidence and runtime details</div>
            </div>
            <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid gap-4 border-t border-zinc-800 p-4 sm:p-5 xl:grid-cols-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">Recent lifecycle events</div>
              <div className="mt-3 space-y-2">
                {recentSignals.length > 0 ? recentSignals.map(signal => (
                  <div key={signal.id} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-950/60 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-zinc-200">#{signal.id} · {signal.signal_type}</div>
                      <div className="mt-0.5 text-[10px] text-zinc-500">{time(signal.created_at)} · {signal.lifecycle_status || signal.status}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-400">{signal.confidence_score}%</span>
                  </div>
                )) : <div className="text-xs text-zinc-500">No strategy events yet.</div>}
              </div>
            </div>

            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">Latest scanner evidence</div>
              <div className="mt-3 space-y-2">
                {recentLogs.length > 0 ? recentLogs.map(log => (
                  <div key={log.id} className="rounded-lg bg-zinc-950/60 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-zinc-200">{log.outcome}</span>
                      <span className="font-mono text-[10px] text-zinc-500">{time(log.created_at)}</span>
                    </div>
                    <div className="mt-1 truncate text-[10px] text-zinc-500">
                      {log.no_trade_reasons?.[0] || `${log.regime} · SPY ${money(log.spot_price)}`}
                    </div>
                  </div>
                )) : <div className="text-xs text-zinc-500">No scanner evidence available.</div>}
              </div>
            </div>

            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">Runtime</div>
              <div className="mt-3 space-y-2 text-xs">
                {[
                  ['Strategy', strategyHealth?.status || 'N/A'],
                  ['IBKR market data', ibkrHealth?.status || 'N/A'],
                  ['IBKR stream', services?.streams?.ibkr?.status || 'N/A'],
                  ['Exit monitor', services?.liveExitMonitor?.status || 'N/A'],
                  ['Redis', services?.tradeRedis?.status || 'N/A'],
                  ['Postgres', services?.postgres?.status || 'N/A']
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 border-b border-zinc-800/70 py-2 last:border-0">
                    <span className="text-zinc-500">{label}</span>
                    <span className="font-mono text-zinc-200">{value}</span>
                  </div>
                ))}
              </div>
              {healthError && <div className="mt-3 text-xs text-rose-300">{healthError}</div>}
            </div>
          </div>
        </details>
      </section>

      {signalsLoading && !currentSignal && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading strategy state
        </div>
      )}

      <Dialog open={!!executeSignal} onOpenChange={open => !open && !executing && setExecuteSignal(null)}>
        <DialogContent className="max-w-lg border-zinc-800 bg-[#101216] text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Confirm {executionMode.live ? 'live' : 'simulated'} order</DialogTitle>
            <DialogDescription className="text-zinc-500">
              This is the final manual approval. Market data, lifecycle and risk limits are checked again before submission.
            </DialogDescription>
          </DialogHeader>

          {executeSignal && (
            <div className="space-y-3">
              {executionMode.live && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-200">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  This sends a real order to the selected Wealthsimple account.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Contract</div>
                  <div className="mt-1 break-all font-mono text-xs font-semibold text-zinc-100">{option.ticker || option.local_symbol || `SPY ${side}`}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Quantity</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{orderQuantity}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Protected limit ceiling</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{money(plannedLimit)}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Order debit</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{money(orderDebit)}</div>
                </div>
                <div className="col-span-2 rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Strategy protection</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">
                    stop {money(setup?.invalidation || executeSignal.stop_loss)} · target {money(executeSignal.target_price || targets[1] || targets[0])}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Limit order only · quantity and debit remain server-enforced
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setExecuteSignal(null)}
              disabled={executing}
              className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            >
              Back
            </Button>
            <Button
              onClick={confirmExecution}
              disabled={executing}
              className={executionMode.live
                ? 'bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400'
                : 'bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400'}
            >
              {executing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {executionMode.live ? 'Send live order' : 'Create simulation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
