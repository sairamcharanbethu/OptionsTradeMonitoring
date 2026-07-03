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

async function runTests() {
  console.log('Running MarketPoller tests...');
  await testUnderlyingStopDirection();
  console.log('All MarketPoller tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
