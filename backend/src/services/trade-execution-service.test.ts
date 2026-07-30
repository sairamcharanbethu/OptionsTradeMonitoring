import '@fastify/postgres';
import { redis } from '../lib/redis';
import { TradeExecutionService } from './trade-execution-service';
import { TradeRedisService } from './trade-redis-service';
import { RiskDecisionService } from './risk-decision-service';

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
  const grade = RiskDecisionService.forSetupGrade(42, 'B / LOTTO');
  const duplicate = RiskDecisionService.forDuplicateOpenEntry('QQQ 2026-06-16 PUT 738', {
    id: 679,
    status: 'OPEN',
    execution_status: 'PENDING'
  });
  const dailyLimit = RiskDecisionService.forDailyTradeLimit(3, 3);
  const dailyLoss = RiskDecisionService.forDailyLossLimit(-250, 200);
  const cooldown = RiskDecisionService.forConsecutiveLosses(3, 3, new Date(Date.now() + 60_000).toISOString());
  const premiumRisk = RiskDecisionService.forPremiumRisk(600, 500);
  const correlated = RiskDecisionService.forCorrelatedExposure(1, 1, 'SPY/QQQ');
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
  assert(grade.allowed === false && grade.code === 'SETUP_GRADE_NOT_EXECUTABLE', 'Should block non-executable setup grade');
  assert(duplicate.allowed === false && duplicate.metadata?.duplicatePositionId === 679, 'Should block duplicate open entry with metadata');
  assert(dailyLimit.allowed === false && dailyLimit.code === 'DAILY_TRADE_LIMIT', 'Should block daily trade limit');
  assert(dailyLoss.allowed === false && dailyLoss.code === 'DAILY_LOSS_LIMIT', 'Should block daily loss limit');
  assert(cooldown.allowed === false && cooldown.code === 'CONSECUTIVE_LOSS_COOLDOWN', 'Should block consecutive-loss cooldown');
  assert(premiumRisk.allowed === false && premiumRisk.code === 'PREMIUM_RISK_LIMIT', 'Should block premium risk limit');
  assert(correlated.allowed === false && correlated.code === 'CORRELATED_EXPOSURE_LIMIT', 'Should block correlated exposure');
  assert(executionRealism.allowed === false && executionRealism.code === 'EXECUTION_REALISM_TOO_LOW', 'Should block low execution realism');
  assert(theoretical.allowed === false && theoretical.code === 'THEORETICAL_PRICING', 'Should block theoretical pricing');
  assert(liveAck.denials[0]?.code === 'LIVE_TRADING_NOT_ACKNOWLEDGED', 'Should block missing live acknowledgement');
  assert(account.denials[0]?.code === 'ACCOUNT_NOT_SELECTED', 'Should block missing trading account');
  assert(staleQuote.denials[0]?.code === 'STALE_QUOTE', 'Should block stale option quote');
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
      broker_order_id: 'order-existing'
    });
    (service as any).markSignalExecutionFailure = async (_userId: number, _signalId: number, message: string, skipped: boolean) => {
      failureMarked = skipped && message.includes('already exists as position #679');
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
  await testPreSubmitRiskDenialSkipsBeforeBrokerPath();
  await testDuplicateOpenEntrySkipsBeforeOrderLifecycle();
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
