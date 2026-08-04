import { LiveExitMonitorService } from './live-exit-monitor-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  let positionQueries = 0;
  let processedUpdates = 0;
  let positionQuerySql = '';
  const fastify = {
    log: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async (sql: string) => {
        if (sql.includes('FROM positions')) {
          positionQueries++;
          positionQuerySql = sql;
          return {
            rows: [{
              id: 101,
              user_id: 7,
              username: 'test',
              symbol: 'SPY',
              option_type: 'CALL',
              strike_price: 737,
              expiration_date: '2026-07-01',
              entry_price: 1,
              stop_loss_trigger: 0.7,
              take_profit_trigger: 1.5,
              quantity: 1,
              status: 'OPEN'
            }]
          };
        }
        return { rows: [], rowCount: 0 };
      }
    },
    poller: {
      processPositionExitUpdate: async () => {
        processedUpdates++;
      }
    }
  } as any;
  return {
    fastify,
    getPositionQueries: () => positionQueries,
    getProcessedUpdates: () => processedUpdates,
    getPositionQuerySql: () => positionQuerySql
  };
}

async function testLiveExitCachesOpenPositionsAcrossQuoteBurst() {
  process.env.LIVE_EXIT_POSITION_CACHE_MS = '5000';
  const { fastify, getPositionQueries, getProcessedUpdates, getPositionQuerySql } = createFastifyMock();
  const service = new LiveExitMonitorService(fastify);
  service.start('test');

  await service.handleQuote({ symbol: 'SPY260701C00737000', bidPrice: 1.2, askPrice: 1.3 });
  await service.handleQuote({ symbol: 'SPY260701C00737000', bidPrice: 1.25, askPrice: 1.35 });

  assert(getPositionQueries() === 1, `Expected one positions query for quote burst, got ${getPositionQueries()}`);
  assert(getProcessedUpdates() === 2, `Expected both quotes to process against cached position, got ${getProcessedUpdates()}`);
  assert(service.getHealth().positionCacheSize === 1, 'Expected live-exit position cache to contain one contract');
  assert(getPositionQuerySql().includes("execution_broker, '') <> 'system_paper'"), 'Legacy live-exit monitoring must exclude system-paper positions');
}

async function testLiveExitReflectsReconnectingIbkrStream() {
  const { fastify } = createFastifyMock();
  fastify.ibkrMarketDataStreamer = {
    getHealth: () => ({ status: 'DEGRADED', connected: false, lastError: 'reconnecting' })
  };
  const service = new LiveExitMonitorService(fastify);
  service.start('ibkr');

  const health = service.getHealth();
  assert(health.active, 'Monitor must remain attached while the IBKR stream reconnects');
  assert(health.provider === 'ibkr', 'Monitor must retain the IBKR provider during reconnect');
  assert(health.status === 'DEGRADED', 'Reconnecting stream must degrade rather than disable the monitor');
}

async function testLiveExitsRunInParallelAcrossUsersAndIsolateFailures() {
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const positions = [7, 8].map(userId => ({
    id: 100 + userId,
    user_id: userId,
    username: `user-${userId}`,
    symbol: 'SPY',
    option_type: 'CALL',
    strike_price: 737,
    expiration_date: '2026-07-01',
    entry_price: 1,
    quantity: 1,
    status: 'OPEN'
  }));
  const fastify = {
    log: { info() {}, debug() {}, warn() {}, error() {} },
    pg: { query: async () => ({ rows: positions }) },
    poller: {
      processPositionExitUpdate: async (position: any) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        if (position.user_id === 8) throw new Error('user-specific exit failure');
        completed += 1;
      }
    }
  } as any;
  const service = new LiveExitMonitorService(fastify);
  service.start('test');

  await service.handleQuote({ symbol: 'SPY260701C00737000', bidPrice: 1.2, askPrice: 1.3 });

  assert(maxActive === 2, `Expected two user exits in parallel, got ${maxActive}`);
  assert(completed === 1 && service.getHealth().matchedUpdates === 1, 'A failing user exit must not cancel another user exit');
  assert(Boolean(service.getHealth().lastError?.includes('User 8')), 'The failing user and position must remain observable in health state');
}

async function runTests() {
  console.log('Running LiveExitMonitorService tests...');
  await testLiveExitCachesOpenPositionsAcrossQuoteBurst();
  await testLiveExitReflectsReconnectingIbkrStream();
  await testLiveExitsRunInParallelAcrossUsersAndIsolateFailures();
  console.log('All LiveExitMonitorService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
