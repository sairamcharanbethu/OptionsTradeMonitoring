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
    source: 'thetadata',
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

async function testThetaDataQuoteAllowsProtectedLimit() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchThetaDataOptionQuote = async () => createEntryQuote();
  (service as any).wait = async () => {};

  const validation = await (service as any).validateEntryQuote(
    input,
    { alpaca_key_id: '', alpaca_secret_key: '' },
    'QQQ260616P00738000',
    2.05,
    '7:wealthsimple-account'
  );

  assert(validation.quote.source === 'thetadata', 'Should use ThetaData quote validation');
  assert(validation.quote.syntheticOnly === false, 'Should require non-synthetic bid/ask data');
  assert(validation.protectedLimit === 2.08, `Should cap protected limit with live ask, got ${validation.protectedLimit}`);
  assert(validation.stabilityMovePct === 0, `Stable repeated live quotes should have 0% move, got ${validation.stabilityMovePct}`);
}

async function testSnapTradeQuoteIsNotUsedForEntryValidation() {
  const service = new TradeExecutionService(createFastifyMock());
  let snapTradeQuoteCalled = false;

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchThetaDataOptionQuote = async () => null;
  (service as any).fetchAlpacaOptionSnapshot = async () => null;
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

async function testEntryValidationRejectsQuoteSourceSwitch() {
  const service = new TradeExecutionService(createFastifyMock());
  const quotes = [
    createEntryQuote({ source: 'thetadata' }),
    {
      ...createEntryQuote({
        source: 'alpaca',
        bid: 2,
        ask: 2.1,
        mid: 2.05,
        mark: 2.05,
        spreadPct: 4.88,
        syntheticOnly: false,
        quoteAgeMs: 500
      })
    }
  ];

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchEntryQuoteSnapshot = async () => quotes.shift();
  (service as any).wait = async () => {};

  let rejected = false;
  try {
    await (service as any).validateEntryQuote(
      createSignalInput(),
      {},
      'QQQ260616P00738000',
      2.05,
      '7:wealthsimple-account'
    );
  } catch (err: any) {
    rejected = /quote source changed/.test(err.message);
  }

  assert(rejected, 'Should reject entry when quote source changes during stability check');
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
  const theoretical = RiskDecisionService.forTheoreticalPricing({
    decision: {
      quote: { usingTheoreticalPricing: true },
      grade: { pricingWarnings: [] }
    }
  });

  assert(existing.allowed === false && existing.code === 'EXISTING_SIGNAL_EXECUTION', 'Should block existing signal execution');
  assert(grade.allowed === false && grade.code === 'SETUP_GRADE_NOT_EXECUTABLE', 'Should block non-executable setup grade');
  assert(duplicate.allowed === false && duplicate.metadata?.duplicatePositionId === 679, 'Should block duplicate open entry with metadata');
  assert(dailyLimit.allowed === false && dailyLimit.code === 'DAILY_TRADE_LIMIT', 'Should block daily trade limit');
  assert(theoretical.allowed === false && theoretical.code === 'THEORETICAL_PRICING', 'Should block theoretical pricing');
  assert(RiskDecisionService.forSetupGrade(42, 'A+ / FULL').allowed === true, 'Should allow A+ setup grade');
  assert(RiskDecisionService.forDailyTradeLimit(2, 3).allowed === true, 'Should allow under daily trade limit');
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
  await testThetaDataQuoteAllowsProtectedLimit();
  await testSnapTradeQuoteIsNotUsedForEntryValidation();
  await testEntryValidationRejectsQuoteSourceSwitch();
  await testLiveExecutionSkipsTheoreticalPricingSignal();
  await testTheoreticalPricingDetectionCoversStoredShapes();
  await testRiskDecisionServiceCentralizesPreTradeBlocks();
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
