import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';
import { isAmbiguousSnapTradeOrderError, isBrokerSyncInProgressError, SnaptradeService } from './snaptrade-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { TradeRedisService } from './trade-redis-service';
import { TradeLifecycleService } from './trade-lifecycle-service';
import { DiscordAlertService } from './discord-alert-service';
import { IbkrMarketDataService } from './ibkr-market-data-service';
import { tradingEventBus } from '../lib/trading-events';
import { RiskDecisionService } from './risk-decision-service';
import type { PreSubmitRiskAssessment } from './risk-decision-service';

type ExecutionBroker = 'none' | 'wealthsimple_snaptrade' | 'simulated';

interface ExecuteSignalInput {
  userId: number;
  signalId: number;
  symbol: string;
  winningSide: 'CALL' | 'PUT';
  chosenStrike: number;
  chosenExpiry: string;
  stopUnderlying: number;
  targetUnderlying: number;
  mark: number | null;
}

interface ExecutionSettings {
  day_trading_enabled?: string;
  execution_broker?: string;
  snaptrade_auto_trade?: string;
  autonomous_live_entry_enabled?: string;
  snaptrade_trading_account_id?: string;
  max_trades_per_day?: string;
  contracts_per_trade?: string;
  order_type?: string;
  entry_slippage_pct?: string;
  entry_limit_offset_pct?: string;
  take_profit_pct?: string;
  stop_loss_engine_enabled?: string;
  synthetic_trailing_stop_enabled?: string;
  synthetic_trailing_stop_pct?: string;
  live_trading_acknowledged?: string;
  max_daily_loss_dollars?: string;
  max_consecutive_losses?: string;
  loss_cooldown_minutes?: string;
  max_premium_risk_dollars?: string;
  max_correlated_positions?: string;
  shadow_trading_enabled?: string;
}

type EntryQuoteSnapshot = {
  source: 'ibkr';
  ticker: string;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  mark: number;
  spreadPct: number | null;
  syntheticOnly: boolean;
  quoteAgeMs: number | null;
  tradeAgeMs: number | null;
  timestamp: string | null;
};

type EntryQuoteValidation = {
  quote: EntryQuoteSnapshot;
  protectedLimit: number;
  baselineMark: number | null;
  movePct: number | null;
  stabilityMovePct: number | null;
};

type SupersededExitResolution = {
  state: 'closed' | 'open' | 'pending' | 'review';
  position: any;
};

type DeferredSignalRetryState = {
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export class TradeExecutionService {
  private static deferredSignalRetries = new Map<string, DeferredSignalRetryState>();
  constructor(private fastify: FastifyInstance) {}

  private readonly ENTRY_MAX_QUOTE_AGE_MS = 2_000;
  private readonly ENTRY_MAX_SPREAD_PCT = 5;
  private readonly ENTRY_MIN_BID_TO_ENTRY_RATIO = 0.90;
  private readonly ENTRY_LIMIT_MID_TO_ASK_OFFSET_PCT = 20;
  private readonly PLANNED_LOSS_FRACTION = 0.40;
  private readonly BROKER_SYNC_RETRY_BACKOFF_BASE_MS = 500;
  private readonly BROKER_SYNC_ENTRY_MAX_ATTEMPTS = 13;
  private readonly SUPERSEDED_EXIT_CONFIRMATION_ATTEMPTS = 4;
  private readonly DEFERRED_SIGNAL_RETRY_DELAY_MS = 2_000;
  private readonly DEFERRED_SIGNAL_RETRY_MAX_AGE_MS = 10 * 60_000;
  public async getSettingsForUser(userId: number): Promise<ExecutionSettings> {
    const dbSettings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);

    return {
      day_trading_enabled: 'true',
      execution_broker: 'none',
      snaptrade_auto_trade: 'false',
      autonomous_live_entry_enabled: 'false',
      snaptrade_trading_account_id: '',
      max_trades_per_day: '2',
      contracts_per_trade: '1',
      order_type: 'LIMIT',
      entry_slippage_pct: '3',
      entry_limit_offset_pct: String(this.ENTRY_LIMIT_MID_TO_ASK_OFFSET_PCT),
      take_profit_pct: '',
      stop_loss_engine_enabled: 'true',
      synthetic_trailing_stop_enabled: 'false',
      synthetic_trailing_stop_pct: '15',
      live_trading_acknowledged: 'false',
      max_daily_loss_dollars: '200',
      max_consecutive_losses: '3',
      loss_cooldown_minutes: '30',
      max_premium_risk_dollars: '500',
      max_correlated_positions: '3',
      shadow_trading_enabled: 'false',
      ...dbSettings
    };
  }

  public async executeSignal(input: ExecuteSignalInput, settingsOverride?: ExecutionSettings) {
    const settings = settingsOverride || await this.getSettingsForUser(input.userId);
    const broker = this.resolveBroker(settings);
    if (settings.day_trading_enabled === 'false') {
      const message = 'Day trading is disabled in settings';
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }
    const signalContract = await this.getSignalExecutionContract(input.signalId);
    const configuredQuantity = this.parsePositiveInt(settings.contracts_per_trade, 1, 100);
    const plannedContracts = Number(signalContract.optionDetails?.planned_contracts || 0);
    if (signalContract.engineVersion === 'signal-only-v2' && (!Number.isInteger(plannedContracts) || plannedContracts <= 0)) {
      const message = 'Strategy execution plan is missing a valid planned contract quantity';
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }
    const quantity = signalContract.engineVersion === 'signal-only-v2'
      ? Math.min(configuredQuantity, plannedContracts)
      : configuredQuantity;
    const maxTradesPerDay = this.parsePositiveInt(settings.max_trades_per_day, 2, 100);
    const riskState = await this.getRiskState(input.userId, settings, broker);

    const existingExecution = await this.getExistingSignalExecution(input.userId, input.signalId);
    const existingExecutionRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker,
      contractLabel: this.contractLabel(input),
      existingExecution
    });
    if (!existingExecutionRisk.approved) {
      const message = existingExecutionRisk.denials[0]?.message || `Signal #${input.signalId} already has an execution record`;
      this.fastify.log.info(`[TradeExecutionService] ${message}. Preserving the existing execution state.`);
      return {
        success: false,
        skipped: true,
        duplicate: true,
        broker,
        message,
        riskCode: 'EXISTING_SIGNAL_EXECUTION'
      };
    }

    const setupGrade = await this.getSignalSetupGrade(input.signalId);
    const setupGradeRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker,
      contractLabel: this.contractLabel(input),
      setupGrade
    });
    if (!setupGradeRisk.approved) {
      return this.denyPreSubmitRisk(input, broker, setupGradeRisk);
    }

    const entryLockKey = TradeRedisService.keys.entryExposureLock(
      input.userId,
      broker,
      input.symbol
    );
    const entryLock = await TradeRedisService.acquireLock(entryLockKey, broker === 'wealthsimple_snaptrade' ? 120 : 30);
    if (!entryLock.acquired) {
      if (String(existingExecution?.execution_status || '').toUpperCase() === 'DEFERRED_ENTRY') {
        const message = 'Deferred entry is waiting for the prior per-user execution lock to finish.';
        this.scheduleDeferredSignalRetry(input, settings);
        return { success: false, deferred: true, retryable: true, broker, message, riskCode: 'ENTRY_LOCK_BUSY' };
      }
      const message = `Skipped duplicate entry: ${this.contractLabel(input)} already has an entry request in progress`;
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }
    if (entryLock.degraded && broker === 'wealthsimple_snaptrade') {
      if (String(existingExecution?.execution_status || '').toUpperCase() === 'DEFERRED_ENTRY') {
        const message = 'Deferred live entry is waiting for the protected exposure lock to recover.';
        this.scheduleDeferredSignalRetry(input, settings);
        return { success: false, deferred: true, retryable: true, broker, message, riskCode: 'ENTRY_LOCK_DEGRADED' };
      }
      const message = 'Live entry blocked because the exposure lock is unavailable';
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }

    try {
    if (broker === 'wealthsimple_snaptrade') {
      try {
        const brokerOrdersVerified = await this.reconcileBrokerOrdersBeforeEntry(input.userId);
        if (!brokerOrdersVerified) {
          const message = 'Entry remains eligible, but Wealthsimple order verification did not finish within the guarded retry window. No broker order was submitted.';
          this.fastify.log.info(`[TradeExecutionService] ${message}`);
          await this.markSignalExecutionDeferred(input.userId, input.signalId, broker, message);
          this.scheduleDeferredSignalRetry(input, settings);
          return {
            success: false,
            deferred: true,
            retryable: true,
            broker,
            message,
            riskCode: 'BROKER_SYNC_DEFERRED'
          };
        }
      } catch (err: any) {
        const message = `Could not verify Wealthsimple orders before entry: ${err.message || String(err)}`;
        await this.markSignalExecutionFailure(input.userId, input.signalId, message);
        return { success: false, broker, message };
      }
    }

    const duplicate = await this.findDuplicateOpenEntry(input, broker);
    const duplicateRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker,
      contractLabel: this.contractLabel(input),
      duplicateOpenEntry: duplicate
    });
    if (!duplicateRisk.approved) {
      return this.denyPreSubmitRisk(input, broker, duplicateRisk, { duplicatePositionId: duplicateRisk.denials[0]?.metadata?.duplicatePositionId });
    }

    const supersededSummary = await this.closeSupersededPositions(input, settings, broker);
    if (supersededSummary.blocked) {
      await this.markSignalExecutionFailure(input.userId, input.signalId, supersededSummary.message);
      return { success: false, broker, message: supersededSummary.message, superseded: supersededSummary };
    }
    if (supersededSummary.deferred) {
      await this.markSignalExecutionDeferred(input.userId, input.signalId, broker, supersededSummary.message);
      this.scheduleDeferredSignalRetry(input, settings);
      return {
        success: false,
        deferred: true,
        retryable: true,
        broker,
        message: supersededSummary.message,
        riskCode: 'SUPERSEDED_EXIT_PENDING',
        superseded: supersededSummary
      };
    }

    const correlatedPositions = await this.getCorrelatedOpenPositions(input.userId, input.symbol, broker);
    const correlatedOpenPositions = correlatedPositions.length;
    const correlatedLabel = ['SPY', 'QQQ'].includes(String(input.symbol || '').toUpperCase()) ? 'SPY/QQQ' : input.symbol;
    const correlatedRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker,
      contractLabel: correlatedLabel,
      correlatedOpenPositions,
      correlatedPositions,
      maxCorrelatedPositions: riskState.maxCorrelatedPositions
    });
    if (!correlatedRisk.approved) {
      return this.denyPreSubmitRisk(input, broker, correlatedRisk);
    }

    const accountRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker,
      contractLabel: this.contractLabel(input),
      dailyRealizedPnl: riskState.dailyRealizedPnl,
      maxDailyLoss: riskState.maxDailyLoss,
      consecutiveLosses: riskState.consecutiveLosses,
      maxConsecutiveLosses: riskState.maxConsecutiveLosses,
      cooldownUntil: riskState.cooldownUntil,
      premiumRisk: Math.max(0, Number(input.mark || 0) * quantity * 100),
      maxPremiumRisk: riskState.maxPremiumRisk,
      plannedLoss: this.plannedLossForSignal(
        signalContract.optionDetails,
        Math.max(0, Number(input.mark || 0) * quantity * 100),
        quantity
      ),
      remainingDailyLossBudget: riskState.remainingDailyLossBudget
    });
    if (!accountRisk.approved) {
      return this.denyPreSubmitRisk(input, broker, accountRisk);
    }

    const currentTradeCount = await this.countTradesToday(input.userId, broker);
    const dailyLimitRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker,
      contractLabel: this.contractLabel(input),
      currentTradeCount,
      maxTradesPerDay
    });
    if (!dailyLimitRisk.approved) {
      return this.denyPreSubmitRisk(input, broker, dailyLimitRisk);
    }

    if (broker === 'none' || broker === 'simulated') {
      return this.createSimulatedPosition(input, quantity, broker === 'simulated' ? 'Shadow trading mode' : 'Broker execution disabled');
    }

    tradingEventBus.publish({
      type: 'EXECUTION_REQUESTED',
      createdAt: new Date().toISOString(),
      signalId: input.signalId,
      userId: input.userId,
      broker
    });

    if (broker === 'wealthsimple_snaptrade') {
      return this.executeSnapTradeOptionTrade(input, settings, quantity);
    }

    return this.createSimulatedPosition(input, quantity, 'Unknown execution broker');
    } finally {
      await TradeRedisService.releaseLock(entryLock);
    }
  }

  public async getDailyTradeUsage(userId: number, settingsOverride?: ExecutionSettings) {
    const settings = settingsOverride || await this.getSettingsForUser(userId);
    const maxTradesPerDay = this.parsePositiveInt(settings.max_trades_per_day, 2, 100);
    const used = await this.countTradesToday(userId, this.resolveBroker(settings));

    return {
      used,
      max: maxTradesPerDay,
      remaining: Math.max(0, maxTradesPerDay - used)
    };
  }

  private async denyPreSubmitRisk(input: ExecuteSignalInput, broker: ExecutionBroker, assessment: PreSubmitRiskAssessment, extra: Record<string, any> = {}) {
    const primaryDenial = assessment.denials[0];
    const message = primaryDenial?.message || 'Entry skipped: pre-submit risk check denied order';
    const skipped = primaryDenial?.skipped ?? true;
    await this.markSignalExecutionFailure(input.userId, input.signalId, message, skipped, {
      riskCode: primaryDenial?.code || null,
      riskDenials: assessment.denials,
      riskWarnings: assessment.warnings,
      riskEvidence: assessment.evidence
    });
    tradingEventBus.publish({
      type: 'EXECUTION_SKIPPED',
      createdAt: new Date().toISOString(),
      signalId: input.signalId,
      userId: input.userId,
      reason: message
    });
    this.fastify.log.info(`[TradeExecutionService] ${message}`);
    return {
      success: false,
      skipped,
      broker,
      message,
      riskCode: primaryDenial?.code || null,
      riskDenials: assessment.denials.map((denial) => denial.code),
      ...extra
    };
  }

  private resolveBroker(settings: ExecutionSettings): ExecutionBroker {
    if (settings.shadow_trading_enabled === 'true') return 'simulated';
    const configured = settings.execution_broker as ExecutionBroker | undefined;
    if (configured === 'wealthsimple_snaptrade' && settings.snaptrade_auto_trade === 'true') return 'wealthsimple_snaptrade';
    return 'none';
  }

  private parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
    const parsed = parseInt(value || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  }

  private parsePositiveNumber(value: string | undefined, fallback: number, max: number): number {
    const parsed = Number(value || '');
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  }

  private parseOptionalPct(value: string | undefined, max: number): number | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.min(parsed, max);
  }

  private async getExistingSignalExecution(userId: number, signalId: number) {
    const { rows } = await this.fastify.pg.query(
      `SELECT status, execution_status, broker_order_id
       FROM signal_user_executions
       WHERE user_id = $1
         AND signal_id = $2`,
      [userId, signalId]
    );
    return rows[0] || null;
  }

  private async getSignalSetupGrade(signalId: number): Promise<string | null> {
    const { rows } = await this.fastify.pg.query(
      `SELECT setup_grade
       FROM signals
       WHERE id = $1`,
      [signalId]
    );
    return rows[0]?.setup_grade || null;
  }

  private isExecutableSetupGrade(setupGrade: string | null | undefined): boolean {
    return RiskDecisionService.isExecutableSetupGrade(setupGrade);
  }

  private executionScopeSql(broker: ExecutionBroker): string {
    return broker === 'wealthsimple_snaptrade'
      ? "COALESCE(is_simulated, FALSE) = FALSE AND execution_broker = 'wealthsimple_snaptrade'"
      : "(COALESCE(is_simulated, FALSE) = TRUE OR execution_broker = 'simulated' OR account_id = 'simulated')";
  }

  private async findDuplicateOpenEntry(input: ExecuteSignalInput, broker: ExecutionBroker) {
    const { rows } = await this.fastify.pg.query(
      `SELECT id, status, execution_status, broker_order_id, strategy_managed
       FROM positions
       WHERE user_id = $1
         AND symbol = $2
         AND option_type = $3
         AND strike_price = $4
         AND expiration_date::date = $5::date
         AND status IN ('OPEN', 'PENDING_ORDER')
         AND ${this.executionScopeSql(broker)}
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.userId, input.symbol, input.winningSide, input.chosenStrike, input.chosenExpiry]
    );
    return rows[0] || null;
  }

  private contractLabel(input: ExecuteSignalInput): string {
    return `${input.symbol} ${input.chosenExpiry} ${input.winningSide} ${input.chosenStrike}`;
  }

  private strategyLane(snapshot: any): string {
    const explicit = String(snapshot?.strategy_lane || '').trim().toLowerCase();
    if (explicit) return explicit;
    const strategy = String(snapshot?.strategy || '').toUpperCase();
    if (strategy === 'ORB_INDEX') return 'orb_index';
    if (strategy === 'VWAP_TREND') return 'vwap_trend';
    return 'mtf';
  }

  private async countTradesToday(userId: number, broker: ExecutionBroker): Promise<number> {
    const { rows } = await this.fastify.pg.query(
      `SELECT COUNT(*)::int AS count
       FROM positions
       WHERE user_id = $1
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
         AND ${this.executionScopeSql(broker)}`,
      [userId]
    );
    return Number(rows[0]?.count || 0);
  }

  private async getRiskState(userId: number, settings: ExecutionSettings, broker: ExecutionBroker) {
    const maxDailyLoss = this.parsePositiveNumber(settings.max_daily_loss_dollars, 200, 1_000_000);
    const maxConsecutiveLosses = this.parsePositiveInt(settings.max_consecutive_losses, 3, 100);
    const lossCooldownMinutes = this.parsePositiveInt(settings.loss_cooldown_minutes, 30, 24 * 60);
    const maxPremiumRisk = this.parsePositiveNumber(settings.max_premium_risk_dollars, 500, 1_000_000);
    const maxCorrelatedPositions = this.parsePositiveInt(settings.max_correlated_positions, 3, 20);
    const { rows: pnlRows } = await this.fastify.pg.query(
      `SELECT COALESCE(SUM(realized_pnl), 0)::numeric AS daily_pnl
       FROM positions
       WHERE user_id = $1
         AND status = 'CLOSED'
         AND ${this.executionScopeSql(broker)}
         AND updated_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'`,
      [userId]
    );
    const { rows: recentRows } = await this.fastify.pg.query(
      `SELECT realized_pnl, updated_at
       FROM positions
       WHERE user_id = $1
         AND status = 'CLOSED'
         AND realized_pnl IS NOT NULL
         AND ${this.executionScopeSql(broker)}
       ORDER BY updated_at DESC
       LIMIT 50`,
      [userId]
    );
    let consecutiveLosses = 0;
    let lastLossAt: string | null = null;
    for (const row of recentRows || []) {
      if (Number(row.realized_pnl) < 0) {
        consecutiveLosses += 1;
        if (!lastLossAt) lastLossAt = row.updated_at;
      } else {
        break;
      }
    }
    const cooldownUntil = consecutiveLosses >= maxConsecutiveLosses && lastLossAt
      ? new Date(new Date(lastLossAt).getTime() + lossCooldownMinutes * 60_000).toISOString()
      : null;
    const dailyRealizedPnl = Number(pnlRows[0]?.daily_pnl || 0);
    return {
      dailyRealizedPnl,
      maxDailyLoss,
      remainingDailyLossBudget: Math.max(0, maxDailyLoss - Math.max(0, -dailyRealizedPnl)),
      consecutiveLosses,
      maxConsecutiveLosses,
      cooldownUntil,
      maxPremiumRisk,
      maxCorrelatedPositions
    };
  }

  private async getCorrelatedOpenPositions(userId: number, symbol: string, broker: ExecutionBroker): Promise<any[]> {
    const normalized = String(symbol || '').toUpperCase();
    const correlatedSymbols = ['SPY', 'QQQ'].includes(normalized) ? ['SPY', 'QQQ'] : [normalized];
    const { rows } = await this.fastify.pg.query(
      `SELECT id, symbol, option_type, strike_price, expiration_date, status, execution_status
       FROM positions
       WHERE user_id = $1
         AND symbol = ANY($2::text[])
         AND status IN ('OPEN', 'PENDING_ORDER')
         AND ${this.executionScopeSql(broker)}
         AND COALESCE(execution_status, '') NOT IN ('PENDING_EXIT', 'PENDING_TRIM')
       ORDER BY created_at DESC`,
      [userId, correlatedSymbols]
    );
    return rows;
  }

  private async closeSupersededPositions(input: ExecuteSignalInput, settings: ExecutionSettings, broker: ExecutionBroker) {
    const { rows: signalRows } = await this.fastify.pg.query(
      'SELECT strategy_snapshot FROM signals WHERE id = $1',
      [input.signalId]
    );
    const incomingSnapshot = signalRows[0]?.strategy_snapshot || null;
    const incomingLane = incomingSnapshot ? this.strategyLane(incomingSnapshot) : null;
    const { rows: positions } = await this.fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE user_id = $1
         AND symbol = $2
         AND option_type <> $3
         AND status IN ('OPEN', 'PENDING_ORDER')
         AND ${this.executionScopeSql(broker)}
       ORDER BY created_at DESC`,
      [input.userId, input.symbol, input.winningSide]
    );
    const supersededPositions = positions.filter((position: any) => (
      !incomingLane
      || position.strategy_managed !== true
      || this.strategyLane(position.strategy_snapshot) === incomingLane
    ));

    const summary = {
      checked: supersededPositions.length,
      closed: 0,
      supersededPending: 0,
      errors: [] as string[],
      blocked: false,
      deferred: false,
      message: ''
    };

    for (const position of supersededPositions) {
      try {
        const outcome = await this.resolveSupersededPosition(position, settings, broker, input.signalId);
        if (outcome.closed) summary.closed += 1;
        if (outcome.supersededPending) summary.supersededPending += 1;
        if (outcome.deferred) summary.deferred = true;
      } catch (err: any) {
        const message = `Position #${position.id}: ${err.message || String(err)}`;
        summary.errors.push(message);
        this.fastify.log.warn(`[TradeExecutionService] Failed to close superseded ${input.symbol} ${position.option_type}: ${message}`);
      }
    }

    if (summary.errors.length > 0) {
      summary.blocked = true;
      summary.message = `Superseded ${input.symbol} order cleanup failed: ${summary.errors.join('; ')}`;
    } else if (summary.deferred) {
      summary.message = `Waiting for Wealthsimple to confirm the superseded ${input.symbol} position is closed before opening the opposite signal.`;
    }

    if (summary.closed > 0 || summary.supersededPending > 0) {
      await this.invalidateUserCaches(input.userId);
      const streamer = (this.fastify as any).ibkrMarketDataStreamer;
      if (streamer?.syncSubscriptions) {
        streamer.syncSubscriptions().catch((err: any) => {
          this.fastify.log.warn(`[TradeExecutionService] Failed to refresh stream subscriptions after superseded cleanup: ${err.message}`);
        });
      }
    }

    return summary;
  }

  private async resolveSupersededPosition(position: any, settings: ExecutionSettings, broker: ExecutionBroker, signalId: number) {
    let current = position;
    let supersededPending = false;
    const maxTransitions = TradeLifecycleService.MAX_EXIT_RETRIES + 5;

    for (let transition = 0; transition < maxTransitions; transition += 1) {
      if (!current || current.status === 'CLOSED') {
        return { closed: true, deferred: false, supersededPending };
      }

      if (current.status === 'PENDING_ORDER') {
        await this.markPendingPositionSuperseded(current, settings, broker, signalId);
        supersededPending = true;
        current = await this.getPositionById(current.id);
        continue;
      }

      const executionStatus = String(current.execution_status || '');
      if (TradeLifecycleService.isPendingExitStatus(executionStatus)) {
        const resolution = await this.waitForSupersededExitResolution(Number(current.user_id), current.id);
        if (resolution.state === 'closed') return { closed: true, deferred: false, supersededPending };
        if (resolution.state === 'pending') return { closed: false, deferred: true, supersededPending };
        current = resolution.position;
        continue;
      }

      const retry = TradeLifecycleService.isBrokerExitReviewStatus(executionStatus);
      if (retry) {
        const retryDecision = TradeLifecycleService.canAutoRetryExit(current);
        if (!retryDecision.allowed) {
          throw new Error(`Position has ${executionStatus}; ${retryDecision.reason || 'verify broker status before opening the opposite signal'}`);
        }
      }

      await this.submitSupersededExit(current, settings, broker, signalId, retry);
      const resolution = await this.waitForSupersededExitResolution(Number(current.user_id), current.id);
      if (resolution.state === 'closed') return { closed: true, deferred: false, supersededPending };
      if (resolution.state === 'pending') return { closed: false, deferred: true, supersededPending };
      current = resolution.position;
    }

    throw new Error(`Position #${position.id} did not reach a safe terminal state within the bounded reversal workflow`);
  }

  private async getPositionById(positionId: number | string) {
    const { rows } = await this.fastify.pg.query('SELECT * FROM positions WHERE id = $1', [positionId]);
    return rows[0] || null;
  }

  private async waitForSupersededExitResolution(userId: number, positionId: number | string): Promise<SupersededExitResolution> {
    let position: any = await this.getPositionById(positionId);
    if (!position) throw new Error(`Position #${positionId} disappeared before broker reconciliation`);
    if (position.status === 'CLOSED') return { state: 'closed', position };
    if (position.is_simulated || String(position.execution_broker || '') !== 'wealthsimple_snaptrade') {
      return { state: 'open', position };
    }
    for (let attempt = 0; attempt < this.SUPERSEDED_EXIT_CONFIRMATION_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const delayMs = Math.min(this.BROKER_SYNC_RETRY_BACKOFF_BASE_MS * (2 ** (attempt - 1)), 2_000);
        await this.wait(delayMs);
      }
      const verified = await this.reconcileBrokerOrdersBeforeEntry(userId);
      if (!verified) return { state: 'pending', position };
      position = await this.getPositionById(positionId);
      if (!position) throw new Error(`Position #${positionId} disappeared during broker reconciliation`);
      if (position.status === 'CLOSED') return { state: 'closed', position };
      if (TradeLifecycleService.isBrokerExitReviewStatus(position.execution_status)) return { state: 'review', position };
      if (!TradeLifecycleService.isPendingExitStatus(position.execution_status)) return { state: 'open', position };
    }
    return { state: 'pending', position };
  }

  private async markPendingPositionSuperseded(position: any, settings: ExecutionSettings, broker: ExecutionBroker, signalId: number) {
    const executionBroker = String(position.execution_broker || broker || '');

    if (!position.is_simulated && executionBroker === 'wealthsimple_snaptrade') {
      const snaptradeService = new SnaptradeService(this.fastify);
      await snaptradeService.syncPendingBrokerOrders(Number(position.user_id));
      const { rows } = await this.fastify.pg.query(
        `SELECT *
         FROM positions
         WHERE id = $1`,
        [position.id]
      );
      const refreshed = rows[0];
      if (refreshed?.status === 'OPEN') {
        await this.submitSupersededExit(refreshed, settings, broker, signalId);
        return;
      }
      if (refreshed?.status === 'CLOSED') return;
      throw new Error(`SnapTrade entry order for position #${position.id} is still pending and cannot be safely auto-cancelled by this app`);
    }

    await this.fastify.pg.query(
      `UPDATE positions
       SET status = 'CLOSED',
           execution_status = 'SUPERSEDED',
           execution_error = NULL,
           exit_reason = 'SUPERSEDED',
           notes = COALESCE(notes, '') || $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND status = 'PENDING_ORDER'`,
      [` [Pending entry superseded by Signal #${signalId}]`, position.id]
    );
  }

  private async submitSupersededExit(position: any, settings: ExecutionSettings, broker: ExecutionBroker, signalId: number, retry = false): Promise<boolean> {
    this.assertCanSubmitSupersededExit(position, retry);

    const executionBroker = String(position.execution_broker || broker || '');
    if (!position.is_simulated && executionBroker === 'wealthsimple_snaptrade') {
      const exitLock = await TradeRedisService.acquireLock(TradeRedisService.keys.exitLock(position.id));
      if (!exitLock.acquired) {
        throw new Error(`Superseded exit blocked for position #${position.id}: another exit request is already in progress`);
      }

      let acceptedOrder: { orderId?: string | null; tradeId?: string | null } | null = null;
      let submissionAttempted = false;
      try {
        const snaptradeService = new SnaptradeService(this.fastify);
        await snaptradeService.syncPendingBrokerOrders(Number(position.user_id));

        const { rows } = await this.fastify.pg.query(
          `SELECT *
           FROM positions
           WHERE id = $1`,
          [position.id]
        );
        const refreshed = rows[0];
        if (refreshed?.status === 'CLOSED') return false;
        this.assertCanSubmitSupersededExit(refreshed, retry);

        const accountId = String(refreshed.execution_account_id || refreshed.account_id || settings.snaptrade_trading_account_id || '').trim();
        if (!accountId) throw new Error('No SnapTrade account id is attached to the superseded position');

        const osiTicker = this.constructOSITicker(refreshed.symbol, Number(refreshed.strike_price), refreshed.option_type, refreshed.expiration_date);
        const exitAction = TradeLifecycleService.getExitAction(refreshed);
        submissionAttempted = true;
        const order = await snaptradeService.placeOptionOrder(
          Number(refreshed.user_id),
          accountId,
          osiTicker,
          exitAction,
          Number(refreshed.quantity || 1),
          'MARKET'
        );
        acceptedOrder = order;

        await TradeLifecycleService.markExitSubmitted(
          this.fastify.pg,
          refreshed.id,
          order,
          {
            reason: 'SUPERSEDED',
            orderType: 'MARKET',
            incrementRetry: retry,
            note: ` [Superseded by Signal #${signalId}; SnapTrade MARKET ${exitAction} exit submitted${order.orderId ? `: ${order.orderId}` : ''}]`
          }
        );
        await TradeRedisService.recordEvent(this.fastify.pg, {
          userId: Number(refreshed.user_id),
          positionId: refreshed.id,
          eventType: 'EXIT_REQUESTED',
          message: `Superseded by Signal #${signalId}; SnapTrade close submitted`,
          metadata: { orderId: order.orderId || null, tradeId: order.tradeId || null, reason: 'SUPERSEDED', action: exitAction }
        });
        await TradeRedisService.rebuildOpenTrades(this.fastify.pg, Number(refreshed.user_id), this.fastify);
        await TradeRedisService.requestBrokerSync(Number(refreshed.user_id));
        this.scheduleSnapTradePendingSync(Number(refreshed.user_id));
        return true;
      } catch (err: any) {
        if (submissionAttempted) {
          await TradeLifecycleService.markExitSubmissionFailure(
            this.fastify.pg,
            position.id,
            err.message || String(err),
            'Superseded SnapTrade exit failed',
            {
              ambiguous: Boolean(acceptedOrder) || isAmbiguousSnapTradeOrderError(err),
              orderId: acceptedOrder?.orderId || null,
              tradeId: acceptedOrder?.tradeId || null,
              requestedQuantity: Number(position.quantity || 1)
            }
          );
          await new DiscordAlertService(this.fastify).send({
            userId: Number(position.user_id),
            title: 'Superseded exit needs attention',
            message: `Position #${position.id} could not complete its reversal exit. Verify Wealthsimple before retrying: ${err.message || String(err)}`,
            severity: 'critical',
            category: 'exit-failure',
            tradeId: position.id,
            dedupeKey: `superseded-exit-failed:${position.id}:${String(err.message || err).slice(0, 120)}`,
            dedupeSeconds: 900
          });
          if (acceptedOrder || isAmbiguousSnapTradeOrderError(err)) {
            await TradeRedisService.requestBrokerSync(Number(position.user_id));
            this.scheduleSnapTradePendingSync(Number(position.user_id));
          }
        }
        throw err;
      } finally {
        await TradeRedisService.releaseLock(exitLock);
      }
    }

    const exitPrice = Number(position.current_price || position.entry_price || 0);
    const realizedPnl = TradeLifecycleService.calculateRealizedPnl(position, exitPrice, Number(position.quantity || 1));
    await this.fastify.pg.query(
      `UPDATE positions
       SET status = 'CLOSED',
           execution_status = 'SUPERSEDED',
           exit_price = $1,
           realized_pnl = $2,
           exit_reason = 'SUPERSEDED',
           notes = COALESCE(notes, '') || $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
         AND status = 'OPEN'`,
      [
        exitPrice,
        realizedPnl,
        ` [Simulated/non-live position superseded by Signal #${signalId}]`,
        position.id
      ]
    );
    return true;
  }

  private assertCanSubmitSupersededExit(position: any, retry: boolean) {
    const decision = retry
      ? TradeLifecycleService.canAutoRetryExit(position)
      : (() => {
          try {
            TradeLifecycleService.assertCanRequestExit(position);
            return { allowed: true };
          } catch (err: any) {
            return { allowed: false, reason: err.message || String(err) };
          }
        })();
    if (!decision.allowed) {
      throw new Error(`Superseded exit blocked for position #${position?.id}: ${decision.reason || 'exit is not safe to submit'}`);
    }
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async reconcileBrokerOrdersBeforeEntry(userId: number): Promise<boolean> {
    const snaptradeService = new SnaptradeService(this.fastify);
    for (let attempt = 0; attempt < this.BROKER_SYNC_ENTRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        await snaptradeService.syncPendingBrokerOrders(userId);
        return true;
      } catch (err) {
        if (!isBrokerSyncInProgressError(err)) throw err;
        if (attempt === this.BROKER_SYNC_ENTRY_MAX_ATTEMPTS - 1) return false;
        const delayMs = Math.min(this.BROKER_SYNC_RETRY_BACKOFF_BASE_MS * (2 ** attempt), 2_000);
        await this.wait(delayMs);
      }
    }
    return false;
  }

  private scheduleDeferredSignalRetry(input: ExecuteSignalInput, settings: ExecutionSettings) {
    const key = `${input.userId}:${input.signalId}`;
    const existing = TradeExecutionService.deferredSignalRetries.get(key);
    const state = existing || { startedAt: Date.now(), timer: null };
    if (state.timer) return;
    if (Date.now() - state.startedAt >= this.DEFERRED_SIGNAL_RETRY_MAX_AGE_MS) {
      TradeExecutionService.deferredSignalRetries.delete(key);
      this.fastify.log.warn(`[TradeExecutionService] Deferred reversal window expired for signal #${input.signalId}, user ${input.userId}`);
      this.markSignalExecutionFailure(
        input.userId,
        input.signalId,
        'Deferred entry retry window expired before the reversal close was confirmed',
        true,
        { riskCode: 'DEFERRED_ENTRY_EXPIRED' }
      ).catch((err: any) => {
        this.fastify.log.warn(`[TradeExecutionService] Failed to close expired deferred entry #${input.signalId}: ${err.message || String(err)}`);
      });
      return;
    }

    state.timer = setTimeout(async () => {
      state.timer = null;
      try {
        const result = await new TradeExecutionService(this.fastify).runDeferredSignalRetry(input, settings);
        if (!(result as any)?.retryable) TradeExecutionService.deferredSignalRetries.delete(key);
      } catch (err: any) {
        TradeExecutionService.deferredSignalRetries.delete(key);
        this.fastify.log.error(`[TradeExecutionService] Deferred reversal retry failed for signal #${input.signalId}, user ${input.userId}: ${err.message || String(err)}`);
      }
    }, this.DEFERRED_SIGNAL_RETRY_DELAY_MS);
    state.timer.unref?.();
    TradeExecutionService.deferredSignalRetries.set(key, state);
  }

  private async runDeferredSignalRetry(input: ExecuteSignalInput, settings: ExecutionSettings) {
    const strategyEngine = (this.fastify as any).strategyEngine;
    if (strategyEngine?.assertSignalExecutable) {
      try {
        await strategyEngine.assertSignalExecutable(input.signalId);
      } catch (err: any) {
        const message = err.message || 'The deferred setup is no longer accepting an entry';
        await this.markSignalExecutionFailure(input.userId, input.signalId, message, true, {
          riskCode: 'DEFERRED_SETUP_EXPIRED'
        });
        this.fastify.log.info(`[TradeExecutionService] Deferred reversal ended for signal #${input.signalId}: ${message}`);
        return null;
      }
    }
    return this.executeSignal(input, settings);
  }

  private async getSignalOptionDetails(signalId: number): Promise<any> {
    return (await this.getSignalExecutionContract(signalId)).optionDetails;
  }

  private async getSignalExecutionContract(signalId: number): Promise<{ engineVersion: string | null; optionDetails: any }> {
    const { rows } = await this.fastify.pg.query(
      'SELECT engine_version, option_details FROM signals WHERE id = $1',
      [signalId]
    );
    const raw = rows[0]?.option_details;
    if (!raw) return { engineVersion: rows[0]?.engine_version || null, optionDetails: {} };
    if (typeof raw === 'string') {
      try {
        return { engineVersion: rows[0]?.engine_version || null, optionDetails: JSON.parse(raw) };
      } catch {
        return { engineVersion: rows[0]?.engine_version || null, optionDetails: {} };
      }
    }
    return { engineVersion: rows[0]?.engine_version || null, optionDetails: raw };
  }

  private plannedLossForSignal(optionDetails: any, premiumRisk: number, quantity: number): number {
    const fallback = Math.max(0, premiumRisk) * this.PLANNED_LOSS_FRACTION;
    const estimatedPerContract = Number(optionDetails?.estimated_stop_risk?.per_contract_dollars);
    if (!Number.isFinite(estimatedPerContract) || estimatedPerContract <= 0 || quantity <= 0) {
      return fallback;
    }
    const plannedPremium = Number(optionDetails?.planned_limit_price || optionDetails?.mark || 0);
    const currentPerContractDebit = Math.max(0, premiumRisk) / quantity;
    const scale = plannedPremium > 0
      ? currentPerContractDebit / (plannedPremium * 100)
      : 1;
    return Math.min(
      Math.max(0, premiumRisk),
      estimatedPerContract * Math.max(0, scale) * quantity
    );
  }

  private async fetchIbkrOptionQuote(userId: number, osiTicker: string): Promise<EntryQuoteSnapshot | null> {
    const marketData = new IbkrMarketDataService(this.fastify);
    const quote = await marketData.getOptionQuoteForOsi(userId, osiTicker);
    if (!quote) return null;

    return {
      source: 'ibkr',
      ticker: osiTicker,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      mid: quote.mid,
      mark: quote.mark,
      spreadPct: quote.spreadPct,
      syntheticOnly: false,
      quoteAgeMs: quote.quoteAgeMs,
      tradeAgeMs: null,
      timestamp: quote.timestamp
    };
  }

  private async fetchEntryQuoteSnapshot(input: ExecuteSignalInput, settings: ExecutionSettings, osiTicker: string): Promise<EntryQuoteSnapshot | null> {
    try {
      const ibkrQuote = await this.fetchIbkrOptionQuote(input.userId, osiTicker);
      if (ibkrQuote) {
        this.fastify.log.info(`[TradeExecutionService] Using IBKR option quote for ${osiTicker}`);
        return ibkrQuote;
      }
    } catch (err: any) {
      this.fastify.log.warn(`[TradeExecutionService] IBKR entry quote unavailable for ${osiTicker}: ${err.message || String(err)}`);
    }

    return null;
  }

  private hasTheoreticalPricing(optionDetails: any): boolean {
    return RiskDecisionService.hasTheoreticalPricing(optionDetails);
  }

  private assertEntryQuote(input: ExecuteSignalInput, quote: EntryQuoteSnapshot, intendedEntry: number, baselineMark: number | null, movePct: number | null, stabilityMovePct: number | null) {
    const assessment = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      side: input.winningSide,
      contractLabel: this.contractLabel(input),
      quoteValidation: {
        quote,
        baselineMark,
        movePct,
        stabilityMovePct
      },
      quoteThresholds: {
        maxQuoteAgeMs: this.ENTRY_MAX_QUOTE_AGE_MS,
        maxSpreadPct: this.ENTRY_MAX_SPREAD_PCT,
        minBidToEntryRatio: this.ENTRY_MIN_BID_TO_ENTRY_RATIO
      },
      intendedEntry
    });
    if (!assessment.approved) {
      const err = new Error(assessment.denials[0]?.message || 'Entry skipped: pre-submit quote risk check denied order') as Error & { riskAssessment?: PreSubmitRiskAssessment };
      err.riskAssessment = assessment;
      throw err;
    }
  }

  private async validateEntryQuote(input: ExecuteSignalInput, settings: ExecutionSettings, osiTicker: string, plannedLimit: number | undefined): Promise<EntryQuoteValidation> {
    const optionDetails = await this.getSignalOptionDetails(input.signalId);
    const baselineMark = Number(optionDetails?.mark || input.mark || 0) > 0 ? Number(optionDetails?.mark || input.mark) : null;

    const quote = await this.fetchEntryQuoteSnapshot(input, settings, osiTicker);
    if (!quote) {
      throw new Error('Entry skipped: live option quote validation is unavailable');
    }

    const stabilityMovePct = null;
    const movePct = baselineMark ? Number((((quote.mark - baselineMark) / baselineMark) * 100).toFixed(2)) : null;
    const protectedLimit = this.calculateEntryProtectedLimit(quote, settings);
    const intendedEntry = protectedLimit || Number(plannedLimit || baselineMark || input.mark || 0);
    const effectiveIntendedEntry = intendedEntry > 0 ? intendedEntry : quote.mark;
    this.assertEntryQuote(input, quote, effectiveIntendedEntry, baselineMark, movePct, stabilityMovePct);

    return {
      quote,
      protectedLimit,
      baselineMark,
      movePct,
      stabilityMovePct
    };
  }

  private calculateEntryProtectedLimit(quote: EntryQuoteSnapshot, settings: ExecutionSettings): number {
    const configuredOffsetPct = Number(settings.entry_limit_offset_pct ?? process.env.ENTRY_LIMIT_MID_TO_ASK_OFFSET_PCT);
    const offsetPct = Number.isFinite(configuredOffsetPct)
      ? Math.min(100, Math.max(0, configuredOffsetPct))
      : this.ENTRY_LIMIT_MID_TO_ASK_OFFSET_PCT;
    const mid = quote.mid > 0 ? quote.mid : Number(((quote.bid + quote.ask) / 2).toFixed(4));
    const rawLimit = mid + (quote.ask - mid) * (offsetPct / 100);
    return Number(Math.min(quote.ask, Math.max(mid, rawLimit)).toFixed(2));
  }

  private async executeSnapTradeOptionTrade(input: ExecuteSignalInput, settings: ExecutionSettings, quantity: number) {
    const osiTicker = this.constructOSITicker(input.symbol, input.chosenStrike, input.winningSide, input.chosenExpiry);
    const optionDetails = await this.getSignalOptionDetails(input.signalId);
    const preSubmitRisk = RiskDecisionService.evaluatePreSubmit({
      signalId: input.signalId,
      broker: 'wealthsimple_snaptrade',
      side: input.winningSide,
      contractLabel: this.contractLabel(input),
      settings,
      optionDetails
    });
    if (!preSubmitRisk.approved) {
      return this.denyPreSubmitRisk(input, 'wealthsimple_snaptrade', preSubmitRisk);
    }
    const accountId = settings.snaptrade_trading_account_id!.trim();

    const slippagePct = Math.max(0, Number(settings.entry_slippage_pct || 3));
    const useLimitOrder = input.mark !== null && input.mark > 0 && (settings.order_type || 'LIMIT') === 'LIMIT';
    let limitPrice = useLimitOrder ? (input.mark! * (1 + slippagePct / 100)).toFixed(2) : undefined;
    let orderType: 'LIMIT' | 'MARKET' = useLimitOrder ? 'LIMIT' : 'MARKET';
    let entryQuoteValidation: EntryQuoteValidation | null = null;
    let acceptedBrokerOrder: { orderId?: string | null; tradeId?: string | null } | null = null;

    try {
      try {
        const validatedQuote = await this.validateEntryQuote(input, settings, osiTicker, limitPrice ? Number(limitPrice) : undefined);
        entryQuoteValidation = validatedQuote;
        limitPrice = validatedQuote.protectedLimit.toFixed(2);
        orderType = 'LIMIT';
        const strategyDebitViolation = this.getStrategyDebitPlanViolation(
          optionDetails,
          validatedQuote.protectedLimit,
          quantity
        );
        if (strategyDebitViolation) {
          await this.markSignalExecutionFailure(input.userId, input.signalId, strategyDebitViolation, true);
          return {
            success: false,
            skipped: true,
            broker: 'wealthsimple_snaptrade',
            message: strategyDebitViolation
          };
        }
        const riskState = await this.getRiskState(input.userId, settings, 'wealthsimple_snaptrade');
        const premiumRisk = validatedQuote.protectedLimit * quantity * 100;
        const plannedLoss = this.plannedLossForSignal(optionDetails, premiumRisk, quantity);
        const premiumRiskAssessment = RiskDecisionService.evaluatePreSubmit({
          signalId: input.signalId,
          broker: 'wealthsimple_snaptrade',
          side: input.winningSide,
          contractLabel: this.contractLabel(input),
          premiumRisk,
          maxPremiumRisk: riskState.maxPremiumRisk,
          plannedLoss,
          remainingDailyLossBudget: riskState.remainingDailyLossBudget
        });
        if (!premiumRiskAssessment.approved) {
          return this.denyPreSubmitRisk(input, 'wealthsimple_snaptrade', premiumRiskAssessment);
        }
      } catch (err: any) {
        const message = err.message || String(err);
        if (err.riskAssessment) {
          return this.denyPreSubmitRisk(input, 'wealthsimple_snaptrade', err.riskAssessment);
        }
        await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
        this.fastify.log.info(`[TradeExecutionService] ${message}`);
        return { success: false, skipped: true, broker: 'wealthsimple_snaptrade', message };
      }

      const strategyEngine = (this.fastify as any).strategyEngine;
      if (strategyEngine?.assertSignalExecutable) {
        try {
          await strategyEngine.assertSignalExecutable(input.signalId);
        } catch (err: any) {
          const message = err.message || 'The strategy is no longer accepting a new entry';
          await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
          return { success: false, skipped: true, broker: 'wealthsimple_snaptrade', message };
        }
      }

      const submissionClaimed = await this.claimSignalSubmission(input.userId, input.signalId, quantity);
      if (!submissionClaimed) {
        return {
          success: false,
          skipped: true,
          duplicate: true,
          broker: 'wealthsimple_snaptrade',
          message: `Signal #${input.signalId} already has a live order submission in progress`,
          riskCode: 'EXISTING_SIGNAL_EXECUTION'
        };
      }

      const snaptradeService = new SnaptradeService(this.fastify);
      const result = await snaptradeService.placeOptionOrder(
        input.userId,
        accountId,
        osiTicker,
        'BUY_TO_OPEN',
        quantity,
        orderType,
        limitPrice
      );
      acceptedBrokerOrder = result;
      await this.markSignalBrokerAccepted(input.userId, input.signalId, result.orderId || null, result.tradeId || null, quantity);
      const entryState = TradeLifecycleService.entrySubmittedStatus(orderType);
      const protectedLimitNote = orderType === 'LIMIT'
        ? ` protected LIMIT ${limitPrice || ''} pending broker reconciliation`
        : ' MARKET pending broker reconciliation';

      const position = await this.insertExecutedPosition(input, {
        quantity,
        entryPrice: entryQuoteValidation?.quote.mark || input.mark || Number(limitPrice || 1),
        isSimulated: false,
        accountId,
        executionBroker: 'wealthsimple_snaptrade',
        brokerOrderId: result.orderId || null,
        brokerTradeId: result.tradeId || null,
        executionStatus: entryState.executionStatus,
        positionStatus: 'PENDING_ORDER',
        takeProfitPct: settings.take_profit_pct,
        syntheticTrailingEnabled: settings.synthetic_trailing_stop_enabled === 'true',
        syntheticTrailingPct: settings.synthetic_trailing_stop_pct,
        notes: `[Wealthsimple/SnapTrade live trade ${result.orderId || result.tradeId || 'submitted'} from Signal #${input.signalId};${protectedLimitNote}]`
      });

      await this.recordTradeEventBestEffort({
        userId: input.userId,
        positionId: position?.id || null,
        eventType: 'ENTRY_ORDER_SUBMITTED',
        message: `Wealthsimple ${orderType} entry submitted from Signal #${input.signalId}`,
        metadata: {
          signalId: input.signalId,
          broker: 'wealthsimple_snaptrade',
          orderId: result.orderId || null,
          tradeId: result.tradeId || null,
          quantity,
          orderType,
          limitPrice: limitPrice || null,
          state: entryState.state,
          pendingExecutionStatus: entryState.executionStatus,
          protectedLimitTimeoutSeconds: Number(process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS || 180),
          entryQuoteValidation,
          setupGrade: await this.getSignalSetupGrade(input.signalId),
          contract: this.contractLabel(input),
          mark: input.mark,
          stopUnderlying: input.stopUnderlying,
          targetUnderlying: input.targetUnderlying
        }
      });
      await this.markSignalExecuted(input.userId, input.signalId, 'wealthsimple_snaptrade', result.orderId || null, result.tradeId || null, quantity, entryState.executionStatus);
      await this.invalidateUserCaches(input.userId);
      await TradeRedisService.requestBrokerSync(input.userId);
      this.scheduleSnapTradePendingSync(input.userId);
      return { success: true, broker: 'wealthsimple_snaptrade', orderId: result.orderId, tradeId: result.tradeId, quantity, executionStatus: entryState.executionStatus };
    } catch (err: any) {
      if (acceptedBrokerOrder || isAmbiguousSnapTradeOrderError(err)) {
        await this.markAmbiguousEntrySubmission(
          input,
          settings,
          quantity,
          orderType,
          entryQuoteValidation,
          err.message || String(err),
          acceptedBrokerOrder
        );
        return {
          success: false,
          broker: 'wealthsimple_snaptrade',
          reconciliationRequired: true,
          message: err.message || String(err)
        };
      } else {
        await this.markSignalExecutionFailure(input.userId, input.signalId, err.message || String(err));
      }
      throw err;
    }
  }

  private getStrategyDebitPlanViolation(optionDetails: any, protectedLimit: number, quantity: number): string | null {
    if (!optionDetails?.setupId) return null;
    const plannedLimit = Number(optionDetails.planned_limit_price || 0);
    if (plannedLimit > 0 && protectedLimit > plannedLimit + 0.005) {
      return `Live protected limit $${protectedLimit.toFixed(2)} exceeds strategy limit $${plannedLimit.toFixed(2)}`;
    }
    const maxTotalDebit = Number(optionDetails.strategy_max_total_debit_dollars || 0);
    const actualDebit = protectedLimit * quantity * 100;
    if (maxTotalDebit > 0 && actualDebit > maxTotalDebit + 0.005) {
      return `Live order debit $${actualDebit.toFixed(2)} exceeds strategy debit cap $${maxTotalDebit.toFixed(2)}`;
    }
    return null;
  }

  private async createSimulatedPosition(input: ExecuteSignalInput, quantity: number, reason: string) {
    const position = await this.insertExecutedPosition(input, {
      quantity,
      entryPrice: input.mark || 1,
      isSimulated: true,
      accountId: 'simulated',
      executionBroker: 'simulated',
      brokerOrderId: null,
      brokerTradeId: null,
      executionStatus: 'SIMULATED',
      notes: `[Simulated position from Signal #${input.signalId}: ${reason}]`
    });
    await this.recordTradeEventBestEffort({
      userId: input.userId,
      positionId: position?.id || null,
      eventType: 'ENTRY_FILLED',
      message: `Simulated entry created from Signal #${input.signalId}`,
      metadata: {
        signalId: input.signalId,
        broker: 'simulated',
        quantity,
        setupGrade: await this.getSignalSetupGrade(input.signalId),
        contract: this.contractLabel(input),
        reason
      }
    });
    await this.markSignalExecuted(input.userId, input.signalId, 'simulated', null, null, quantity);
    await this.invalidateUserCaches(input.userId);
    return { success: true, broker: 'simulated', quantity };
  }

  private async insertExecutedPosition(input: ExecuteSignalInput, execution: {
    quantity: number;
    entryPrice: number;
    isSimulated: boolean;
    accountId: string;
    executionBroker: string;
    brokerOrderId: string | null;
    brokerTradeId: string | null;
    executionStatus: string;
    positionStatus?: string;
    takeProfitPct?: string;
    syntheticTrailingEnabled?: boolean;
    syntheticTrailingPct?: string;
    notes: string;
  }) {
    const { rows: signalRows } = await this.fastify.pg.query(
      `SELECT strategy_setup_id, engine_version, lifecycle_status, policy_fingerprint,
              strategy_snapshot, option_details
       FROM signals
       WHERE id = $1`,
      [input.signalId]
    );
    const signal = signalRows[0] || {};
    const strategyManaged = signal.engine_version === 'signal-only-v2' && Boolean(signal.strategy_setup_id);
    let strategySnapshot: any = signal.strategy_snapshot || null;
    if (typeof strategySnapshot === 'string') {
      try {
        strategySnapshot = JSON.parse(strategySnapshot);
      } catch {
        strategySnapshot = null;
      }
    }
    const strategySetup = input.winningSide === 'CALL'
      ? strategySnapshot?.call_setup
      : strategySnapshot?.put_setup;
    const strategyTargets = Array.isArray(strategySetup?.targets)
      ? strategySetup.targets.map(Number).filter((value: number) => Number.isFinite(value) && value > 0)
      : [];
    const firstUnderlyingTarget = strategyManaged && strategyTargets.length > 0
      ? strategyTargets[0]
      : input.targetUnderlying;
    const finalUnderlyingTarget = input.targetUnderlying;
    const entryPrice = Math.max(Number(execution.entryPrice || input.mark || 1), 0.01);
    const strategyName = String(strategySnapshot?.strategy || '').toUpperCase();
    const familyStrategy = ['ORB_INDEX', 'VWAP_TREND'].includes(strategyName);
    const configuredStrategyStopPct = Number(strategySnapshot?.paper_policy?.premium_stop_pct);
    const premiumStopPct = familyStrategy
      && Number.isFinite(configuredStrategyStopPct)
      && configuredStrategyStopPct > 0
      && configuredStrategyStopPct < 100
      ? configuredStrategyStopPct
      : 20;
    const premiumStopLoss = Number((entryPrice * (1 - premiumStopPct / 100)).toFixed(2));
    const configuredTakeProfitPct = this.parseOptionalPct(execution.takeProfitPct, 500);
    const syntheticTrailingPct = !execution.isSimulated && execution.syntheticTrailingEnabled
      ? this.parseOptionalPct(execution.syntheticTrailingPct || '15', 50)
      : null;
    const premiumTakeProfit = configuredTakeProfitPct !== null
      && !familyStrategy
      && !(strategyManaged && syntheticTrailingPct !== null)
      ? Number((entryPrice * (1 + configuredTakeProfitPct / 100)).toFixed(2))
      : null;

    const { rows } = await this.fastify.pg.query(
      `INSERT INTO positions (
        user_id, symbol, option_type, strike_price, expiration_date,
        entry_price, quantity, stop_loss_trigger, take_profit_trigger,
        trailing_high_price, trailing_stop_loss_pct, current_price,
        status, is_simulated, account_id, notes, execution_broker,
        broker_order_id, broker_trade_id, execution_account_id, execution_status, contracts_requested,
        entry_action, exit_action,
        suggested_stop_loss, suggested_take_profit_1, suggested_take_profit_2,
        signal_id, strategy_setup_id, strategy_engine_version,
        strategy_lifecycle_status, strategy_policy_fingerprint,
        strategy_snapshot, strategy_managed,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
        $23, $24,
        $25, $26, $27,
        $28, $29, $30, $31, $32, $33, $34,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING *`,
      [
        input.userId,
        input.symbol,
        input.winningSide,
        input.chosenStrike,
        input.chosenExpiry,
        entryPrice,
        execution.quantity,
        premiumStopLoss,
        premiumTakeProfit,
        entryPrice,
        syntheticTrailingPct,
        entryPrice,
        execution.positionStatus || 'OPEN',
        execution.isSimulated,
        execution.accountId,
        `${execution.notes} [Auto exits: premium SL $${premiumStopLoss} (${premiumStopPct}%), premium TP ${premiumTakeProfit === null ? 'suggested TP only' : `$${premiumTakeProfit}`}, synthetic trail ${syntheticTrailingPct === null ? 'off' : `${syntheticTrailingPct}% after TP1`}, underlying SL ${input.stopUnderlying}, underlying TP ${input.targetUnderlying}]`,
        execution.executionBroker,
        execution.brokerOrderId,
        execution.brokerTradeId,
        execution.accountId,
        execution.executionStatus,
        execution.quantity,
        'BUY_TO_OPEN',
        'SELL_TO_CLOSE',
        input.stopUnderlying,
        firstUnderlyingTarget,
        finalUnderlyingTarget,
        input.signalId,
        signal.strategy_setup_id || null,
        signal.engine_version || null,
        signal.lifecycle_status || null,
        signal.policy_fingerprint || null,
        strategySnapshot,
        strategyManaged
      ]
    );

    const streamer = (this.fastify as any).ibkrMarketDataStreamer;
    if (streamer?.syncSubscriptions) {
      streamer.syncSubscriptions().catch((err: any) => {
        this.fastify.log.warn(`[TradeExecutionService] Failed to refresh stream subscriptions: ${err.message}`);
      });
    }

    return rows[0] || null;
  }

  private async recordTradeEventBestEffort(event: {
    userId: number;
    signalId?: number | string | null;
    positionId?: number | string | null;
    eventType: string;
    message?: string | null;
    metadata?: any;
  }) {
    try {
      await TradeRedisService.recordEvent(this.fastify.pg, event);
    } catch (err: any) {
      this.fastify.log.warn(`[TradeExecutionService] Failed to record trade event ${event.eventType}: ${err.message}`);
    }
  }

  private async claimSignalSubmission(userId: number, signalId: number, quantity: number): Promise<boolean> {
    const result = await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (
         signal_id, user_id, status, execution_broker, execution_status,
         execution_error, contracts_requested, updated_at
       ) VALUES ($1, $2, 'PENDING', 'wealthsimple_snaptrade', 'SUBMITTING', NULL, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = 'PENDING',
           execution_broker = 'wealthsimple_snaptrade',
           execution_status = 'SUBMITTING',
           execution_error = NULL,
           contracts_requested = EXCLUDED.contracts_requested,
           updated_at = CURRENT_TIMESTAMP
       WHERE signal_user_executions.broker_order_id IS NULL
         AND signal_user_executions.broker_trade_id IS NULL
         AND (
           signal_user_executions.status = 'CANCELLED'
           OR signal_user_executions.execution_status IN ('FAILED', 'SKIPPED', 'DEFERRED_ENTRY')
         )
       RETURNING signal_id`,
      [signalId, userId, quantity]
    );
    return (result.rowCount ?? result.rows?.length ?? 0) > 0;
  }

  private async markSignalExecutionDeferred(userId: number, signalId: number, broker: ExecutionBroker, message: string) {
    await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (
         signal_id, user_id, status, execution_broker, execution_status,
         execution_error, updated_at
       ) VALUES ($1, $2, 'PENDING', $3, 'DEFERRED_ENTRY', NULL, CURRENT_TIMESTAMP)
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = 'PENDING',
           execution_broker = EXCLUDED.execution_broker,
           execution_status = 'DEFERRED_ENTRY',
           execution_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE signal_user_executions.broker_order_id IS NULL
         AND signal_user_executions.broker_trade_id IS NULL
         AND signal_user_executions.status <> 'EXECUTED'`,
      [signalId, userId, broker]
    );
    await this.recordTradeEventBestEffort({
      userId,
      signalId,
      eventType: 'ENTRY_DEFERRED',
      message,
      metadata: { broker, retryable: true }
    });
  }

  private async markSignalBrokerAccepted(userId: number, signalId: number, orderId: string | null, tradeId: string | null, quantity: number): Promise<void> {
    await this.fastify.pg.query(
      `UPDATE signal_user_executions
       SET status = 'EXECUTED',
           execution_status = 'PENDING_RECONCILE',
           execution_broker = 'wealthsimple_snaptrade',
           broker_order_id = $3,
           broker_trade_id = $4,
           contracts_requested = $5,
           execution_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE signal_id = $1 AND user_id = $2 AND execution_status = 'SUBMITTING'`,
      [signalId, userId, orderId, tradeId, quantity]
    );
  }

  private async markAmbiguousEntrySubmission(
    input: ExecuteSignalInput,
    settings: ExecutionSettings,
    quantity: number,
    orderType: 'LIMIT' | 'MARKET',
    validation: EntryQuoteValidation | null,
    error: string,
    acceptedOrder: { orderId?: string | null; tradeId?: string | null } | null = null
  ): Promise<void> {
    const brokerAccepted = Boolean(acceptedOrder);
    const reconciliationMessage = brokerAccepted
      ? `Broker accepted the order but local persistence failed: ${error}`
      : `Broker submission outcome is unknown: ${error}`;
    await this.fastify.pg.query(
      `UPDATE signal_user_executions
       SET status = 'EXECUTED',
           execution_status = 'ENTRY_RECONCILE_REQUIRED',
           execution_error = $3,
           contracts_requested = $4,
           broker_order_id = COALESCE($5, broker_order_id),
           broker_trade_id = COALESCE($6, broker_trade_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE signal_id = $1 AND user_id = $2
         AND execution_status IN ('SUBMITTING', 'PENDING_RECONCILE')`,
      [input.signalId, input.userId, reconciliationMessage, quantity, acceptedOrder?.orderId || null, acceptedOrder?.tradeId || null]
    );

    let positionId: number | string | null = null;
    try {
      const existing = await this.fastify.pg.query(
        `SELECT id FROM positions
         WHERE user_id = $1 AND signal_id = $2
           AND execution_broker = 'wealthsimple_snaptrade'
           AND status IN ('PENDING_ORDER', 'OPEN')
         ORDER BY created_at DESC LIMIT 1`,
        [input.userId, input.signalId]
      );
      if (existing.rows[0]) {
        positionId = existing.rows[0].id;
        await this.fastify.pg.query(
          `UPDATE positions
           SET execution_status = 'ENTRY_RECONCILE_REQUIRED',
               execution_error = $1,
               broker_order_id = COALESCE($2, broker_order_id),
               broker_trade_id = COALESCE($3, broker_trade_id),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [reconciliationMessage, acceptedOrder?.orderId || null, acceptedOrder?.tradeId || null, positionId]
        );
      } else {
        const position = await this.insertExecutedPosition(input, {
          quantity,
          entryPrice: validation?.quote.mark || input.mark || validation?.protectedLimit || 1,
          isSimulated: false,
          accountId: String(settings.snaptrade_trading_account_id || '').trim(),
          executionBroker: 'wealthsimple_snaptrade',
          brokerOrderId: acceptedOrder?.orderId || null,
          brokerTradeId: acceptedOrder?.tradeId || null,
          executionStatus: 'ENTRY_RECONCILE_REQUIRED',
          positionStatus: 'PENDING_ORDER',
          takeProfitPct: settings.take_profit_pct,
          syntheticTrailingEnabled: settings.synthetic_trailing_stop_enabled === 'true',
          syntheticTrailingPct: settings.synthetic_trailing_stop_pct,
          notes: brokerAccepted
            ? `[Wealthsimple/SnapTrade ${orderType} entry was accepted for Signal #${input.signalId}, but local persistence failed; broker reconciliation required]`
            : `[Wealthsimple/SnapTrade ${orderType} entry response was ambiguous for Signal #${input.signalId}; broker reconciliation required before any retry]`
        });
        positionId = position?.id || null;
      }
    } catch (positionError: any) {
      this.fastify.log.error(`[TradeExecutionService] Failed to create reconciliation placeholder for Signal #${input.signalId}: ${positionError.message || String(positionError)}`);
    }

    await this.recordTradeEventBestEffort({
      userId: input.userId,
      signalId: input.signalId,
      positionId,
      eventType: 'ENTRY_RECONCILE_REQUIRED',
      message: brokerAccepted
        ? 'The broker accepted the entry, but local persistence failed; reconciliation is required.'
        : 'The broker submission outcome is unknown; do not retry until Wealthsimple reconciliation completes.',
      metadata: { error, quantity, orderType, contract: this.contractLabel(input), brokerAccepted, orderId: acceptedOrder?.orderId || null }
    });
    await new DiscordAlertService(this.fastify).send({
      userId: input.userId,
      title: 'Entry order requires broker verification',
      message: brokerAccepted
        ? `Signal #${input.signalId}: SnapTrade accepted the order, but the local position write failed. Do not retry; automatic reconciliation will use the returned broker id.`
        : `Signal #${input.signalId}: the SnapTrade response was ambiguous. Do not retry. Verify Wealthsimple while automatic reconciliation checks the exact contract, action, quantity, and submission time.`,
      severity: 'critical',
      category: 'entry-reconciliation',
      signalId: input.signalId,
      tradeId: positionId || undefined,
      dedupeKey: `signal:${input.userId}:${input.signalId}:ambiguous-entry`,
      dedupeSeconds: 3600
    });
    await TradeRedisService.requestBrokerSync(input.userId);
    this.scheduleSnapTradePendingSync(input.userId);
  }

  private async markSignalExecuted(userId: number, signalId: number, broker: string, orderId: string | null, tradeId: string | null, quantity: number, executionStatus: string = 'EXECUTED') {
    await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (
         signal_id, user_id, status, execution_broker, broker_order_id, broker_trade_id,
         execution_status, execution_error, contracts_requested, updated_at
       )
       VALUES ($1, $2, 'EXECUTED', $3, $4, $5, $6, NULL, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = 'EXECUTED',
           execution_broker = EXCLUDED.execution_broker,
           broker_order_id = EXCLUDED.broker_order_id,
           broker_trade_id = EXCLUDED.broker_trade_id,
           execution_status = EXCLUDED.execution_status,
           execution_error = NULL,
           contracts_requested = EXCLUDED.contracts_requested,
           updated_at = CURRENT_TIMESTAMP`,
      [signalId, userId, broker, orderId, tradeId, executionStatus, quantity]
    );
  }

  private async markSignalExecutionFailure(userId: number, signalId: number, error: string, skipped = false, metadata: Record<string, any> = {}) {
    const executionStatus = skipped ? 'SKIPPED' : 'FAILED';
    const status = skipped ? 'CANCELLED' : 'PENDING';

    await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (
         signal_id, user_id, status, execution_status, execution_error, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = EXCLUDED.status,
           execution_status = EXCLUDED.execution_status,
           execution_error = EXCLUDED.execution_error,
           updated_at = CURRENT_TIMESTAMP`,
      [signalId, userId, status, executionStatus, error]
    );

    await this.recordTradeEventBestEffort({
      userId,
      signalId,
      eventType: skipped ? 'EXECUTION_SKIPPED' : 'EXECUTION_FAILED',
      message: error,
      metadata: {
        executionStatus,
        skipped,
        ...metadata
      }
    });

    const severity = skipped
      ? String(error || '').includes('Daily trade limit reached') ? 'info' : 'warning'
      : 'critical';
    await new DiscordAlertService(this.fastify).send({
      userId,
      title: skipped ? 'Trade entry skipped' : 'Trade execution failed',
      message: `Signal #${signalId}: ${error}`,
      severity,
      category: skipped ? 'skipped-entry' : 'execution-failure',
      signalId,
      dedupeKey: `signal:${userId}:${signalId}:${executionStatus}:${String(error || '').slice(0, 120)}`,
      dedupeSeconds: 900
    });
  }

  private async invalidateUserCaches(userId: number) {
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);
    await TradeRedisService.rebuildOpenTrades(this.fastify.pg, userId, this.fastify);
  }

  private scheduleSnapTradePendingSync(userId: number) {
    const base = this.BROKER_SYNC_RETRY_BACKOFF_BASE_MS;
    const delays = [base, base * 2, base * 4, base * 8, base * 16, 15000];
    for (const delayMs of delays) {
      setTimeout(() => {
        const snaptradeService = new SnaptradeService(this.fastify);
        snaptradeService.syncPendingBrokerOrders(userId).catch((err: any) => {
          this.fastify.log.warn(`[TradeExecutionService] SnapTrade pending sync failed after ${delayMs}ms: ${err.message}`);
        });
      }, delayMs);
    }
  }

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : expiration.split('T')[0];
    const [year, month, day] = dateStr.split('-');
    const yy = year.slice(-2);
    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${month}${day}${side}${strikeValue}`;
  }
}
