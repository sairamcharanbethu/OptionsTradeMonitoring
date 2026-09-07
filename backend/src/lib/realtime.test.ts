import { configureRealtime, publishRealtime, resetRealtimeForTests } from './realtime';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function socket(readyState = 1) {
  const sent: string[] = [];
  return { readyState, sent, send: (payload: string) => { sent.push(payload); } };
}

async function runTests() {
  console.log('Running realtime publisher tests...');
  resetRealtimeForTests();
  assert(publishRealtime('STRATEGY_STATE', { a: 1 }) === 0, 'Publishing with no server is a no-op, never a throw');

  const a = socket(); const b = socket(); const closed = socket(3);
  const userIds = new Map<any, number>();
  configureRealtime({ getWebsocketServer: () => ({ clients: [a, b, closed] }), socketUserIds: userIds });

  assert(publishRealtime('STRATEGY_STATE', { setupId: 'x' }) === 2, 'Global messages reach every open socket');
  const env = JSON.parse(a.sent[0]);
  assert(env.type === 'STRATEGY_STATE' && env.data.setupId === 'x' && typeof env.ts === 'string', 'Envelope carries type, data and ts');

  // Nobody authenticated yet: a user-targeted message still reaches all open sockets.
  assert(publishRealtime('KILL_SWITCH', { live: {} }, { userId: 7 }) === 2, 'Targeted message falls back to broadcast before any auth');

  userIds.set(a, 7); userIds.set(b, 9);
  assert(publishRealtime('POSITION_UPDATE', { id: 1 }, { userId: 7 }) === 1 && a.sent.length === 3 && b.sent.length === 2, 'Targeted message reaches only the matching user');
  assert(publishRealtime('TRADE_EVENT', { id: 1 }, { userId: 42 }) === 0, 'Unknown user receives nothing');

  const throwing = { readyState: 1, send: () => { throw new Error('boom'); } };
  configureRealtime({ getWebsocketServer: () => ({ clients: [throwing, a] }), socketUserIds: null });
  assert(publishRealtime('STRATEGY_STATE', {}) === 1, 'A failing socket does not stop delivery to the others');

  configureRealtime({ getWebsocketServer: () => { throw new Error('server gone'); } });
  assert(publishRealtime('STRATEGY_STATE', {}) === 0, 'A throwing server accessor is swallowed');
  console.log('All realtime publisher tests passed!');
}

runTests().catch((err) => { console.error(err); process.exit(1); });
