import { LiveExitMonitorService } from './live-exit-monitor-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  let positionQueries = 0;
  let processedUpdates = 0;
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
    getProcessedUpdates: () => processedUpdates
  };
}

async function testLiveExitCachesOpenPositionsAcrossQuoteBurst() {
  process.env.LIVE_EXIT_POSITION_CACHE_MS = '5000';
  const { fastify, getPositionQueries, getProcessedUpdates } = createFastifyMock();
  const service = new LiveExitMonitorService(fastify);
  service.start('test');

  await service.handleQuote({ symbol: 'SPY260701C00737000', bidPrice: 1.2, askPrice: 1.3 });
  await service.handleQuote({ symbol: 'SPY260701C00737000', bidPrice: 1.25, askPrice: 1.35 });

  assert(getPositionQueries() === 1, `Expected one positions query for quote burst, got ${getPositionQueries()}`);
  assert(getProcessedUpdates() === 2, `Expected both quotes to process against cached position, got ${getProcessedUpdates()}`);
  assert(service.getHealth().positionCacheSize === 1, 'Expected live-exit position cache to contain one contract');
}

async function runTests() {
  console.log('Running LiveExitMonitorService tests...');
  await testLiveExitCachesOpenPositionsAcrossQuoteBurst();
  console.log('All LiveExitMonitorService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
