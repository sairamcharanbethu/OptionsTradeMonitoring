import '@fastify/postgres';
import '@fastify/websocket';
import { MarketPoller } from './market-poller';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createPoller() {
  const fastify = {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
  return new MarketPoller(fastify, {}) as any;
}

async function testUnderlyingStopDirection() {
  const poller = createPoller();

  assert(poller.isUnderlyingStopBroken({ option_type: 'CALL' }, 746.9, 747) === true, 'CALL should stop when underlying breaks below stop');
  assert(poller.isUnderlyingStopBroken({ option_type: 'CALL' }, 747.2, 747) === false, 'CALL should not stop above underlying stop');
  assert(poller.isUnderlyingStopBroken({ option_type: 'PUT' }, 750.1, 750) === true, 'PUT should stop when underlying breaks above stop');
  assert(poller.isUnderlyingStopBroken({ option_type: 'PUT' }, 749.8, 750) === false, 'PUT should not stop below underlying stop');
}

async function testThetaStopMaxHoldWindows() {
  const poller = createPoller();
  const basePosition = {
    status: 'OPEN',
    expiration_date: '2026-07-03',
    quantity: 1
  };

  const morning = poller.getThetaStopAssessment({
    ...basePosition,
    created_at: '2026-07-03T14:00:00.000Z'
  }, new Date('2026-07-03T14:26:00.000Z'));
  const lunch = poller.getThetaStopAssessment({
    ...basePosition,
    created_at: '2026-07-03T16:00:00.000Z'
  }, new Date('2026-07-03T16:16:00.000Z'));
  const afternoon = poller.getThetaStopAssessment({
    ...basePosition,
    created_at: '2026-07-03T18:30:00.000Z'
  }, new Date('2026-07-03T18:41:00.000Z'));
  const stillValid = poller.getThetaStopAssessment({
    ...basePosition,
    created_at: '2026-07-03T14:00:00.000Z'
  }, new Date('2026-07-03T14:20:00.000Z'));
  const oneDte = poller.getThetaStopAssessment({
    ...basePosition,
    expiration_date: '2026-07-06',
    created_at: '2026-07-03T14:00:00.000Z'
  }, new Date('2026-07-03T14:40:00.000Z'));
  const liveFilledLater = poller.getThetaStopAssessment({
    ...basePosition,
    execution_broker: 'wealthsimple_snaptrade',
    created_at: '2026-07-03T14:00:00.000Z',
    updated_at: '2026-07-03T14:20:00.000Z'
  }, new Date('2026-07-03T14:40:00.000Z'));
  const anchoredStart = poller.getThetaStopAssessment({
    ...basePosition,
    execution_broker: 'wealthsimple_snaptrade',
    created_at: '2026-07-03T14:00:00.000Z',
    updated_at: '2026-07-03T14:45:00.000Z'
  }, new Date('2026-07-03T14:50:00.000Z'), '2026-07-03T14:20:00.000Z');

  assert(morning?.triggered === true && morning.maxHoldMinutes === 25, `Expected morning 25m theta-stop, got ${JSON.stringify(morning)}`);
  assert(lunch?.triggered === true && lunch.maxHoldMinutes === 15, `Expected lunch 15m theta-stop, got ${JSON.stringify(lunch)}`);
  assert(afternoon?.triggered === true && afternoon.maxHoldMinutes === 10, `Expected afternoon 10m theta-stop, got ${JSON.stringify(afternoon)}`);
  assert(stillValid?.triggered === false, `Expected 20m morning hold to remain valid, got ${JSON.stringify(stillValid)}`);
  assert(oneDte === null, `Expected non-0DTE position to skip theta-stop, got ${JSON.stringify(oneDte)}`);
  assert(liveFilledLater?.triggered === false && liveFilledLater.heldMinutes === 20, `Expected live broker theta-stop to start from fill/update time, got ${JSON.stringify(liveFilledLater)}`);
  assert(anchoredStart?.triggered === true && anchoredStart.heldMinutes === 30, `Expected stored theta-stop anchor to survive later updates, got ${JSON.stringify(anchoredStart)}`);
}

async function testTradeExcursionTracksLongAndShortPremium() {
  const poller = createPoller();
  const longFirst = poller.calculateTradeExcursion({ entry_price: 2 }, 2.5);
  const longNext = poller.calculateTradeExcursion({ entry_price: 2, max_favorable_price: 2.5, max_adverse_price: 2 }, 1.5);
  const shortFirst = poller.calculateTradeExcursion({ entry_price: 2, entry_action: 'SELL_TO_OPEN' }, 1.5);

  assert(longFirst.mfePct === 25 && longFirst.maePct === 0, `Expected long MFE 25% and MAE 0%, got ${JSON.stringify(longFirst)}`);
  assert(longNext.mfePct === 25 && longNext.maePct === 25, `Expected long excursion to preserve MFE and add 25% MAE, got ${JSON.stringify(longNext)}`);
  assert(shortFirst.mfePct === 25 && shortFirst.maePct === 0, `Expected short premium gain to be favorable, got ${JSON.stringify(shortFirst)}`);
}

async function testStrategyLifecycleExitDoesNotPartialTrim() {
  const poller = createPoller();
  assert(
    poller.isPartialProfitTrim({ quantity: 4, strategy_managed: true }, 'TAKE_PROFIT') === false,
    'A terminal strategy lifecycle exit must close the full planned position'
  );
  assert(
    poller.isPartialProfitTrim({ quantity: 4, strategy_managed: false }, 'TAKE_PROFIT') === true,
    'Legacy take-profit behavior should retain partial trimming'
  );
}

async function testExitReviewStateCannotBeClaimedAgain() {
  let claimSql = '';
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string) => {
        claimSql = sql;
        return { rows: [], rowCount: 0 };
      }
    }
  } as any;
  const poller = new MarketPoller(fastify, {}) as any;

  const submitted = await poller.submitSnapTradeExit({
    id: 44,
    user_id: 7,
    account_id: '7:wealthsimple-account',
    quantity: 1,
    execution_status: 'EXIT_STALE',
    entry_action: 'BUY_TO_OPEN'
  }, 'MARKET');

  assert(submitted === false, 'An unclaimable exit must not submit another broker order');
  assert(claimSql.includes("NOT LIKE 'EXIT_%'"), 'The atomic exit claim must reject broker-review states');
}

async function testLocalClosePreservesPriorRealizedPnl() {
  let updateSql = '';
  let updateParams: any[] = [];
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params: any[] = []) => {
        updateSql = sql;
        updateParams = params;
        return { rows: [], rowCount: 1 };
      }
    }
  } as any;
  const poller = new MarketPoller(fastify, {}) as any;
  const closePnl = await poller.closePositionLocally({
    id: 45,
    entry_price: 0.49,
    quantity: 1,
    realized_pnl: 12,
    entry_action: 'BUY_TO_OPEN'
  }, 0, 'EXPIRED');

  assert(closePnl === -49, `A worthless $0.49 long contract should realize -$49, got ${closePnl}`);
  assert(updateSql.includes('COALESCE(realized_pnl, 0) + $2'), 'A final close must add to PnL already realized by earlier trims');
  assert(updateParams[0] === 0 && updateParams[1] === -49, `Expected zero exit and -$49 close leg, got ${JSON.stringify(updateParams)}`);
  assert(updateParams[2] === 'EXPIRED', 'The close must preserve its lifecycle reason');
}

async function testPendingAndReviewExitsStayUnresolved() {
  const poller = createPoller();
  assert(poller.hasUnresolvedExit({ execution_status: 'PENDING_EXIT' }) === true, 'A pending exit must remain unresolved');
  assert(poller.hasUnresolvedExit({ execution_status: 'EXIT_STALE' }) === true, 'A stale broker exit must require review');
  assert(poller.hasUnresolvedExit({ execution_status: 'FILLED' }) === false, 'A filled entry must not look like an unresolved exit');
}

async function testExpirationUsesNewYorkTradingDate() {
  const poller = createPoller();
  const saturdayNoonEt = new Date('2026-07-04T16:00:00.000Z');
  assert(poller.isPositionExpired({ expiration_date: '2026-07-03' }, saturdayNoonEt) === true, 'A prior-day contract must be expired');
  assert(poller.isPositionExpired({ expiration_date: '2026-07-04' }, saturdayNoonEt) === false, 'The same date must not be treated as a prior-day expiration');
  assert(poller.isPositionExpired({ expiration_date: 'invalid' }, saturdayNoonEt) === false, 'An invalid expiration must not trigger a destructive close');
}

function createMarketDataRedisMock() {
  const hashes = new Map<string, Record<string, string>>();
  return {
    isReady: () => true,
    hgetall: async (key: string) => ({ ...(hashes.get(key) || {}) }),
    hset: async (key: string, values: Record<string, any>) => {
      const current = hashes.get(key) || {};
      for (const [field, value] of Object.entries(values)) {
        if (value !== undefined) current[field] = value === null ? '' : String(value);
      }
      hashes.set(key, current);
    },
    sadd: async () => {},
    zadd: async () => {}
  };
}

async function testOrdinaryQuoteUpdatesStayOutOfPostgres() {
  const queries: string[] = [];
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 1 }; } }
  } as any;
  const poller = new MarketPoller(fastify, createMarketDataRedisMock()) as any;

  await poller.processPositionExitUpdate({
    id: 51,
    user_id: 7,
    status: 'OPEN',
    is_simulated: true,
    entry_price: 1,
    current_price: 1,
    quantity: 1,
    stop_loss_trigger: 0.5,
    take_profit_trigger: 2,
    trailing_high_price: 1,
    expiration_date: '2099-08-03',
    option_type: 'CALL'
  }, 1.1, undefined, undefined, undefined, { bid: 1.09, ask: 1.11, mid: 1.1, spreadPct: 1.82, source: 'test' });

  assert(queries.length === 0, `An ordinary live quote must remain Redis-only, got ${queries.length} PostgreSQL writes: ${JSON.stringify(queries)}`);
}

async function testSimulatedExitPersistsFinalCheckpoint() {
  let closeSql = '';
  let closeParams: any[] = [];
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("SET status = $1")) {
          closeSql = sql;
          closeParams = params;
        }
        return { rows: [], rowCount: 1 };
      }
    }
  } as any;
  const poller = new MarketPoller(fastify, createMarketDataRedisMock()) as any;
  poller.aiService.generateAlertSummary = async () => ({ summary: '', discord_message: '' });
  poller.notifyN8n = () => {};

  await poller.processPositionExitUpdate({
    id: 52,
    user_id: 7,
    symbol: 'SPY',
    status: 'OPEN',
    is_simulated: true,
    entry_price: 1,
    current_price: 1,
    quantity: 1,
    stop_loss_trigger: 0.5,
    take_profit_trigger: 2,
    trailing_high_price: 1,
    expiration_date: '2099-08-03',
    option_type: 'CALL',
    analysis_data: {}
  }, 2.1, undefined, undefined, undefined, { bid: 2.09, ask: 2.11, mid: 2.1, spreadPct: 0.95, source: 'test' });

  assert(closeSql.includes('exit_price = $4'), 'A simulated close must persist its final exit price');
  assert(closeSql.includes("execution_status = 'EXIT_FILLED'"), 'A simulated close must persist a terminal execution status');
  assert(closeSql.includes('analysis_data = $12'), 'A simulated close must persist its final exit analysis');
  assert(closeParams[3] === 2.1 && closeParams[4] === 'TAKE_PROFIT', `Expected final price and exit reason, got ${JSON.stringify(closeParams)}`);
}

async function runTests() {
  console.log('Running MarketPoller tests...');
  await testUnderlyingStopDirection();
  await testThetaStopMaxHoldWindows();
  await testTradeExcursionTracksLongAndShortPremium();
  await testStrategyLifecycleExitDoesNotPartialTrim();
  await testExitReviewStateCannotBeClaimedAgain();
  await testLocalClosePreservesPriorRealizedPnl();
  await testPendingAndReviewExitsStayUnresolved();
  await testExpirationUsesNewYorkTradingDate();
  await testOrdinaryQuoteUpdatesStayOutOfPostgres();
  await testSimulatedExitPersistsFinalCheckpoint();
  console.log('All MarketPoller tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
