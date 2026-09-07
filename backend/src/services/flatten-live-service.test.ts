import { flattenLivePositions } from './flatten-live-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const positions = [
  { id: 1, user_id: 7, symbol: 'SPY', option_type: 'CALL', strike_price: 770, quantity: 2, execution_status: 'FILLED', signal_id: 55 },
  { id: 2, user_id: 7, symbol: 'SPY', option_type: 'PUT', strike_price: 765, quantity: 1, execution_status: 'PENDING_EXIT' },
  { id: 3, user_id: 7, symbol: 'SPY', option_type: 'PUT', strike_price: 760, quantity: 1, execution_status: 'EXIT_REJECTED' },
  { id: 4, user_id: 7, symbol: 'QQQ', option_type: 'CALL', strike_price: 500, quantity: 3, execution_status: 'FILLED' }
];

async function runTests() {
  console.log('Running flatten-live tests...');
  const submitted: any[] = [];
  const events: any[] = [];
  const disarms: any[] = [];
  const pg = { query: async (sql: string) => sql.includes('FROM positions') ? { rows: positions } : { rows: [] } };
  const poller = {
    submitSnapTradeExit: async (position: any, orderType: string, limitPrice: any, trigger: string, quantity?: number) => {
      submitted.push({ id: position.id, orderType, trigger, quantity });
      return position.id !== 4; // the QQQ exit fails at the broker
    }
  };
  const summary = await flattenLivePositions(
    {
      pg, poller,
      recordEvent: async (_db: any, event: any) => { events.push(event); },
      setLiveDisarmed: async (_pg: any, userId: number, disarmed: boolean) => { disarms.push({ userId, disarmed }); }
    },
    { userId: 7, disarm: true }
  );
  assert(summary.requested === 4, 'Every open live position is considered');
  assert(summary.submitted === 1, `Only positions without an in-flight exit that the broker accepted count, got ${summary.submitted}`);
  assert(submitted.length === 2 && submitted.every(s => s.orderType === 'MARKET' && s.trigger === 'MANUAL_FLATTEN_ALL'), 'Exits are MARKET with the flatten trigger');
  assert(submitted[0].id === 1 && submitted[0].quantity === 2, 'Full quantity is requested');
  assert(summary.skipped.some(s => s.id === 2 && s.reason.includes('PENDING_EXIT')), 'A pending exit is skipped, not resubmitted');
  assert(summary.skipped.some(s => s.id === 3 && s.reason.includes('EXIT_REJECTED')), 'A broker-review exit is skipped');
  assert(summary.skipped.some(s => s.id === 4), 'A failed submission is reported as skipped');
  assert(events.length === 1 && events[0].eventType === 'MANUAL_FLATTEN_ALL' && events[0].positionId === 1 && events[0].signalId === 55, 'One event per submitted exit');
  assert(summary.disarmed === true && disarms.length === 1 && disarms[0].disarmed === true && disarms[0].userId === 7, 'Disarm is applied when requested');

  const noDisarm = await flattenLivePositions(
    { pg: { query: async () => ({ rows: [] }) }, poller, setLiveDisarmed: async () => { throw new Error('must not be called'); } },
    { userId: 7, disarm: false }
  );
  assert(noDisarm.requested === 0 && noDisarm.disarmed === false, 'No positions and no disarm is a clean no-op');

  const noPoller = await flattenLivePositions({ pg, poller: null, setLiveDisarmed: async () => {} }, { userId: 7, disarm: true });
  assert(noPoller.submitted === 0 && noPoller.skipped.length === 4 && noPoller.disarmed === true, 'Without the exit engine nothing is submitted but disarm still happens');
  console.log('All flatten-live tests passed!');
}

runTests().catch((err) => { console.error(err); process.exit(1); });
