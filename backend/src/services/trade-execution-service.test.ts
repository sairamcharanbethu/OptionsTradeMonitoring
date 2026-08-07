import '@fastify/postgres';
import { redis } from '../lib/redis';
import { TradeExecutionService } from './trade-execution-service';
import { TradeRedisService } from './trade-redis-service';
import { RiskDecisionService } from './risk-decision-service';
import { BrokerSyncInProgressError, SnaptradeService } from './snaptrade-service';
import { TradeLifecycleService } from './trade-lifecycle-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
}

function createSignalInput(overrides: Partial<any> = {}) {
  return {
    userId: 7,
    signalId: 42,
    symbol: 'QQQ',
    winningSide: 'PUT' as const,
    chosenStrike: 738,
    chosenExpiry: '2026-06-16',
    stopUnderlying: 735,
    targetUnderlying: 742,
    mark: 2,
    ...overrides
  };
}

function createEntryQuote(overrides: Partial<any> = {}) {
  return {
    source: 'ibkr',
    ticker: 'QQQ260616P00738000',
    bid: 2,
    ask: 2.08,
    last: 2.04,
    mid: 2.04,
    mark: 2.04,
    spreadPct: 3.92,
    syntheticOnly: false,
    quoteAgeMs: 1_000,
    tradeAgeMs: null,
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

async function testIBKRQuoteAllowsProtectedLimit() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();
  let quoteFetchCount = 0;

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchIbkrOptionQuote = async () => {
    quoteFetchCount += 1;
    return createEntryQuote();
  };
  (service as any).wait = async () => {};

  const validation = await (service as any).validateEntryQuote(
    input,
    {},
    'QQQ260616P00738000',
    2.05,
    '7:wealthsimple-account'
  );

  assert(validation.quote.source === 'ibkr', 'Should use IBKR quote validation');
  assert(validation.quote.syntheticOnly === false, 'Should require non-synthetic bid/ask data');
  assert(validation.protectedLimit === 2.05, `Should route protected limit 20% from mid toward ask, got ${validation.protectedLimit}`);
  assert(validation.stabilityMovePct === null, `Single live quote validation should not compute stability move, got ${validation.stabilityMovePct}`);
  assert(quoteFetchCount === 1, `Should fetch one quote for speed execution, got ${quoteFetchCount}`);
}

async function testEntryLimitOffsetIsConfigurableAndCappedAtAsk() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const quote = createEntryQuote({ bid: 2, ask: 2.10, mid: 2.05, mark: 2.05 });

  assert(service.calculateEntryProtectedLimit(quote, {}) === 2.06, 'Default 20% mid-to-ask offset should produce 2.06');
  assert(service.calculateEntryProtectedLimit(quote, { entry_limit_offset_pct: '80' }) === 2.09, '80% offset should move close to ask');
  assert(service.calculateEntryProtectedLimit(quote, { entry_limit_offset_pct: '200' }) === 2.10, 'Offset above 100 should cap at ask');
  assert(service.calculateEntryProtectedLimit(quote, { entry_limit_offset_pct: '-10' }) === 2.05, 'Negative offset should floor at mid');
}

async function testEntryValidationUsesProtectedLimitForRiskCheck() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  let intendedEntrySeen: number | null = null;

  service.getSignalOptionDetails = async () => ({ mark: 2 });
  service.fetchIbkrOptionQuote = async () => createEntryQuote({ bid: 2, ask: 2.10, mid: 2.05, mark: 2.05 });
  service.assertEntryQuote = (_input: any, _quote: any, intendedEntry: number) => {
    intendedEntrySeen = intendedEntry;
  };

  const validation = await service.validateEntryQuote(
    createSignalInput(),
    { entry_limit_offset_pct: '20' },
    'QQQ260616P00738000',
    2.50
  );

  assert(validation.protectedLimit === 2.06, `Expected protected limit 2.06, got ${validation.protectedLimit}`);
  assert(intendedEntrySeen === validation.protectedLimit, `Expected risk check to use protected limit ${validation.protectedLimit}, got ${intendedEntrySeen}`);
}

async function testSnapTradeQuoteIsNotUsedForEntryValidation() {
  const service = new TradeExecutionService(createFastifyMock());
  let snapTradeQuoteCalled = false;

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchIbkrOptionQuote = async () => null;
  (service as any).fetchSnapTradeOptionQuote = async () => {
    snapTradeQuoteCalled = true;
    throw new Error('SnapTrade quote endpoint should not be called');
  };

  const quote = await (service as any).fetchEntryQuoteSnapshot(
    createSignalInput(),
    { execution_broker: 'wealthsimple_snaptrade' },
    'QQQ260616P00738000',
    '7:wealthsimple-account'
  );

  assert(quote === null, 'Should not use SnapTrade option quotes for entry market data');
  assert(snapTradeQuoteCalled === false, 'Should not call SnapTrade option quote endpoint during entry validation');
}

async function testEntryValidationDoesNotWaitForSecondQuote() {
  const service = new TradeExecutionService(createFastifyMock());
  let quoteFetchCount = 0;
  let waited = false;

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchEntryQuoteSnapshot = async () => {
    quoteFetchCount += 1;
    return createEntryQuote({ source: 'ibkr' });
  };
  (service as any).wait = async () => {
    waited = true;
  };

  await (service as any).validateEntryQuote(
    createSignalInput(),
    {},
    'QQQ260616P00738000',
    2.05,
    '7:wealthsimple-account'
  );

  assert(quoteFetchCount === 1, `Should not run a second quote stability check, got ${quoteFetchCount} quote fetches`);
  assert(waited === false, 'Should not wait during entry quote validation');
}

async function testLiveExecutionSkipsTheoreticalPricingSignal() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();
  let failureMarked = false;
  let quoteValidated = false;

  (service as any).getSignalOptionDetails = async () => ({
    usingTheoreticalPricing: true,
    decision: {
      quote: {
        usingTheoreticalPricing: true
      },
      grade: {
        pricingWarnings: ['Using theoretical option price fallback']
      }
    }
  });
  (service as any).markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string, skipped: boolean) => {
    failureMarked = skipped && message.includes('theoretical option pricing');
  };
  (service as any).validateEntryQuote = async () => {
    quoteValidated = true;
    return {};
  };

  const result = await (service as any).executeSnapTradeOptionTrade(input, {
    live_trading_acknowledged: 'true',
    snaptrade_trading_account_id: '7:wealthsimple-account',
    order_type: 'LIMIT',
    entry_slippage_pct: '3'
  }, 1);

  assert(result.skipped === true, 'Theoretical pricing signal should be skipped');
  assert(failureMarked, 'Should mark theoretical pricing entry as skipped failure');
  assert(quoteValidated === false, 'Should skip before live quote validation or order placement');
}

async function testLiveExecutionSkipsLowExecutionRealismSignal() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();
  let failureMarked = false;
  let quoteValidated = false;

  (service as any).getSignalOptionDetails = async () => ({
    decision: {
      quote: {
        usingTheoreticalPricing: false
      },
      grade: {
        pricingWarnings: ['Spread 18% exceeds ceiling 12%'],
        executionRealism: {
          score: 55,
          executable: false,
          threshold: 70,
          reasons: ['Bid/ask spread 18% is very wide']
        }
      }
    }
  });
  (service as any).markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string, skipped: boolean) => {
    failureMarked = skipped && message.includes('execution realism score 55');
  };
  (service as any).validateEntryQuote = async () => {
    quoteValidated = true;
    return {};
  };

  const result = await (service as any).executeSnapTradeOptionTrade(input, {
    live_trading_acknowledged: 'true',
    snaptrade_trading_account_id: '7:wealthsimple-account',
    order_type: 'LIMIT',
    entry_slippage_pct: '3'
  }, 1);

  assert(result.skipped === true, 'Low execution realism signal should be skipped');
  assert(failureMarked, 'Should mark low execution realism entry as skipped failure');
  assert(quoteValidated === false, 'Should skip before live quote validation or order placement');
}

async function testTheoreticalPricingDetectionCoversStoredShapes() {
  const service = new TradeExecutionService(createFastifyMock());

  assert((service as any).hasTheoreticalPricing({ usingTheoreticalPricing: true }), 'Should detect camelCase theoretical flag');
  assert((service as any).hasTheoreticalPricing({ using_theoretical_pricing: true }), 'Should detect snake_case theoretical flag');
  assert((service as any).hasTheoreticalPricing({ decision: { quote: { usingTheoreticalPricing: true } } }), 'Should detect decision quote theoretical flag');
  assert((service as any).hasTheoreticalPricing({ gradeDiagnostics: { pricingWarnings: ['Using theoretical option price fallback'] } }), 'Should detect grade pricing warning');
  assert((service as any).hasTheoreticalPricing({ decision: { grade: { pricingWarnings: ['Using theoretical option price fallback'] } } }), 'Should detect decision grade pricing warning');
  assert(!(service as any).hasTheoreticalPricing({ decision: { quote: { usingTheoreticalPricing: false }, grade: { pricingWarnings: [] } } }), 'Should not flag clean decision');
}

async function testRiskDecisionServiceCentralizesPreTradeBlocks() {
  const existing = RiskDecisionService.forExistingSignalExecution(42, {
    execution_status: 'PENDING',
    broker_order_id: null,
    status: 'PENDING'
  });
  const submitting = RiskDecisionService.forExistingSignalExecution(42, {
    execution_status: 'SUBMITTING',
    broker_order_id: null,
    status: 'PENDING'
  });
  const pendingReconcile = RiskDecisionService.forExistingSignalExecution(42, {
    execution_status: 'PENDING_RECONCILE',
    broker_order_id: null,
    status: 'EXECUTED'
  });
  const grade = RiskDecisionService.forSetupGrade(42, 'B / LOTTO');
  const duplicate = RiskDecisionService.forDuplicateOpenEntry('QQQ 2026-06-16 PUT 738', {
    id: 679,
    status: 'OPEN',
    execution_status: 'PENDING',
    strategy_managed: false
  });
  const dailyLimit = RiskDecisionService.forDailyTradeLimit(3, 3);
  const dailyLoss = RiskDecisionService.forDailyLossLimit(-250, 200);
  const cooldown = RiskDecisionService.forConsecutiveLosses(3, 3, new Date(Date.now() + 60_000).toISOString());
  const premiumRisk = RiskDecisionService.forPremiumRisk(600, 500);
  const plannedLoss = RiskDecisionService.forPlannedLoss(90, 75);
  const correlated = RiskDecisionService.forCorrelatedExposure(1, 1, 'SPY/QQQ', [{
    id: 679,
    symbol: 'SPY',
    strike_price: 769,
    option_type: 'CALL',
    expiration_date: '2026-08-04',
    status: 'OPEN',
    execution_status: 'EXIT_RECONCILE_REQUIRED'
  }]);
  const executionRealism = RiskDecisionService.forExecutionRealism({
    decision: {
      grade: {
        executionRealism: {
          score: 55,
          executable: false,
          threshold: 70,
          reasons: ['Bid/ask spread 18% is very wide']
        }
      }
    }
  });
  const theoretical = RiskDecisionService.forTheoreticalPricing({
    decision: {
      quote: { usingTheoreticalPricing: true },
      grade: { pricingWarnings: [] }
    }
  });
  const liveAck = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    settings: { live_trading_acknowledged: 'false', snaptrade_trading_account_id: 'acct-1' }
  });
  const account = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: '' }
  });
  const staleQuote = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: 'acct-1' },
    quoteValidation: { quote: createEntryQuote({ quoteAgeMs: 5_000 }), baselineMark: 2, movePct: 2, stabilityMovePct: 0 },
    quoteThresholds: { maxQuoteAgeMs: 2_000, maxSpreadPct: 15, minBidToEntryRatio: 0.9 },
    intendedEntry: 2.05
  });
  const missingQuoteAge = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    quoteValidation: { quote: createEntryQuote({ quoteAgeMs: null }), baselineMark: 2, movePct: 2, stabilityMovePct: 0 },
    quoteThresholds: { maxQuoteAgeMs: 2_000, maxSpreadPct: 15, minBidToEntryRatio: 0.9 },
    intendedEntry: 2.05
  });
  const missingBidAsk = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: 'acct-1' },
    quoteValidation: { quote: createEntryQuote({ bid: 0, ask: 0, spreadPct: null }), baselineMark: 2, movePct: 2, stabilityMovePct: 0 },
    quoteThresholds: { maxQuoteAgeMs: 2_000, maxSpreadPct: 15, minBidToEntryRatio: 0.9 },
    intendedEntry: 2.05
  });
  const wideSpread = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: 'acct-1' },
    quoteValidation: { quote: createEntryQuote({ spreadPct: 18 }), baselineMark: 2, movePct: 2, stabilityMovePct: 0 },
    quoteThresholds: { maxQuoteAgeMs: 2_000, maxSpreadPct: 15, minBidToEntryRatio: 0.9 },
    intendedEntry: 2.05
  });
  const premiumJump = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: 'acct-1' },
    quoteValidation: { quote: createEntryQuote({ mark: 2.4 }), baselineMark: 2, movePct: 20, stabilityMovePct: 0 },
    quoteThresholds: { maxQuoteAgeMs: 2_000, maxSpreadPct: 15, minBidToEntryRatio: 0.9 },
    intendedEntry: 2.05
  });
  const macro = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    side: 'PUT',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: 'acct-1' },
    optionDetails: {
      risk_flags: { macroSupportsSignal: false },
      decisionSnapshot: {
        macroSnapshot: {
          macroRegime: { directionBias: 'CALL' }
        }
      }
    }
  });
  const clean = RiskDecisionService.evaluatePreSubmit({
    signalId: 42,
    broker: 'wealthsimple_snaptrade',
    side: 'PUT',
    settings: { live_trading_acknowledged: 'true', snaptrade_trading_account_id: 'acct-1' },
    setupGrade: 'A',
    currentTradeCount: 1,
    maxTradesPerDay: 3,
    duplicateOpenEntry: null,
    optionDetails: {
      decision: {
        quote: { usingTheoreticalPricing: false },
        grade: {
          pricingWarnings: [],
          executionRealism: { score: 85, executable: true, threshold: 70 }
        }
      }
    },
    quoteValidation: { quote: createEntryQuote(), baselineMark: 2, movePct: 2, stabilityMovePct: 0 },
    quoteThresholds: { maxQuoteAgeMs: 2_000, maxSpreadPct: 15, minBidToEntryRatio: 0.9 },
    intendedEntry: 2.05
  });

  assert(existing.allowed === false && existing.code === 'EXISTING_SIGNAL_EXECUTION', 'Should block existing signal execution');
  assert(submitting.allowed === false, 'A durable pre-broker submission claim must block duplicate execution');
  assert(pendingReconcile.allowed === false, 'A broker-accepted order awaiting reconciliation must block duplicate execution');
  assert(RiskDecisionService.forExistingSignalExecution(42, { status: 'PENDING', execution_status: 'DEFERRED_ENTRY' }).allowed,
    'A deferred reversal without a broker order must remain eligible for guarded retry');
  assert(grade.allowed === false && grade.code === 'SETUP_GRADE_NOT_EXECUTABLE', 'Should block non-executable setup grade');
  assert(duplicate.allowed === false && duplicate.metadata?.duplicatePositionId === 679, 'Should block duplicate open entry with metadata');
  assert(duplicate.message.includes('manual position #679') && duplicate.message.includes('not linked'), 'A matching manual position should stay separate from the autonomous setup');
  assert(dailyLimit.allowed === false && dailyLimit.code === 'DAILY_TRADE_LIMIT', 'Should block daily trade limit');
  assert(dailyLoss.allowed === false && dailyLoss.code === 'DAILY_LOSS_LIMIT', 'Should block daily loss limit');
  assert(cooldown.allowed === false && cooldown.code === 'CONSECUTIVE_LOSS_COOLDOWN', 'Should block consecutive-loss cooldown');
  assert(premiumRisk.allowed === false && premiumRisk.code === 'PREMIUM_RISK_LIMIT', 'Should block premium risk limit');
  assert(plannedLoss.allowed === false && plannedLoss.code === 'PLANNED_LOSS_LIMIT', 'Should block planned loss above the remaining daily budget');
  assert(RiskDecisionService.forPlannedLoss(75, 75).allowed === true, 'Should allow planned loss at the remaining daily budget');
  assert(correlated.allowed === false && correlated.code === 'CORRELATED_EXPOSURE_LIMIT', 'Should block correlated exposure');
  assert(correlated.message.includes('#679 SPY 769 CALL 2026-08-04') && correlated.message.includes('broker review'), 'Correlated exposure denial must identify the counted position and reconciliation requirement');
  assert(executionRealism.allowed === false && executionRealism.code === 'EXECUTION_REALISM_TOO_LOW', 'Should block low execution realism');
  assert(theoretical.allowed === false && theoretical.code === 'THEORETICAL_PRICING', 'Should block theoretical pricing');
  assert(liveAck.denials[0]?.code === 'LIVE_TRADING_NOT_ACKNOWLEDGED', 'Should block missing live acknowledgement');
  assert(account.denials[0]?.code === 'ACCOUNT_NOT_SELECTED', 'Should block missing trading account');
  assert(staleQuote.denials[0]?.code === 'STALE_QUOTE', 'Should block stale option quote');
  assert(missingQuoteAge.denials[0]?.code === 'STALE_QUOTE', 'Should block an option quote without a provider age');
  assert(missingBidAsk.denials[0]?.code === 'MISSING_BID_ASK', 'Should block missing bid/ask');
  assert(wideSpread.denials[0]?.code === 'SPREAD_TOO_WIDE', 'Should block wide spread');
  assert(premiumJump.approved === true && premiumJump.evidence.movePct === 20, 'Premium jump should remain evidence, not block momentum entry');
  assert(macro.denials[0]?.code === 'MACRO_CONTRADICTION', 'Should block macro contradiction');
  assert(clean.approved === true && clean.denials.length === 0, `Clean pre-submit risk should approve, got ${JSON.stringify(clean.denials)}`);
  assert(RiskDecisionService.forSetupGrade(42, 'A+ / FULL').allowed === true, 'Should allow A+ setup grade');
  assert(RiskDecisionService.forDailyTradeLimit(2, 3).allowed === true, 'Should allow under daily trade limit');
  assert(RiskDecisionService.forExecutionRealism({ decision: { grade: { executionRealism: { score: 80, executable: true, threshold: 70 } } } }).allowed === true, 'Should allow sufficient execution realism');
}

async function testShadowModeNeverResolvesToLiveBroker() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  assert(service.resolveBroker({ shadow_trading_enabled: 'true', snaptrade_auto_trade: 'true', execution_broker: 'wealthsimple_snaptrade' }) === 'simulated', 'Shadow mode should override live broker resolution');
  assert(service.resolveBroker({ snaptrade_auto_trade: 'true', execution_broker: 'none' }) === 'none', 'Explicit broker none must remain a live-trading kill switch');
  assert(service.executionScopeSql('wealthsimple_snaptrade').includes("is_simulated, FALSE) = FALSE"), 'Live risk scope must exclude simulated positions');
  assert(service.executionScopeSql('simulated').includes("is_simulated, FALSE) = TRUE"), 'Shadow risk scope must exclude live positions');
}

async function testDuplicateSignalPreservesExecutedRecord() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  let failureMarked = false;
  service.getSignalExecutionContract = async () => ({ engineVersion: null, optionDetails: {} });
  service.getRiskState = async () => ({
    dailyRealizedPnl: 0,
    maxDailyLoss: 200,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 3,
    cooldownUntil: null,
    maxPremiumRisk: 500,
    maxCorrelatedPositions: 1
  });
  service.getExistingSignalExecution = async () => ({
    status: 'EXECUTED',
    execution_status: 'PENDING_RECONCILE',
    broker_order_id: 'broker-order-1'
  });
  service.markSignalExecutionFailure = async () => { failureMarked = true; };

  const result = await service.executeSignal(createSignalInput(), {
    execution_broker: 'wealthsimple_snaptrade',
    snaptrade_auto_trade: 'true',
    contracts_per_trade: '1'
  });
  assert(result.duplicate === true && result.riskCode === 'EXISTING_SIGNAL_EXECUTION', 'Duplicate signal execution should return the preserved canonical state');
  assert(failureMarked === false, 'Duplicate execution must not overwrite an executed signal with a failure or cancellation');
}

async function testDurableSubmissionClaim() {
  let claimSql = '';
  let claimParams: any[] = [];
  const service = new TradeExecutionService({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params: any[] = []) => {
        claimSql = sql;
        claimParams = params;
        return { rows: [{ signal_id: 42 }], rowCount: 1 };
      }
    }
  } as any) as any;

  const claimed = await service.claimSignalSubmission(7, 42, 1);
  assert(claimed === true, 'A new live submission should acquire its durable database claim');
  assert(claimSql.includes("'SUBMITTING'"), 'The durable claim must be written before the external broker call');
  assert(claimSql.includes('broker_order_id IS NULL'), 'A claim retry must never overwrite a broker-identified order');
  assert(claimSql.includes("'DEFERRED_ENTRY'"), 'A broker-confirmed reversal retry must be able to transition from deferred state to submission claim');
  assert(JSON.stringify(claimParams) === JSON.stringify([42, 7, 1]), `Unexpected submission claim parameters: ${JSON.stringify(claimParams)}`);
}

async function testDeferredExecutionStateClearsStaleBrokerReview() {
  let sql = '';
  let params: any[] = [];
  const service = new TradeExecutionService({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (query: string, values: any[] = []) => {
        sql = query;
        params = values;
        return { rows: [], rowCount: 1 };
      }
    }
  } as any) as any;
  service.recordTradeEventBestEffort = async () => {};

  await service.markSignalExecutionDeferred(7, 42, 'wealthsimple_snaptrade', 'Waiting for broker-confirmed close');
  assert(sql.includes("execution_status = 'DEFERRED_ENTRY'"), 'Deferred reversal should have a non-terminal execution status');
  assert(sql.includes('execution_error = NULL'), 'Deferred reversal should clear the stale broker-review error');
  assert(sql.includes('broker_order_id IS NULL') && sql.includes('broker_trade_id IS NULL'), 'Deferred state must never overwrite a broker-identified entry');
  assert(JSON.stringify(params) === JSON.stringify([42, 7, 'wealthsimple_snaptrade']), `Unexpected deferred execution params: ${JSON.stringify(params)}`);
}

async function testStrategyPlanCapsConfiguredQuantity() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  let simulatedQuantity = 0;
  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  (TradeRedisService as any).acquireLock = async () => ({ acquired: true, token: 'plan-lock' });
  (TradeRedisService as any).releaseLock = async () => {};
  try {
    service.getSignalExecutionContract = async () => ({
      engineVersion: 'signal-only-v2',
      optionDetails: { planned_contracts: 2 }
    });
    service.getRiskState = async () => ({
      dailyRealizedPnl: 0,
      maxDailyLoss: 200,
      consecutiveLosses: 0,
      maxConsecutiveLosses: 3,
      cooldownUntil: null,
      maxPremiumRisk: 500,
      maxCorrelatedPositions: 1
    });
    service.getExistingSignalExecution = async () => null;
    service.getSignalSetupGrade = async () => 'A+';
    service.findDuplicateOpenEntry = async () => null;
    service.closeSupersededPositions = async () => ({ blocked: false, checked: 0, closed: 0, supersededPending: 0, errors: [], message: '' });
    service.getCorrelatedOpenPositions = async () => [];
    service.countTradesToday = async () => 0;
    service.createSimulatedPosition = async (_input: any, quantity: number) => {
      simulatedQuantity = quantity;
      return { success: true, broker: 'simulated', quantity };
    };

    await service.executeSignal(createSignalInput(), {
      execution_broker: 'none',
      contracts_per_trade: '5',
      max_trades_per_day: '2'
    });
    assert(simulatedQuantity === 2, `Strategy plan should cap configured quantity at 2, got ${simulatedQuantity}`);
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
  }
}

async function testStrategyDebitPlanUsesSubmittedLimit() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const details = {
    setupId: 'strategy-setup',
    planned_limit_price: 2.05,
    strategy_max_total_debit_dollars: 410
  };
  assert(
    service.getStrategyDebitPlanViolation(details, 2.05, 2) === null,
    'Order at the planned limit and debit cap should pass'
  );
  assert(
    service.getStrategyDebitPlanViolation(details, 2.06, 2)?.includes('exceeds strategy limit'),
    'Submitted protected limit above the strategy limit must be blocked'
  );
  assert(
    service.getStrategyDebitPlanViolation({ ...details, planned_limit_price: 3 }, 2.06, 2)?.includes('exceeds strategy debit cap'),
    'Submitted protected-limit debit above the strategy cap must be blocked'
  );
}

async function testPreSubmitRiskDenialSkipsBeforeBrokerPath() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();
  let failureMetadata: any = null;
  let quoteValidated = false;

  (service as any).getSignalOptionDetails = async () => ({
    decision: {
      quote: { usingTheoreticalPricing: false },
      grade: { pricingWarnings: [] }
    }
  });
  (service as any).validateEntryQuote = async () => {
    quoteValidated = true;
    throw new Error('Quote validation should not run after live acknowledgement denial');
  };
  (service as any).markSignalExecutionFailure = async (_userId: number, _signalId: number, _message: string, skipped: boolean, metadata: any) => {
    failureMetadata = { skipped, metadata };
  };

  const result = await (service as any).executeSnapTradeOptionTrade(input, {
    live_trading_acknowledged: 'false',
    snaptrade_trading_account_id: '7:wealthsimple-account',
    order_type: 'LIMIT',
    entry_slippage_pct: '3'
  }, 1);

  assert(result.skipped === true, 'Risk denial should be skipped');
  assert(result.riskCode === 'LIVE_TRADING_NOT_ACKNOWLEDGED', `Expected live acknowledgement risk code, got ${result.riskCode}`);
  assert(quoteValidated === false, 'Quote validation should not run after pre-submit risk denial');
  assert(failureMetadata?.metadata?.riskCode === 'LIVE_TRADING_NOT_ACKNOWLEDGED', 'Risk code should be recorded in failure metadata');
}

async function testDuplicateOpenEntrySkipsBeforeOrderLifecycle() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();
  let failureMarked = false;
  let closeSupersededCalled = false;
  let simulatedPositionCreated = false;
  let lockReleased = false;

  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  (TradeRedisService as any).acquireLock = async () => ({ acquired: true, token: 'test-lock' });
  (TradeRedisService as any).releaseLock = async () => {
    lockReleased = true;
  };

  try {
    (service as any).getExistingSignalExecution = async () => null;
    (service as any).getSignalSetupGrade = async () => 'A';
    (service as any).findDuplicateOpenEntry = async () => ({
      id: 679,
      status: 'OPEN',
      execution_status: 'PENDING',
      broker_order_id: 'order-existing',
      strategy_managed: false
    });
    (service as any).markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string, skipped: boolean) => {
      failureMarked = skipped && message.includes('manual position #679') && message.includes('not linked');
    };
    (service as any).closeSupersededPositions = async () => {
      closeSupersededCalled = true;
      return { blocked: false, closed: 0, message: 'noop' };
    };
    (service as any).createSimulatedPosition = async () => {
      simulatedPositionCreated = true;
      return { success: true };
    };

    const result: any = await service.executeSignal(input, {
      execution_broker: 'none',
      contracts_per_trade: '2',
      max_trades_per_day: '2'
    });

    assert(result.skipped === true, 'Duplicate open entry should be skipped');
    assert(result.duplicatePositionId === 679, 'Should return duplicate position id');
    assert(failureMarked, 'Should mark duplicate entry as skipped execution failure');
    assert(closeSupersededCalled === false, 'Should not close superseded positions after duplicate detection');
    assert(simulatedPositionCreated === false, 'Should not create a simulated position after duplicate detection');
    assert(lockReleased, 'Should release entry lock after duplicate skip');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
  }
}

async function testStrategyManagedSyntheticTrailUsesStrategyTargets() {
  let insertParams: any[] = [];
  const service = new TradeExecutionService({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes('FROM signals')) {
          return {
            rows: [{
              strategy_setup_id: 'setup-42',
              engine_version: 'signal-only-v2',
              lifecycle_status: 'ACTIVE',
              strategy_snapshot: {
                put_setup: { targets: [740, 738] }
              }
            }]
          };
        }
        if (sql.includes('INSERT INTO positions')) {
          insertParams = params;
          return { rows: [{ id: 9001 }] };
        }
        return { rows: [] };
      }
    }
  } as any);

  await (service as any).insertExecutedPosition(createSignalInput({ mark: 0.49, targetUnderlying: 738 }), {
    quantity: 1,
    entryPrice: 0.49,
    isSimulated: false,
    accountId: '7:wealthsimple-account',
    executionBroker: 'wealthsimple_snaptrade',
    brokerOrderId: 'order-42',
    brokerTradeId: null,
    executionStatus: 'PENDING_RECONCILE',
    positionStatus: 'PENDING_ORDER',
    takeProfitPct: '10',
    syntheticTrailingEnabled: true,
    syntheticTrailingPct: '15',
    notes: '[test entry]'
  });

  assert(insertParams[8] === null, `A strategy synthetic trail should leave the fixed premium take-profit unset, got ${insertParams[8]}`);
  assert(insertParams[10] === 15, `A live synthetic trail should freeze 15% on the position, got ${insertParams[10]}`);
  assert(insertParams[25] === 740, `The first strategy target must be stored as TP1, got ${insertParams[25]}`);
  assert(insertParams[26] === 738, `The final strategy target must be stored as TP2, got ${insertParams[26]}`);
  assert(insertParams[33] === true, 'The strategy position must remain marked as strategy-managed');
}

async function testLiveEntryUsesCorrelatedExposureLockAndFailsClosed() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  let lockKey = '';
  let lockTtl = 0;
  let failureMessage = '';
  const originalAcquireLock = (TradeRedisService as any).acquireLock;
  try {
    (TradeRedisService as any).acquireLock = async (key: string, ttl: number) => {
      lockKey = key;
      lockTtl = ttl;
      return { acquired: true, degraded: true, key, token: 'degraded' };
    };
    service.getSignalExecutionContract = async () => ({ engineVersion: 'signal-only-v2', optionDetails: { planned_contracts: 1 } });
    service.getRiskState = async () => ({ maxCorrelatedPositions: 1 });
    service.getExistingSignalExecution = async () => null;
    service.getSignalSetupGrade = async () => 'A+';
    service.markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string) => { failureMessage = message; };

    const result = await service.executeSignal(createSignalInput({ symbol: 'SPY' }), {
      execution_broker: 'wealthsimple_snaptrade',
      snaptrade_auto_trade: 'true',
      live_trading_acknowledged: 'true',
      snaptrade_trading_account_id: '7:account',
      contracts_per_trade: '1'
    });
    assert(lockKey.includes('entry-exposure:7:wealthsimple_snaptrade:SPY-QQQ'), `Expected correlated exposure lock, got ${lockKey}`);
    assert(lockTtl === 120, `Live exposure lock must cover broker round trips, got ${lockTtl}s`);
    assert(result.skipped === true && failureMessage.includes('lock is unavailable'), 'A live entry must fail closed when Redis locking is unavailable');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
  }
}

async function testDeferredEntryLockCollisionReschedulesWithoutConsumingSignal() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const originalAcquireLock = TradeRedisService.acquireLock;
  let retryQueued = false;
  let failureMarked = false;
  try {
    (TradeRedisService as any).acquireLock = async () => ({ acquired: false, key: 'entry-lock', token: 'token' });
    service.getSignalExecutionContract = async () => ({ engineVersion: 'signal-only-v2', optionDetails: { planned_contracts: 1 } });
    service.getRiskState = async () => ({ maxCorrelatedPositions: 1 });
    service.getExistingSignalExecution = async () => ({ status: 'PENDING', execution_status: 'DEFERRED_ENTRY' });
    service.getSignalSetupGrade = async () => 'A+';
    service.scheduleDeferredSignalRetry = () => { retryQueued = true; };
    service.markSignalExecutionFailure = async () => { failureMarked = true; };

    const result = await service.executeSignal(createSignalInput({ symbol: 'SPY' }), {
      execution_broker: 'wealthsimple_snaptrade',
      snaptrade_auto_trade: 'true',
      live_trading_acknowledged: 'true',
      snaptrade_trading_account_id: '7:account',
      contracts_per_trade: '1'
    });

    assert(result.retryable === true && result.riskCode === 'ENTRY_LOCK_BUSY', 'A deferred retry should wait through its prior entry-lock release');
    assert(retryQueued, 'A deferred entry-lock collision should schedule another guarded evaluation');
    assert(failureMarked === false, 'A queued retry must not be consumed as a duplicate skipped entry');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
  }
}

async function testEntryWaitsForOverlappingBrokerSync() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const originalSync = SnaptradeService.prototype.syncPendingBrokerOrders;
  let attempts = 0;
  let waits = 0;
  try {
    SnaptradeService.prototype.syncPendingBrokerOrders = async () => {
      attempts += 1;
      if (attempts === 1) throw new BrokerSyncInProgressError();
      return { success: true } as any;
    };
    service.wait = async () => { waits += 1; };

    const verified = await service.reconcileBrokerOrdersBeforeEntry(7);
    assert(verified === true, 'Entry should continue after the overlapping broker sync finishes');
    assert(attempts === 2 && waits === 1, `Expected one bounded wait and retry, got ${attempts} attempts and ${waits} waits`);
  } finally {
    SnaptradeService.prototype.syncPendingBrokerOrders = originalSync;
  }
}

async function testEntryWaitsThroughBrokerSyncLockLifetime() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const originalSync = SnaptradeService.prototype.syncPendingBrokerOrders;
  let attempts = 0;
  let waitedMs = 0;
  try {
    SnaptradeService.prototype.syncPendingBrokerOrders = async () => {
      attempts += 1;
      throw new BrokerSyncInProgressError();
    };
    service.wait = async (delayMs: number) => { waitedMs += delayMs; };

    const verified = await service.reconcileBrokerOrdersBeforeEntry(7);
    assert(verified === false, 'Entry should remain deferred when another process retains reconciliation ownership');
    assert(attempts === 13, `Expected 13 guarded reconciliation attempts, got ${attempts}`);
    assert(waitedMs === 21_500, `Retry window must cover the 20-second broker lock lifetime, got ${waitedMs}ms`);
  } finally {
    SnaptradeService.prototype.syncPendingBrokerOrders = originalSync;
  }
}

async function testBusyBrokerSyncDefersWithoutConsumingSignal() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  let failureMarked = false;
  let lockReleased = false;
  try {
    (TradeRedisService as any).acquireLock = async () => ({ acquired: true, key: 'entry-lock', token: 'token' });
    (TradeRedisService as any).releaseLock = async () => { lockReleased = true; };
    service.getSignalExecutionContract = async () => ({ engineVersion: 'signal-only-v2', optionDetails: { planned_contracts: 1 } });
    service.getRiskState = async () => ({ maxCorrelatedPositions: 1 });
    service.getExistingSignalExecution = async () => null;
    service.getSignalSetupGrade = async () => 'A+';
    service.reconcileBrokerOrdersBeforeEntry = async () => false;
    service.markSignalExecutionFailure = async () => { failureMarked = true; };

    const result = await service.executeSignal(createSignalInput({ symbol: 'SPY' }), {
      execution_broker: 'wealthsimple_snaptrade',
      snaptrade_auto_trade: 'true',
      live_trading_acknowledged: 'true',
      snaptrade_trading_account_id: '7:account',
      contracts_per_trade: '1'
    });

    assert(result.retryable === true && result.riskCode === 'BROKER_SYNC_DEFERRED', 'Lock contention should leave the active setup eligible for a later retry');
    assert(failureMarked === false, 'A busy reconciliation must not write FAILED or CANCELLED execution state');
    assert(lockReleased, 'The entry exposure lock must be released after deferring');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
  }
}

async function testGenuineBrokerSyncFailureStillRequiresReview() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  const failure: { recorded?: { message: string; skipped: boolean } } = {};
  try {
    (TradeRedisService as any).acquireLock = async () => ({ acquired: true, key: 'entry-lock', token: 'token' });
    (TradeRedisService as any).releaseLock = async () => {};
    service.getSignalExecutionContract = async () => ({ engineVersion: 'signal-only-v2', optionDetails: { planned_contracts: 1 } });
    service.getRiskState = async () => ({ maxCorrelatedPositions: 1 });
    service.getExistingSignalExecution = async () => null;
    service.getSignalSetupGrade = async () => 'A+';
    service.reconcileBrokerOrdersBeforeEntry = async () => { throw new Error('SnapTrade credentials are invalid'); };
    service.markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string, skipped: boolean) => {
      failure.recorded = { message, skipped: Boolean(skipped) };
    };

    const result = await service.executeSignal(createSignalInput({ symbol: 'SPY' }), {
      execution_broker: 'wealthsimple_snaptrade',
      snaptrade_auto_trade: 'true',
      live_trading_acknowledged: 'true',
      snaptrade_trading_account_id: '7:account',
      contracts_per_trade: '1'
    });

    assert(result.success === false && result.retryable !== true, 'A genuine reconciliation failure must not be treated as transient contention');
    assert(failure.recorded?.skipped === false && failure.recorded.message.includes('credentials are invalid'), 'A genuine reconciliation failure must retain broker-review state');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
  }
}

async function testSupersededRejectedExitRetriesOnlyAfterBrokerConfirmation() {
  const position = {
    id: 732,
    user_id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    broker_exit_order_id: 'exit-order-732',
    last_broker_order_status: 'REJECTED',
    last_broker_sync_at: new Date().toISOString(),
    exit_retry_count: 0,
    execution_broker: 'wealthsimple_snaptrade',
    is_simulated: false
  };
  const service = new TradeExecutionService({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: { query: async () => ({ rows: [position] }) }
  } as any) as any;
  let retryRequested = false;
  service.submitSupersededExit = async (_position: any, _settings: any, _broker: any, _signalId: number, retry: boolean) => {
    retryRequested = retry;
    return true;
  };
  service.waitForSupersededExitResolution = async () => ({ state: 'closed', position: { ...position, status: 'CLOSED' } });
  service.invalidateUserCaches = async () => {};

  const summary = await service.closeSupersededPositions(
    createSignalInput({ symbol: 'SPY', winningSide: 'PUT' }),
    {},
    'wealthsimple_snaptrade'
  );

  assert(retryRequested, 'A freshly broker-confirmed rejected close should use the bounded retry path');
  assert(summary.closed === 1 && summary.blocked === false && summary.deferred === false, 'Opposite entry cleanup should finish only after broker-confirmed closure');
}

async function testSupersededPendingExitDefersOppositeEntryUntilClosed() {
  const position = {
    id: 733,
    user_id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    status: 'OPEN',
    execution_status: 'PENDING_EXIT',
    execution_broker: 'wealthsimple_snaptrade',
    is_simulated: false
  };
  const service = new TradeExecutionService({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: { query: async () => ({ rows: [position] }) }
  } as any) as any;
  let exitSubmitted = false;
  service.submitSupersededExit = async () => { exitSubmitted = true; return true; };
  service.waitForSupersededExitResolution = async () => ({ state: 'pending', position });

  const summary = await service.closeSupersededPositions(
    createSignalInput({ symbol: 'SPY', winningSide: 'PUT' }),
    {},
    'wealthsimple_snaptrade'
  );

  assert(exitSubmitted === false, 'An already-pending close must not submit a duplicate exit');
  assert(summary.deferred === true && summary.blocked === false, 'The opposite entry must remain deferred while the broker close is pending');
}

async function testSupersededRejectedExitWithoutBrokerEvidenceStaysBlocked() {
  const position = {
    id: 734,
    user_id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    broker_exit_order_id: 'exit-order-734',
    last_broker_order_status: 'UNKNOWN',
    last_broker_sync_at: new Date().toISOString(),
    exit_retry_count: 0,
    execution_broker: 'wealthsimple_snaptrade',
    is_simulated: false
  };
  const service = new TradeExecutionService({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: { query: async () => ({ rows: [position] }) }
  } as any) as any;
  let exitSubmitted = false;
  service.submitSupersededExit = async () => { exitSubmitted = true; return true; };

  const summary = await service.closeSupersededPositions(
    createSignalInput({ symbol: 'SPY', winningSide: 'PUT' }),
    {},
    'wealthsimple_snaptrade'
  );

  assert(exitSubmitted === false, 'UNKNOWN broker evidence must not submit another close');
  assert(summary.blocked === true && summary.message.includes('UNKNOWN'), 'Unsafe reversal should explain the broker evidence that blocked it');
}

async function testDeferredSupersededExitQueuesSignalWithoutFailureState() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  let failureMarked = false;
  let retryQueued = false;
  let deferredMarked = false;
  let correlatedRiskChecked = false;
  try {
    (TradeRedisService as any).acquireLock = async () => ({ acquired: true, key: 'entry-lock', token: 'token' });
    (TradeRedisService as any).releaseLock = async () => {};
    service.getSignalExecutionContract = async () => ({ engineVersion: 'signal-only-v2', optionDetails: { planned_contracts: 1 } });
    service.getRiskState = async () => ({ maxCorrelatedPositions: 1 });
    service.getExistingSignalExecution = async () => null;
    service.getSignalSetupGrade = async () => 'A+';
    service.reconcileBrokerOrdersBeforeEntry = async () => true;
    service.findDuplicateOpenEntry = async () => null;
    service.closeSupersededPositions = async () => ({
      checked: 1,
      closed: 0,
      supersededPending: 0,
      errors: [],
      blocked: false,
      deferred: true,
      message: 'Waiting for position #733 to close at Wealthsimple.'
    });
    service.scheduleDeferredSignalRetry = () => { retryQueued = true; };
    service.markSignalExecutionDeferred = async () => { deferredMarked = true; };
    service.getCorrelatedOpenPositions = async () => { correlatedRiskChecked = true; return []; };
    service.markSignalExecutionFailure = async () => { failureMarked = true; };

    const result = await service.executeSignal(createSignalInput({ symbol: 'SPY', winningSide: 'PUT' }), {
      execution_broker: 'wealthsimple_snaptrade',
      snaptrade_auto_trade: 'true',
      live_trading_acknowledged: 'true',
      snaptrade_trading_account_id: '7:account',
      contracts_per_trade: '1'
    });

    assert(result.retryable === true && result.riskCode === 'SUPERSEDED_EXIT_PENDING', 'Pending reversal close should return a retryable deferred result');
    assert(retryQueued, 'Pending reversal close should queue the active signal for another guarded evaluation');
    assert(deferredMarked, 'Pending reversal close should replace stale failure UI with a non-terminal deferred state');
    assert(failureMarked === false, 'Pending reversal close must not consume the signal as FAILED or CANCELLED');
    assert(correlatedRiskChecked === false, 'No opposite-entry risk path may run before the old position is broker-confirmed closed');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
  }
}

async function testDeferredSignalRetryRevalidatesLifecycleBeforeExecution() {
  let executionAttempted = false;
  let skippedMarked = false;
  const fastify = createFastifyMock();
  fastify.strategyEngine = {
    assertSignalExecutable: async () => { throw new Error('Setup expired'); }
  };
  const service = new TradeExecutionService(fastify) as any;
  service.executeSignal = async () => { executionAttempted = true; return { success: true }; };
  service.markSignalExecutionFailure = async (_userId: number, _signalId: number, _message: string, skipped: boolean) => {
    skippedMarked = skipped;
  };

  const result = await service.runDeferredSignalRetry(createSignalInput(), {});
  assert(result === null, 'An expired setup should end the deferred reversal queue');
  assert(executionAttempted === false, 'Deferred reversal must revalidate strategy lifecycle before re-entering execution');
  assert(skippedMarked, 'An expired deferred setup should end in an explicit skipped state');
}

async function testSimulatedSupersededClosureNeverCallsBrokerSync() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  let brokerSyncCalled = false;
  service.getPositionById = async () => ({
    id: 736,
    status: 'CLOSED',
    is_simulated: true,
    execution_broker: 'simulated'
  });
  service.reconcileBrokerOrdersBeforeEntry = async () => { brokerSyncCalled = true; return true; };

  const result = await service.waitForSupersededExitResolution(7, 736);
  assert(result.state === 'closed', 'A simulated superseded close should resolve from its local ledger state');
  assert(brokerSyncCalled === false, 'Paper/simulated reversals must never call Wealthsimple reconciliation');
}

async function testSupersededExitRaceDoesNotOverwritePendingBrokerState() {
  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  const originalSync = SnaptradeService.prototype.syncPendingBrokerOrders;
  const originalMarkFailure = TradeLifecycleService.markExitSubmissionFailure;
  let failureMarked = false;
  try {
    (TradeRedisService as any).acquireLock = async () => ({ acquired: true, key: 'exit-lock', token: 'token' });
    (TradeRedisService as any).releaseLock = async () => {};
    SnaptradeService.prototype.syncPendingBrokerOrders = async () => ({ success: true } as any);
    (TradeLifecycleService as any).markExitSubmissionFailure = async () => { failureMarked = true; };
    const service = new TradeExecutionService({
      log: { info: () => {}, warn: () => {}, error: () => {} },
      pg: {
        query: async (sql: string) => {
          if (sql.includes('SELECT *') && sql.includes('FROM positions')) {
            return { rows: [{
              id: 735,
              user_id: 7,
              status: 'OPEN',
              execution_status: 'PENDING_EXIT',
              execution_broker: 'wealthsimple_snaptrade',
              is_simulated: false
            }] };
          }
          return { rows: [] };
        }
      }
    } as any) as any;

    let rejected = false;
    try {
      await service.submitSupersededExit({
        id: 735,
        user_id: 7,
        status: 'OPEN',
        execution_status: 'OPEN',
        execution_broker: 'wealthsimple_snaptrade',
        is_simulated: false
      }, {}, 'wealthsimple_snaptrade', 42, false);
    } catch (err: any) {
      rejected = String(err.message || '').includes('already pending');
    }

    assert(rejected, 'A close that became pending during reconciliation must stop the duplicate submission');
    assert(failureMarked === false, 'A pre-submission state race must not overwrite PENDING_EXIT with EXIT_RETRYABLE');
  } finally {
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
    SnaptradeService.prototype.syncPendingBrokerOrders = originalSync;
    (TradeLifecycleService as any).markExitSubmissionFailure = originalMarkFailure;
  }
}

async function testStrategyLifecycleIsRevalidatedImmediatelyBeforeClaim() {
  let revalidated = false;
  let claimCalled = false;
  const fastify = createFastifyMock();
  fastify.strategyEngine = {
    assertSignalExecutable: async () => {
      revalidated = true;
      throw new Error('The strategy is no longer accepting a new entry');
    }
  };
  const service = new TradeExecutionService(fastify) as any;
  service.getSignalOptionDetails = async () => ({});
  service.validateEntryQuote = async () => ({ quote: createEntryQuote(), protectedLimit: 2.05, baselineMark: 2, movePct: 2.5, stabilityMovePct: null });
  service.markSignalExecutionFailure = async () => {};
  service.claimSignalSubmission = async () => { claimCalled = true; return true; };

  const result = await service.executeSnapTradeOptionTrade(createSignalInput(), {
    live_trading_acknowledged: 'true',
    snaptrade_trading_account_id: '7:account',
    order_type: 'LIMIT'
  }, 1);
  assert(revalidated, 'The primary lifecycle must be revalidated after the final option quote');
  assert(result.skipped === true && claimCalled === false, 'A stale lifecycle must block before the durable broker submission claim');
}

async function testFreshQuotePlannedLossRespectsRemainingDailyBudget() {
  let failureMessage = '';
  const service = new TradeExecutionService(createFastifyMock()) as any;
  service.getSignalOptionDetails = async () => ({});
  service.validateEntryQuote = async () => ({
    quote: createEntryQuote(),
    protectedLimit: 2.05,
    baselineMark: 2,
    movePct: 2.5,
    stabilityMovePct: null
  });
  service.getRiskState = async () => ({ maxPremiumRisk: 500, remainingDailyLossBudget: 50 });
  service.markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string) => {
    failureMessage = message;
  };

  const result = await service.executeSnapTradeOptionTrade(createSignalInput(), {
    live_trading_acknowledged: 'true',
    snaptrade_trading_account_id: '7:account',
    order_type: 'LIMIT'
  }, 1);

  assert(result.riskCode === 'PLANNED_LOSS_LIMIT', 'The final protected quote must honor the remaining daily loss budget');
  assert(failureMessage.includes('remaining daily loss budget'), 'The skipped execution must record the planned-loss reason');
}

async function testStrategyStopRiskReplacesFlatDebitAssumption() {
  const service = new TradeExecutionService(createFastifyMock()) as any;
  const modeled = service.plannedLossForSignal({
    planned_limit_price: 2,
    estimated_stop_risk: { per_contract_dollars: 55 }
  }, 420, 2);
  const fallback = service.plannedLossForSignal({}, 420, 2);

  assert(modeled === 115.5, `Expected the strategy stop model to scale with the current debit, got ${modeled}`);
  assert(fallback === 168, `Expected legacy signals to retain the 40% debit fallback, got ${fallback}`);
}

async function runTests() {
  console.log('Running TradeExecutionService broker lifecycle tests...');
  await testIBKRQuoteAllowsProtectedLimit();
  await testEntryLimitOffsetIsConfigurableAndCappedAtAsk();
  await testEntryValidationUsesProtectedLimitForRiskCheck();
  await testSnapTradeQuoteIsNotUsedForEntryValidation();
  await testEntryValidationDoesNotWaitForSecondQuote();
  await testLiveExecutionSkipsTheoreticalPricingSignal();
  await testLiveExecutionSkipsLowExecutionRealismSignal();
  await testTheoreticalPricingDetectionCoversStoredShapes();
  await testRiskDecisionServiceCentralizesPreTradeBlocks();
  await testShadowModeNeverResolvesToLiveBroker();
  await testDuplicateSignalPreservesExecutedRecord();
  await testDurableSubmissionClaim();
  await testDeferredExecutionStateClearsStaleBrokerReview();
  await testStrategyPlanCapsConfiguredQuantity();
  await testStrategyDebitPlanUsesSubmittedLimit();
  await testPreSubmitRiskDenialSkipsBeforeBrokerPath();
  await testDuplicateOpenEntrySkipsBeforeOrderLifecycle();
  await testStrategyManagedSyntheticTrailUsesStrategyTargets();
  await testLiveEntryUsesCorrelatedExposureLockAndFailsClosed();
  await testDeferredEntryLockCollisionReschedulesWithoutConsumingSignal();
  await testEntryWaitsForOverlappingBrokerSync();
  await testEntryWaitsThroughBrokerSyncLockLifetime();
  await testBusyBrokerSyncDefersWithoutConsumingSignal();
  await testGenuineBrokerSyncFailureStillRequiresReview();
  await testSupersededRejectedExitRetriesOnlyAfterBrokerConfirmation();
  await testSupersededPendingExitDefersOppositeEntryUntilClosed();
  await testSupersededRejectedExitWithoutBrokerEvidenceStaysBlocked();
  await testDeferredSupersededExitQueuesSignalWithoutFailureState();
  await testDeferredSignalRetryRevalidatesLifecycleBeforeExecution();
  await testSimulatedSupersededClosureNeverCallsBrokerSync();
  await testSupersededExitRaceDoesNotOverwritePendingBrokerState();
  await testStrategyLifecycleIsRevalidatedImmediatelyBeforeClaim();
  await testFreshQuotePlannedLossRespectsRemainingDailyBudget();
  await testStrategyStopRiskReplacesFlatDebitAssumption();
  console.log('All TradeExecutionService broker lifecycle tests passed!');
}

runTests()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redis.quit();
  });
