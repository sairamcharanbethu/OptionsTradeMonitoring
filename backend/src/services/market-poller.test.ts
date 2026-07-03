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

async function runTests() {
  console.log('Running MarketPoller tests...');
  await testUnderlyingStopDirection();
  await testThetaStopMaxHoldWindows();
  console.log('All MarketPoller tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
