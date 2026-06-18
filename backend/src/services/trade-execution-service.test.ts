import '@fastify/postgres';
import { redis } from '../lib/redis';
import { SnaptradeService } from './snaptrade-service';
import { TradeExecutionService } from './trade-execution-service';
import { TradeRedisService } from './trade-redis-service';

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

function createSnapTradeQuote(overrides: Partial<any> = {}) {
  return {
    source: 'snaptrade',
    ticker: 'QQQ260616P00738000',
    bid: 0,
    ask: 0,
    last: 2.04,
    mid: 2.04,
    mark: 2.04,
    spreadPct: null,
    syntheticOnly: true,
    quoteAgeMs: 1_000,
    tradeAgeMs: null,
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

async function testSnapTradeOptionQuoteFormatsRequest() {
  const service = new SnaptradeService(createFastifyMock());
  let capturedRequest: any = null;

  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      trading: {
        getUserAccountOptionQuotes: async (request: any) => {
          capturedRequest = request;
          return {
            data: {
              symbol: request.symbol,
              synthetic_price: 2.04,
              timestamp: new Date().toISOString()
            }
          };
        }
      }
    }
  });

  const quote = await service.getOptionQuote(7, '7:wealthsimple-account', 'QQQ260616P00738000');

  assert(quote.synthetic_price === 2.04, 'Should return SnapTrade option quote data');
  assert(capturedRequest.userId === 'snap-user', 'Should pass SnapTrade user id');
  assert(capturedRequest.userSecret === 'snap-secret', 'Should pass SnapTrade user secret');
  assert(capturedRequest.accountId === 'wealthsimple-account', 'Should unwrap user-prefixed SnapTrade account id');
  assert(capturedRequest.symbol === 'QQQ   260616P00738000', `Should convert compact OSI to OCC symbol, got ${capturedRequest.symbol}`);
}

async function testSnapTradeSyntheticQuoteFallbackAllowsProtectedLimit() {
  const service = new TradeExecutionService(createFastifyMock());
  const input = createSignalInput();

  (service as any).getSignalOptionDetails = async () => ({ mark: 2 });
  (service as any).fetchAlpacaOptionSnapshot = async () => {
    throw new Error('Alpaca unavailable');
  };
  (service as any).fetchSnapTradeOptionQuote = async () => createSnapTradeQuote();
  (service as any).wait = async () => {};

  const validation = await (service as any).validateEntryQuote(
    input,
    { alpaca_key_id: '', alpaca_secret_key: '' },
    'QQQ260616P00738000',
    2.05,
    '7:wealthsimple-account'
  );

  assert(validation.quote.source === 'snaptrade', 'Should use SnapTrade quote fallback');
  assert(validation.quote.syntheticOnly === true, 'Should mark fallback quote as synthetic-only');
  assert(validation.protectedLimit === 2.04, `Should anchor protected limit to synthetic quote, got ${validation.protectedLimit}`);
  assert(validation.stabilityMovePct === 0, `Stable repeated synthetic quotes should have 0% move, got ${validation.stabilityMovePct}`);
}

async function testEntryValidationRejectsQuoteSourceSwitch() {
  const service = new TradeExecutionService(createFastifyMock());
  const quotes = [
    createSnapTradeQuote({ source: 'snaptrade' }),
    {
      ...createSnapTradeQuote({
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
  await testSnapTradeOptionQuoteFormatsRequest();
  await testSnapTradeSyntheticQuoteFallbackAllowsProtectedLimit();
  await testEntryValidationRejectsQuoteSourceSwitch();
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
