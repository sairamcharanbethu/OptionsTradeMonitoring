import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  QUERY_KEYS,
  useKillSwitch,
  usePositions,
  usePaperAccount,
  useSettings,
  useSignals,
  useStrategyHistory,
  useStrategyState,
  useTradeUsage
} from '@/hooks/useDashboardData';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, type PaperAccountSummary, type Position, type Signal, type SignalRiskAssessment } from '@/lib/api';
import { PaperActivityTab, ServicesHealth, MAX_GEX_PROVIDER_AGE_SECONDS, BROWSER_SETUP_ALERTS_KEY, paperRecordLinksToPosition, paperOrderNeedsAttention, paperEventCategory, money, number, etMinute, dateTime, compactAge, gexAgeSeconds, marketDataReadinessCopy, optionSpreadPct, lifecycleTone, stateCopy, optionSide, strategyDisplay, getExecutionMode } from '@/components/daytrading/terminalModel';
import { Check } from 'lucide-react';

/**
 * All state, derived values and handlers of the Day Trading terminal, moved
 * verbatim out of the page so the page is a layout and each section is a
 * component. Components take `Pick<DayTradingTerminalModel, ...>` props.
 */
export function useDayTradingTerminal() {
    const queryClient = useQueryClient();
    const { isConnected, lastMessage } = useWebSocket();
    const { data: signals = [], isLoading: signalsLoading, refetch: refetchSignals } = useSignals(5000);
    const {
      data: strategyState,
      dataUpdatedAt: strategyStateUpdatedAt,
      refetch: refetchStrategy
    } = useStrategyState(isConnected ? 10000 : 1000);
    const { data: settings = {} } = useSettings();
    const { data: tradeUsage } = useTradeUsage();
    const { data: killSwitch, isError: killSwitchUnavailable, refetch: refetchKillSwitch } = useKillSwitch(5000);
    const { data: positions = [] } = usePositions(5000);
    const { data: paperAccount, refetch: refetchPaperAccount } = usePaperAccount(5000);
    const { data: strategyHistory = [], isLoading: historyLoading, error: historyError, refetch: refetchHistory } = useStrategyHistory(15000);
    const [services, setServices] = useState<ServicesHealth | null>(null);
    const [healthError, setHealthError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [executeSignal, setExecuteSignal] = useState<Signal | null>(null);
    const [dismissSignal, setDismissSignal] = useState<Signal | null>(null);
    const [executing, setExecuting] = useState(false);
    const [dismissing, setDismissing] = useState(false);
    const [reconcilingBroker, setReconcilingBroker] = useState(false);
    const [clockNow, setClockNow] = useState(() => Date.now());
    const [browserAlertsEnabled, setBrowserAlertsEnabled] = useState(() => (
      typeof window !== 'undefined'
      && typeof Notification !== 'undefined'
      && Notification.permission === 'granted'
      && window.localStorage.getItem(BROWSER_SETUP_ALERTS_KEY) === 'true'
    ));
    const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
    const [riskAssessment, setRiskAssessment] = useState<SignalRiskAssessment | null>(null);
    const [riskLoading, setRiskLoading] = useState(false);
    const [paperUpdating, setPaperUpdating] = useState(false);
    const [paperClosePosition, setPaperClosePosition] = useState<PaperAccountSummary['openPositions'][number] | null>(null);
    // Decision log ↔ positions strip cross-highlight.
    const [highlightedPositionId, setHighlightedPositionId] = useState<number | null>(null);
    const [paperClosing, setPaperClosing] = useState(false);
    const [paperForceCloseAvailable, setPaperForceCloseAvailable] = useState(false);
    const [riskError, setRiskError] = useState<string | null>(null);
    const [paperExpanded, setPaperExpanded] = useState(false);
    const [paperActivityTab, setPaperActivityTab] = useState<PaperActivityTab>('trades');
    const [paperActivityFilter, setPaperActivityFilter] = useState('ALL');
    const [paperActivitySearch, setPaperActivitySearch] = useState('');
    const [aiReviewExpanded, setAiReviewExpanded] = useState(false);
    const [historyExpanded, setHistoryExpanded] = useState(false);
    const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
    const riskRequestRef = useRef(0);
    const lastAlertStateRef = useRef<string | null>(null);

    useEffect(() => {
      const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }, []);

    const strategySignal = strategyState?.signal || null;
    const strategyLanes = strategyState?.strategySignals || [];
    const strategySetupId = strategyState?.setupId || null;
    const currentSignal = useMemo(() => {
      if (!strategySetupId) return null;
      return signals.find(signal => (
        signal.symbol === 'SPY'
        && signal.engine_version === 'signal-only-v2'
        && signal.strategy_setup_id === strategySetupId
      )) || null;
    }, [signals, strategySetupId]);
    const currentExecution = currentSignal?.execution || (
      currentSignal?.execution_status
      || currentSignal?.execution_broker
      || currentSignal?.broker_order_id
      || currentSignal?.broker_trade_id
      || currentSignal?.execution_error
        ? {
            status: currentSignal.status === 'EXECUTED' || currentSignal.status === 'CANCELLED' ? currentSignal.status : null,
            broker: currentSignal.execution_broker || null,
            order_id: currentSignal.broker_order_id || null,
            trade_id: currentSignal.broker_trade_id || null,
            status_detail: currentSignal.execution_status || null,
            error: currentSignal.execution_error || null,
            contracts_requested: currentSignal.contracts_requested ?? null
          }
        : null
    );

    const lifecycle = String(
      strategySignal?.state
        || strategySignal?.signal_phase
        || 'WAIT'
    ).toUpperCase();
    const side = optionSide(strategySignal);
    const directionConfirmed = [
      'ARMED', 'ACTIVE', 'MANAGE', 'EXTENDED', 'COMPLETED', 'INVALIDATED', 'TRACKING_ABORTED', 'FAILED'
    ].includes(lifecycle);
    const setup = side === 'PUT'
      ? strategySignal?.put_setup
      : side === 'CALL'
        ? strategySignal?.call_setup
        : null;
    const option = setup?.option || {};
    const baseQuoteAge = setup?.option?.quote_age_seconds == null ? Number.NaN : Number(setup.option.quote_age_seconds);
    const lifecycleData = strategySignal?.lifecycle || {};
    const targets = Array.isArray(setup?.targets) ? setup.targets : [];
    const confirmations = Array.isArray(strategySignal?.confirmations)
      ? strategySignal.confirmations
      : [];
    const strategyBlockers = Array.from(new Set((strategySignal?.blockers || []).filter(Boolean))) as string[];
    const executionMode = getExecutionMode(settings);
    const liveKillSwitch = killSwitch?.live;
    const liveHalted = liveKillSwitch?.halted === true;
    const liveDisarmed = liveKillSwitch?.disarmed === true;
    const [armToggling, setArmToggling] = useState(false);
    const [confirmRearm, setConfirmRearm] = useState(false);
    const handleDisarmLive = async () => {
      setConfirmRearm(false);
      setArmToggling(true);
      try {
        await api.disarmLiveTrading();
        await refetchKillSwitch();
      } catch {
        // The next 5s poll shows the true state either way.
      } finally {
        setArmToggling(false);
      }
    };
    const handleArmLive = async () => {
      // Disarm is one click; re-arm takes two. The asymmetry is deliberate.
      if (!confirmRearm) {
        setConfirmRearm(true);
        return;
      }
      setConfirmRearm(false);
      setArmToggling(true);
      try {
        await api.armLiveTrading();
        await refetchKillSwitch();
      } catch {
        // The next 5s poll shows the true state either way.
      } finally {
        setArmToggling(false);
      }
    };
    const dayTradingEnabled = settings.day_trading_enabled !== 'false';
    const configuredMaxContracts = executionMode.autonomous ? 1 : Math.max(1, Number(settings.contracts_per_trade || 1));
    const plannedContracts = Math.max(0, Number(option.planned_contracts || 0));
    const orderQuantity = plannedContracts > 0
      ? Math.min(configuredMaxContracts, plannedContracts)
      : configuredMaxContracts;
    const plannedLimit = Number(option.planned_limit_price || option.mark || 0);
    const orderDebit = plannedLimit > 0 && plannedContracts > 0 ? plannedLimit * orderQuantity * 100 : 0;
    const strategyDebitLimit = Number(option.strategy_max_total_debit_dollars || settings.strategy_max_total_debit_dollars || 0);
    const baseSnapshotAge = Number(strategyState?.ageSeconds);
    const snapshotGeneratedAt = Number(strategySignal?.generated_at);
    const timeSinceStateReceipt = strategyStateUpdatedAt > 0
      ? Math.max(0, (clockNow - strategyStateUpdatedAt) / 1000)
      : 0;
    const snapshotAge = Number.isFinite(baseSnapshotAge)
      ? baseSnapshotAge + timeSinceStateReceipt
      : Number.isFinite(snapshotGeneratedAt) && snapshotGeneratedAt > 0
        ? clockNow / 1000 - snapshotGeneratedAt
        : Number.NaN;
    const quoteAge = Number.isFinite(baseQuoteAge)
      ? baseQuoteAge + Math.max(0, snapshotAge)
      : Number.NaN;
    const freshSnapshot = Number.isFinite(snapshotAge) && snapshotAge >= 0 && snapshotAge <= 20;
    const marketDataReadiness = strategyState?.marketDataReadiness
      || strategySignal?.market_data_readiness
      || strategyState?.health?.market_data_readiness
      || null;
    const marketDataBlocked = marketDataReadiness?.status === 'BLOCKED';
    const marketDataSummary = marketDataReadinessCopy(marketDataReadiness);
    const usageRemaining = Number(tradeUsage?.remaining ?? 0);
    const entryAllowed = currentSignal?.entry_allowed === true
      && currentSignal.lifecycle_status === 'ACTIVE'
      && lifecycleData.entry_allowed !== false;
    const signalDismissed = currentExecution?.status === 'CANCELLED'
      && !currentExecution.status_detail
      && !currentExecution.order_id
      && !currentExecution.trade_id;
    const dismissedActionableSetup = signalDismissed && ['ARMED', 'ACTIVE'].includes(lifecycle);
    const liveMissing = executionMode.live
      ? [
          settings.snaptrade_trading_account_id ? null : 'Select a Wealthsimple account',
          settings.live_trading_acknowledged === 'true' ? null : 'Acknowledge live trading'
        ].filter(Boolean) as string[]
      : [];
    const primaryGex = strategySignal?.gex || strategySignal?.zerogex_shadow || {};
    const gexAge = gexAgeSeconds(strategySignal);
    const gexFresh = Number.isFinite(gexAge)
      && gexAge >= 0
      && gexAge <= MAX_GEX_PROVIDER_AGE_SECONDS
      && !primaryGex.error
      && strategySignal?.zerogex_shadow?.fresh !== false;
    const planQuality = setup?.plan_quality || strategySignal?.plan_quality || {};
    const planRewardRisk = Number(planQuality.reward_risk);
    const sessionPolicy = strategySignal?.session_policy || {};
    const linkedPosition = useMemo(() => positions.find(position => {
      const strategyPosition = position as Position & { signal_id?: number; strategy_setup_id?: string };
      return strategyPosition.status !== 'CLOSED' && strategyPosition.strategy_managed === true && (
        strategyPosition.signal_id === currentSignal?.id
        || (strategySetupId && strategyPosition.strategy_setup_id === strategySetupId)
      );
    }) || null, [positions, currentSignal?.id, strategySetupId]);
    const executionStatus = String(
      linkedPosition?.execution_status
      || linkedPosition?.last_broker_order_status
      || currentExecution?.status_detail
      || ''
    ).toUpperCase();
    const brokerPositionOpen = linkedPosition?.status === 'OPEN';
    const executionAlreadyRequested = Boolean(
      currentExecution && (
        currentExecution.status === 'EXECUTED'
        || currentExecution.order_id
        || currentExecution.trade_id
        || currentExecution.status_detail
      )
    );
    const strategyEntryBlockers = [
      // Kill-switch state leads: it overrides every client-side readiness signal.
      executionMode.live && killSwitchUnavailable
        ? 'Kill-switch status is unavailable — treat live entries as blocked'
        : null,
      executionMode.live && liveHalted
        ? (liveKillSwitch?.reason || 'Live trading is halted by the kill switch')
        : null,
      executionMode.live && !liveHalted && strategyState?.entryBlocked === true
        ? (strategyState.entryBlockedReason || 'The backend reports live entry is blocked')
        : null,
      !dayTradingEnabled ? 'Day trading is disabled' : null,
      sessionPolicy.valid !== true || sessionPolicy.is_trading_day !== true
        ? 'Strategy session policy is unavailable or the market is closed'
        : null,
      signalDismissed
        ? 'This setup is cancelled for your account'
        : currentSignal && currentSignal.status !== 'PENDING'
          ? `Signal is ${currentSignal.status.toLowerCase()}`
          : null,
      lifecycle !== 'ACTIVE' ? `Lifecycle is ${lifecycle}` : null,
      !entryAllowed ? 'Entry window is not open' : null,
      marketDataBlocked ? marketDataSummary : null,
      !freshSnapshot ? 'Strategy snapshot is stale' : null,
      !Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > 15 ? 'Selected option quote is stale or missing' : null,
      !gexFresh ? 'Authoritative GEX snapshot is stale or missing' : null,
      planQuality.meets_minimum !== true || !Number.isFinite(planRewardRisk) || planRewardRisk < 1.5
        ? 'Strategy plan does not meet the 1.50:1 minimum reward/risk'
        : null,
      usageRemaining <= 0 ? 'Daily trade limit reached' : null,
      plannedContracts <= 0 ? 'Strategy has no executable contract quantity' : null,
      ...liveMissing
    ].filter(Boolean) as string[];
    const executionSafetyBlocker = executionAlreadyRequested
      ? 'This setup already has a broker execution'
      : linkedPosition
        ? 'A position is already linked to this setup'
        : null;
    const executionBlockers = [...strategyEntryBlockers, executionSafetyBlocker].filter(Boolean) as string[];
    const strategyCanExecute = Boolean(currentSignal && strategyEntryBlockers.length === 0);
    const canExecute = Boolean(strategyCanExecute && !executionSafetyBlocker);
    const signalExecuted = currentExecution?.status === 'EXECUTED';
    const executionSubmitting = executionStatus === 'SUBMITTING';
    const executionStarted = signalExecuted
      || executionSubmitting
      || Boolean(currentExecution?.order_id || currentExecution?.trade_id)
      || ['PENDING_RECONCILE', 'ACCEPTED', 'PENDING_ORDER', 'PARTIALLY_FILLED', 'FILLED'].includes(executionStatus);
    const executionSkipped = executionStatus === 'SKIPPED';
    const brokerReportsFill = ['FILLED', 'FILLED_FULLY'].includes(executionStatus);
    const executionNeedsReview = Boolean(
      linkedPosition?.execution_error
      || (!brokerPositionOpen && currentExecution?.error)
      || (brokerReportsFill && !brokerPositionOpen)
      || (executionStatus && (
        ['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'STALE'].some(status => executionStatus.includes(status))
        || executionStatus.includes('RECONCILE_REQUIRED')
      ))
    );
    const entryReviewAvailable = ['ARMED', 'ACTIVE'].includes(lifecycle)
      && (!currentSignal || (!signalDismissed && !executionAlreadyRequested));
    const displayLifecycle = dismissedActionableSetup ? 'DISMISSED' : lifecycle;
    const lifecycleView = marketDataBlocked && !['MANAGE', 'EXTENDED'].includes(lifecycle)
      ? {
          eyebrow: 'Market data blocked',
          title: 'SPY market data is not ready',
          description: `${marketDataSummary}. New entries remain blocked until the strategy receives fresh IBKR data.`
        }
      : stateCopy(displayLifecycle, side, executionMode.autonomous);
    const currentTone = dismissedActionableSetup || marketDataBlocked ? 'blocked' : lifecycleTone(lifecycle);
    const currentStrategyCode = strategySignal?.strategy || null;
    const currentStrategy = strategyDisplay(currentStrategyCode);
    const spot = Number(strategySignal?.spot);
    const marketContext = strategySignal?.market_context || {};
    const vwap = marketContext.vwap == null ? Number.NaN : Number(marketContext.vwap);
    const ema9FiveMinute = marketContext.ema9_5m == null ? Number.NaN : Number(marketContext.ema9_5m);
    const ema21FiveMinute = marketContext.ema21_5m == null ? Number.NaN : Number(marketContext.ema21_5m);
    const fiveMinuteStructure = Number.isFinite(ema9FiveMinute) && Number.isFinite(ema21FiveMinute)
      ? ema9FiveMinute > ema21FiveMinute
        ? 'Bullish'
        : ema9FiveMinute < ema21FiveMinute
          ? 'Bearish'
          : 'Flat'
      : 'Unavailable';
    const spotVsVwap = Number.isFinite(spot) && Number.isFinite(vwap)
      ? `${money(Math.abs(spot - vwap))} ${spot >= vwap ? 'above' : 'below'}`
      : 'Unavailable';
    const trigger = Number(setup?.trigger);
    const invalidation = Number(setup?.invalidation);
    const exitTargetNumber = Math.max(1, Number(strategySignal?.paper_policy?.exit_after_target || 2));
    const targetOne = Number(targets[0]);
    const targetTwo = Number(targets[Math.min(exitTargetNumber, targets.length) - 1]);
    const hasLevelPlan = Boolean(setup) && [
      setup?.trigger,
      setup?.invalidation,
      targets[0],
      targets[Math.min(exitTargetNumber, targets.length) - 1]
    ].some(value => value != null && Number.isFinite(Number(value)));
    const optionSelected = Boolean(
      option.local_symbol
      || option.ticker
      || option.target_strike != null
      || option.strike != null
    );
    const rewardRisk = planRewardRisk;
    const spreadPct = optionSpreadPct(option);
    const rawBrokerName = String(linkedPosition?.execution_broker || currentExecution?.broker || '');
    const brokerName = rawBrokerName === 'wealthsimple_snaptrade'
      ? 'Wealthsimple / SnapTrade'
      : rawBrokerName || (executionMode.live ? 'Wealthsimple / SnapTrade' : 'Simulation');
    const brokerOrderId = linkedPosition?.broker_order_id || currentExecution?.order_id || null;
    const brokerSyncAt = linkedPosition?.last_broker_sync_at || linkedPosition?.updated_at || currentSignal?.created_at || null;
    const autonomousResult = String(strategyState?.autonomousEntry?.lastResult || '').replace(/^User\s+\d+:\s*/i, '');
    const autonomousLastAttemptAt = strategyState?.autonomousEntry?.lastAttemptAt || null;
    const executionMessage = linkedPosition?.execution_error
      || currentExecution?.error
      || autonomousResult
      || null;
    const spotVsTrigger = Number.isFinite(spot) && Number.isFinite(trigger)
      ? `${money(Math.abs(spot - trigger))} ${spot >= trigger ? 'above' : 'below'} trigger`
      : 'trigger distance unavailable';
    const heartbeatSummary = dismissedActionableSetup
      ? `The strategy engine remains ${lifecycle}, but this setup is closed for your account.`
      : marketDataBlocked
        ? `${marketDataSummary}. The strategy is preserving its safety gate and will resume setup evaluation after fresh IBKR data arrives.`
      : lifecycle === 'ACTIVE'
        ? `${strategyCanExecute ? 'Strategy entry conditions are live. ' : `${strategyEntryBlockers[0] || 'Entry conditions are incomplete'}. `}SPY is ${spotVsTrigger}; ${money(Math.abs(spot - invalidation))} from invalidation and ${money(Math.abs(targetTwo - spot))} from Target 2.`
        : lifecycle === 'ARMED'
          ? `The setup is forming. SPY is ${spotVsTrigger}; entry remains locked until every confirmation passes.`
          : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED'
            ? 'The strategy is monitoring invalidation and target progression.'
            : side
              ? `The strategy currently favors ${side === 'CALL' ? 'calls' : 'puts'}, but no qualified entry exists.${strategyBlockers[0] ? ` Waiting on: ${strategyBlockers[0]}.` : ''} SPY is ${spotVsTrigger}.`
              : strategyBlockers.includes('SPY 5m structure and VWAP are not aligned')
                ? `Entry session is open; waiting for 5-minute structure and VWAP alignment. Current view: ${fiveMinuteStructure.toLowerCase()} 5-minute structure, SPY ${spotVsVwap} VWAP.`
                : 'The strategy is monitoring SPY and has not produced a qualified setup.';
    const heartbeatLabel = dismissedActionableSetup
      ? 'Closed for your account'
      : marketDataBlocked
        ? 'IBKR data recovery required'
      : strategyCanExecute
        ? 'Strategy entry conditions live'
        : lifecycle === 'ACTIVE'
          ? 'Strategy entry blocked'
          : lifecycle === 'ARMED'
            ? 'Setup forming'
            : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED'
              ? 'Setup management'
              : 'Watching SPY';
    const approvalStillCurrent = !executeSignal || executeSignal.id === currentSignal?.id;
    const dismissStillCurrent = !dismissSignal || dismissSignal.id === currentSignal?.id;
    const approvalWindows = [
      20 - snapshotAge,
      15 - quoteAge,
      MAX_GEX_PROVIDER_AGE_SECONDS - gexAge
    ];
    const approvalSecondsRemaining = approvalWindows.every(Number.isFinite)
      ? Math.max(0, Math.floor(Math.min(...approvalWindows)))
      : 0;
    const canConfirmExecution = Boolean(executeSignal && approvalStillCurrent && canExecute && approvalSecondsRemaining > 0);
    const approvalBlocker = !approvalStillCurrent
      ? 'The strategy published a different setup while this review was open.'
      : executionBlockers[0] || (approvalSecondsRemaining <= 0 ? 'The approval data expired.' : null);
    const marketSessionLabel = sessionPolicy.valid !== true
      ? 'Strategy session policy unavailable'
      : sessionPolicy.is_trading_day === false
        ? 'Market closed · non-trading day'
        : `Strategy session · entry cutoff ${etMinute(sessionPolicy.entry_cutoff_minute_et)} ET · flatten ${etMinute(sessionPolicy.flatten_minute_et)} ET`;
    const staleReviewReason = !freshSnapshot
      ? 'Strategy snapshot is stale'
      : !Number.isFinite(gexAge)
        ? 'GEX snapshot age is unavailable'
        : !gexFresh
        ? 'GEX snapshot is stale'
        : null;
    const reviewDataFresh = !staleReviewReason;
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
        refetchHistory(),
        refetchPaperAccount(),
        fetchHealth()
      ]);
      setRefreshing(false);
    };

    const reconcileBrokerOrder = async () => {
      if (reconcilingBroker) return;
      setReconcilingBroker(true);
      setActionMessage(null);
      try {
        const result = await api.syncSnaptradePendingOrders();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals }),
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions }),
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage }),
          refetchStrategy(),
          refetchHistory()
        ]);
        setActionMessage({
          tone: 'success',
          text: result.opened > 0
            ? 'Broker reconciliation linked the filled position.'
            : 'Broker reconciliation completed. Review the broker state before taking another action.'
        });
      } catch (error: any) {
        setActionMessage({ tone: 'error', text: error.message || 'Broker reconciliation could not be completed.' });
      } finally {
        setReconcilingBroker(false);
      }
    };

    useEffect(() => {
      fetchHealth();
      const timer = window.setInterval(fetchHealth, 10000);
      return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
      riskRequestRef.current += 1;
      setRiskAssessment(null);
      setRiskError(null);
      setRiskLoading(false);
      setAiReviewExpanded(false);
    }, [currentSignal?.id, currentSignal?.lifecycle_status]);

    const runAdHocRiskReview = async () => {
      if (!currentSignal?.id || settings.day_trading_ai_enabled === 'false' || !reviewDataFresh) return;
      setAiReviewExpanded(true);
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
      // WS pushes carry the adapter's cached entryBlocked (null until an HTTP
      // status request primes it) — merge so a push never wipes a fresher
      // kill-switch overlay fetched over HTTP.
      const mergeStrategyState = (data: any) => {
        queryClient.setQueryData(QUERY_KEYS.strategyState, (prev: any) => ({
          ...data,
          entryBlocked: data.entryBlocked ?? prev?.entryBlocked ?? null,
          entryBlockedReason: data.entryBlockedReason ?? prev?.entryBlockedReason ?? null
        }));
      };
      if (lastMessage.type === 'STRATEGY_SNAPSHOT_UPDATED' && lastMessage.data) {
        mergeStrategyState(lastMessage.data);
      }
      if (lastMessage.type === 'STRATEGY_STATE_CHANGED') {
        if (lastMessage.data) mergeStrategyState(lastMessage.data);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyHistory });
      }
      if (['NEW_SIGNAL', 'SIGNAL_UPDATED'].includes(lastMessage.type)) {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
      }
      if (['POSITION_UPDATED', 'TRADE_UPDATED'].includes(lastMessage.type)) {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyHistory });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.paperAccount });
      }
      if (lastMessage.type === 'PAPER_POSITION_UPDATED' && lastMessage.data) {
        queryClient.setQueryData<PaperAccountSummary>(QUERY_KEYS.paperAccount, current => {
          if (!current) return current;
          let matched = false;
          const openPositions = current.openPositions.map(position => {
            if (Number(position.id) !== Number(lastMessage.data.positionId)) return position;
            matched = true;
            return {
              ...position,
              current_price: Number(lastMessage.data.currentPrice),
              underlying_price: lastMessage.data.underlyingPrice == null ? position.underlying_price : Number(lastMessage.data.underlyingPrice),
              trailing_high_price: Number(lastMessage.data.trailingHighPrice),
              trailing_stop_loss_pct: Number(lastMessage.data.trailingStopPct),
              suggested_stop_loss: lastMessage.data.suggestedStopLoss == null ? position.suggested_stop_loss : Number(lastMessage.data.suggestedStopLoss),
              analysis_data: lastMessage.data.analysis,
              updated_at: lastMessage.data.updatedAt
            };
          });
          if (!matched) return current;
          const recentPositions = current.recentPositions.map(position => (
            Number(position.id) === Number(lastMessage.data.positionId)
              ? {
                  ...position,
                  current_price: Number(lastMessage.data.currentPrice),
                  underlying_price: lastMessage.data.underlyingPrice == null ? position.underlying_price : Number(lastMessage.data.underlyingPrice),
                  trailing_high_price: Number(lastMessage.data.trailingHighPrice),
                  trailing_stop_loss_pct: Number(lastMessage.data.trailingStopPct),
                  suggested_stop_loss: lastMessage.data.suggestedStopLoss == null ? position.suggested_stop_loss : Number(lastMessage.data.suggestedStopLoss),
                  analysis_data: lastMessage.data.analysis,
                  updated_at: lastMessage.data.updatedAt
                }
              : position
          ));
          const equity = Number((Number(current.account.cash_balance) + openPositions.reduce(
            (total, position) => total + Number(position.current_price || 0) * Number(position.quantity || 0) * 100,
            0
          )).toFixed(2));
          const startOfDayEquity = Number(current.account.start_of_day_equity);
          return {
            ...current,
            account: {
              ...current.account,
              equity,
              high_water_mark: Math.max(Number(current.account.high_water_mark || 0), equity),
              updated_at: lastMessage.data.updatedAt
            },
            openPositions,
            recentPositions,
            session: {
              ...current.session,
              pnl: Number((equity - startOfDayEquity).toFixed(2)),
              pnlPct: startOfDayEquity > 0
                ? Number((((equity - startOfDayEquity) / startOfDayEquity) * 100).toFixed(2))
                : 0
            },
            health: { ...current.health, lastProcessedAt: lastMessage.data.updatedAt }
          };
        });
      }
      if (lastMessage.type === 'PAPER_ACCOUNT_CHANGED') {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.paperAccount });
      }
    }, [lastMessage, queryClient]);

    useEffect(() => {
      const alertState = `${strategySetupId || 'none'}:${lifecycle}`;
      if (lastAlertStateRef.current === null) {
        lastAlertStateRef.current = alertState;
        return;
      }
      const changed = lastAlertStateRef.current !== alertState;
      lastAlertStateRef.current = alertState;
      if (!changed || !browserAlertsEnabled || !['ARMED', 'ACTIVE'].includes(lifecycle)) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      new Notification(`SPY setup ${lifecycle.toLowerCase()}`, {
        body: lifecycle === 'ACTIVE'
          ? `${side || 'Directional'} entry conditions are live. Open the app to review the protected order.`
          : `${side || 'Directional'} setup is forming. Entry remains locked until ACTIVE.`
      });
    }, [browserAlertsEnabled, lifecycle, side, strategySetupId]);

    const toggleBrowserAlerts = async () => {
      if (browserAlertsEnabled) {
        window.localStorage.setItem(BROWSER_SETUP_ALERTS_KEY, 'false');
        setBrowserAlertsEnabled(false);
        setActionMessage({ tone: 'success', text: 'Browser setup alerts disabled.' });
        return;
      }
      if (typeof Notification === 'undefined') {
        setActionMessage({ tone: 'error', text: 'This browser does not support setup notifications.' });
        return;
      }
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (permission !== 'granted') {
        setActionMessage({ tone: 'error', text: 'Browser notification permission was not granted.' });
        return;
      }
      window.localStorage.setItem(BROWSER_SETUP_ALERTS_KEY, 'true');
      setBrowserAlertsEnabled(true);
      setActionMessage({ tone: 'success', text: 'Browser alerts enabled for ARMED and ACTIVE setups.' });
    };

    const togglePaperAutomation = async () => {
      if (!paperAccount?.canManage || paperUpdating) return;
      const shouldActivate = paperAccount.strategyAutomationStatus !== 'ACTIVE';
      setPaperUpdating(true);
      setActionMessage(null);
      try {
        await api.setPaperAutomation(shouldActivate);
        await refetchPaperAccount();
        setActionMessage({
          tone: 'success',
          text: `System paper automation ${shouldActivate ? 'resumed' : 'paused'}. Open positions remain protected.`
        });
      } catch (error: any) {
        setActionMessage({ tone: 'error', text: error.message || 'Could not update paper automation.' });
      } finally {
        setPaperUpdating(false);
      }
    };

    const confirmPaperClose = async (force = false) => {
      if (!paperClosePosition || !paperAccount?.canManage || paperClosing) return;
      setPaperClosing(true);
      setActionMessage(null);
      try {
        const result = await api.closePaperPosition(Number(paperClosePosition.id), force);
        setPaperClosePosition(null);
        setPaperForceCloseAvailable(false);
        await refetchPaperAccount();
        setActionMessage({
          tone: 'success',
          text: `Paper position ${result.forced ? 'force ' : ''}closed at ${money(result.fillPrice)} using ${result.priceSource.replace(/_/g, ' ').toLowerCase()}. Realized ${result.realizedPnl >= 0 ? '+' : ''}${money(result.realizedPnl)}.${result.warning ? ` Runtime warning: ${result.warning}` : ''}`
        });
      } catch (error: any) {
        if (!force && error.code === 'PAPER_FRESH_QUOTE_REQUIRED') {
          setPaperForceCloseAvailable(true);
        } else {
          await refetchPaperAccount().catch(() => undefined);
        }
        const diagnostic = error.diagnostic
          ? [error.diagnostic.stage, error.diagnostic.databaseCode, error.diagnostic.constraint].filter(Boolean).join(' · ')
          : '';
        setActionMessage({
          tone: 'error',
          text: `${error.message || 'Could not close the paper position.'}${diagnostic ? ` Diagnostic: ${diagnostic}.` : ''}`
        });
      } finally {
        setPaperClosing(false);
      }
    };

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
      if (!canConfirmExecution) {
        setActionMessage({ tone: 'error', text: approvalBlocker || 'This order review expired. Refresh the setup before trying again.' });
        return;
      }
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
      if (!dismissSignal) return;
      if (!dismissStillCurrent) {
        setActionMessage({ tone: 'error', text: 'The strategy changed before dismissal was confirmed. Review the new setup instead.' });
        setDismissSignal(null);
        return;
      }
      setDismissing(true);
      setActionMessage(null);
      try {
        await api.updateSignalStatus(dismissSignal.id, 'CANCELLED');
        setActionMessage({ tone: 'success', text: 'Setup dismissed for this account.' });
        setDismissSignal(null);
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
      } catch (error: any) {
        setActionMessage({ tone: 'error', text: error.message || 'Could not dismiss this setup.' });
      } finally {
        setDismissing(false);
      }
    };

    const strategyHealth = services?.strategyEngine;
    const ibkrHealth = services?.marketData?.ibkr || services?.streams?.ibkr;
    const systemReady = strategyHealth?.status === 'UP' && ibkrHealth?.connected === true;
    const diagnostics = [
      {
        label: 'Strategy engine',
        status: strategyHealth?.status || 'N/A',
        age: compactAge(strategyHealth?.freshnessMs),
        detail: strategyHealth?.lastError || strategyHealth?.degradedReason || `${strategyHealth?.mode || 'primary'} mode · ${strategyHealth?.connected ? 'provider connected' : 'provider disconnected'}`,
        next: 'Check the strategy-engine container, IBKR connection, and snapshot timestamps.'
      },
      {
        label: 'ZeroGEX',
        status: Number.isFinite(gexAge) ? gexFresh ? 'UP' : 'DEGRADED' : 'DOWN',
        age: Number.isFinite(gexAge) ? `${number(gexAge, 1)}s old` : 'age unavailable',
        detail: Number.isFinite(gexAge)
          ? `${String(primaryGex.regime || primaryGex.gamma_regime || 'GEX context')} · authoritative provider timestamp`
          : 'No authoritative GEX timestamp.',
        next: 'Check the ZeroGEX key and zerogex-prefetch health, then wait for a fresh snapshot.'
      },
      {
        label: 'IBKR market data',
        status: services?.marketData?.ibkr?.status || 'N/A',
        age: services?.marketData?.ibkr?.latencyMs != null ? `${services.marketData.ibkr.latencyMs}ms` : undefined,
        detail: services?.marketData?.ibkr?.lastError || `${services?.marketData?.ibkr?.mode || 'live'} · ${services?.marketData?.ibkr?.host || 'gateway'}:${services?.marketData?.ibkr?.port || '—'}`,
        next: 'Restore Gateway API connectivity and confirm the configured host, port, and market-data entitlement.'
      },
      {
        label: 'IBKR quote stream',
        status: services?.streams?.ibkr?.status || 'N/A',
        age: compactAge(services?.streams?.ibkr?.freshnessMs),
        detail: services?.streams?.ibkr?.lastError || `${services?.streams?.ibkr?.activeSubscriptions || 0} active option subscriptions`,
        next: 'Restore Gateway connectivity, then restart the backend quote stream.'
      },
      {
        label: 'Live exit monitor',
        status: services?.liveExitMonitor?.status || 'N/A',
        age: compactAge(services?.liveExitMonitor?.freshnessMs),
        detail: services?.liveExitMonitor?.lastError || `${services?.liveExitMonitor?.provider || 'no provider'} · ${services?.liveExitMonitor?.quotesProcessed || 0} quotes processed`,
        next: 'Check open option subscriptions and restart the backend after the IBKR stream is healthy.'
      },
      {
        label: 'Redis updates',
        status: services?.tradeRedis?.status || 'N/A',
        age: compactAge(services?.tradeRedis?.freshnessMs),
        detail: services?.tradeRedis?.lastError || `${services?.tradeRedis?.queueDepth ?? 0} queued events`,
        next: 'Check the Redis container and backend Redis URL.'
      },
      {
        label: 'System paper trader',
        status: services?.paperTrading?.status || paperAccount?.health.status || 'N/A',
        age: services?.paperTrading?.lastProcessedAt ? dateTime(services.paperTrading.lastProcessedAt) : undefined,
        detail: services?.paperTrading?.lastError || `${paperAccount?.account.automation_status || 'starting'} · shared $100K strategy account`,
        next: 'Check strategy snapshots, the paper account schema, and the latest paper decision.'
      },
      {
        label: 'Postgres',
        status: services?.postgres?.status || 'N/A',
        age: services?.postgres?.latencyMs != null ? `${services.postgres.latencyMs}ms` : undefined,
        detail: services?.postgres?.lastError || 'Signal, position, and lifecycle history available',
        next: 'Check database reachability, credentials, and schema verification logs.'
      }
    ];
    const paperUnrealizedPnl = paperAccount?.openPositions.reduce(
      (total, position) => total + (Number(position.current_price) - Number(position.entry_price)) * Number(position.quantity) * 100,
      0
    ) || 0;
    const paperAvailableCash = paperAccount
      ? Number(paperAccount.account.cash_balance) - Number(paperAccount.account.reserved_cash)
      : 0;
    const normalizedPaperSearch = paperActivitySearch.trim().toLowerCase();
    const filteredPaperOrders = (paperAccount?.recentOrders || []).filter(order => {
      const status = String(order.status || 'UNKNOWN').toUpperCase();
      const matchesFilter = paperActivityFilter === 'ALL' || status === paperActivityFilter;
      const matchesSearch = !normalizedPaperSearch || [
        order.osi_ticker,
        order.intent,
        order.action,
        order.status,
        order.position_id,
        order.setup_id,
        order.decision_id,
        order.failure_reason
      ].some(value => String(value || '').toLowerCase().includes(normalizedPaperSearch));
      return matchesFilter && matchesSearch;
    });
    const filteredPaperJournal = (paperAccount?.journal || []).filter(item => {
      const category = paperEventCategory(item.event_type);
      const matchesFilter = paperActivityFilter === 'ALL' || category === paperActivityFilter;
      const matchesSearch = !normalizedPaperSearch || [
        item.event_type,
        item.message,
        item.position_id,
        item.setup_id,
        item.decision_id,
        item.policy_version
      ].some(value => String(value || '').toLowerCase().includes(normalizedPaperSearch));
      return matchesFilter && matchesSearch;
    });
    const filteredPaperPositions = (paperAccount?.recentPositions || []).filter(position => {
      const status = String(position.status || '').toUpperCase();
      const realizedPnl = Number(position.realized_pnl || 0);
      const executionStatus = String(position.execution_status || '').toUpperCase();
      const needsAttention = Boolean(position.execution_error)
        || /(REJECTED|FAILED|STALE|UNKNOWN)/.test(executionStatus)
        || (paperAccount?.recentOrders || []).some(order => (
          paperRecordLinksToPosition(position, order) && paperOrderNeedsAttention(order)
        ));
      const matchesFilter = paperActivityFilter === 'ALL'
        || status === paperActivityFilter
        || (paperActivityFilter === 'WIN' && status === 'CLOSED' && realizedPnl > 0)
        || (paperActivityFilter === 'LOSS' && status === 'CLOSED' && realizedPnl < 0)
        || (paperActivityFilter === 'ATTENTION' && needsAttention);
      const matchesSearch = !normalizedPaperSearch || [
        position.id,
        position.symbol,
        position.option_type,
        position.strike_price,
        position.expiration_date,
        position.strategy_setup_id,
        position.paper_decision_id,
        position.exit_reason,
        position.decision_rationale
      ].some(value => String(value || '').toLowerCase().includes(normalizedPaperSearch));
      return matchesFilter && matchesSearch;
    });

    const selectPaperActivityTab = (tab: PaperActivityTab) => {
      setPaperActivityTab(tab);
      setPaperActivityFilter('ALL');
    };


  return {
    services,
    setServices,
    healthError,
    setHealthError,
    refreshing,
    setRefreshing,
    executeSignal,
    setExecuteSignal,
    dismissSignal,
    setDismissSignal,
    executing,
    setExecuting,
    dismissing,
    setDismissing,
    reconcilingBroker,
    setReconcilingBroker,
    clockNow,
    setClockNow,
    browserAlertsEnabled,
    setBrowserAlertsEnabled,
    actionMessage,
    setActionMessage,
    riskAssessment,
    setRiskAssessment,
    riskLoading,
    setRiskLoading,
    paperUpdating,
    setPaperUpdating,
    paperClosePosition,
    setPaperClosePosition,
    highlightedPositionId,
    setHighlightedPositionId,
    paperClosing,
    setPaperClosing,
    paperForceCloseAvailable,
    setPaperForceCloseAvailable,
    riskError,
    setRiskError,
    paperExpanded,
    setPaperExpanded,
    paperActivityTab,
    setPaperActivityTab,
    paperActivityFilter,
    setPaperActivityFilter,
    paperActivitySearch,
    setPaperActivitySearch,
    aiReviewExpanded,
    setAiReviewExpanded,
    historyExpanded,
    setHistoryExpanded,
    diagnosticsExpanded,
    setDiagnosticsExpanded,
    armToggling,
    setArmToggling,
    confirmRearm,
    setConfirmRearm,
    isConnected,
    lastMessage,
    signals,
    signalsLoading,
    refetchSignals,
    strategyState,
    strategyStateUpdatedAt,
    refetchStrategy,
    settings,
    tradeUsage,
    killSwitch,
    killSwitchUnavailable,
    refetchKillSwitch,
    positions,
    paperAccount,
    refetchPaperAccount,
    strategyHistory,
    historyLoading,
    historyError,
    refetchHistory,
    queryClient,
    riskRequestRef,
    lastAlertStateRef,
    strategySignal,
    strategyLanes,
    strategySetupId,
    currentSignal,
    currentExecution,
    lifecycle,
    side,
    directionConfirmed,
    setup,
    option,
    baseQuoteAge,
    lifecycleData,
    targets,
    confirmations,
    strategyBlockers,
    executionMode,
    liveKillSwitch,
    liveHalted,
    liveDisarmed,
    handleDisarmLive,
    handleArmLive,
    dayTradingEnabled,
    configuredMaxContracts,
    plannedContracts,
    orderQuantity,
    plannedLimit,
    orderDebit,
    strategyDebitLimit,
    baseSnapshotAge,
    snapshotGeneratedAt,
    timeSinceStateReceipt,
    snapshotAge,
    quoteAge,
    freshSnapshot,
    marketDataReadiness,
    marketDataBlocked,
    marketDataSummary,
    usageRemaining,
    entryAllowed,
    signalDismissed,
    dismissedActionableSetup,
    liveMissing,
    primaryGex,
    gexAge,
    gexFresh,
    planQuality,
    planRewardRisk,
    sessionPolicy,
    linkedPosition,
    executionStatus,
    brokerPositionOpen,
    executionAlreadyRequested,
    strategyEntryBlockers,
    executionSafetyBlocker,
    executionBlockers,
    strategyCanExecute,
    canExecute,
    signalExecuted,
    executionSubmitting,
    executionStarted,
    executionSkipped,
    brokerReportsFill,
    executionNeedsReview,
    entryReviewAvailable,
    displayLifecycle,
    lifecycleView,
    currentTone,
    currentStrategyCode,
    currentStrategy,
    spot,
    marketContext,
    vwap,
    ema9FiveMinute,
    ema21FiveMinute,
    fiveMinuteStructure,
    spotVsVwap,
    trigger,
    invalidation,
    exitTargetNumber,
    targetOne,
    targetTwo,
    hasLevelPlan,
    optionSelected,
    rewardRisk,
    spreadPct,
    rawBrokerName,
    brokerName,
    brokerOrderId,
    brokerSyncAt,
    autonomousResult,
    autonomousLastAttemptAt,
    executionMessage,
    spotVsTrigger,
    heartbeatSummary,
    heartbeatLabel,
    approvalStillCurrent,
    dismissStillCurrent,
    approvalWindows,
    approvalSecondsRemaining,
    canConfirmExecution,
    approvalBlocker,
    marketSessionLabel,
    staleReviewReason,
    reviewDataFresh,
    fetchHealth,
    refreshAll,
    reconcileBrokerOrder,
    runAdHocRiskReview,
    toggleBrowserAlerts,
    togglePaperAutomation,
    confirmPaperClose,
    requestExecution,
    confirmExecution,
    cancelSetup,
    strategyHealth,
    ibkrHealth,
    systemReady,
    diagnostics,
    paperUnrealizedPnl,
    paperAvailableCash,
    normalizedPaperSearch,
    filteredPaperOrders,
    filteredPaperJournal,
    filteredPaperPositions,
    selectPaperActivityTab
  } as const;
}

export type DayTradingTerminalModel = ReturnType<typeof useDayTradingTerminal>;
