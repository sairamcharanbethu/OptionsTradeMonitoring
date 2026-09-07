import { REALTIME_CHANNEL, configureRealtime, getRealtimeHealth, publishRealtime, realtimeInstanceId, resetRealtimeForTests, startRealtimeBus, stopRealtimeBus } from './realtime';

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

  await testBus();
  console.log('All realtime publisher tests passed!');
}

/** Fake pub/sub: two "instances" share one channel; each has its own sockets. */
function createFakeBus() {
  const handlers: Array<(message: string) => void> = [];
  const publishedMessages: string[] = [];
  return {
    publishedMessages,
    handlers,
    publish: async (channel: string, message: string) => {
      assert(channel === REALTIME_CHANNEL, 'Publishes on the realtime channel');
      publishedMessages.push(message);
      for (const handler of handlers) handler(message);
      return handlers.length;
    },
    subscribe: (_channel: string, onMessage: (message: string) => void, onStatus?: (subscribed: boolean) => void) => {
      handlers.push(onMessage);
      onStatus?.(true);
      return async () => { const i = handlers.indexOf(onMessage); if (i >= 0) handlers.splice(i, 1); };
    }
  };
}

async function testBus() {
  resetRealtimeForTests();
  const local = socket();
  const bus = createFakeBus();
  configureRealtime({ getWebsocketServer: () => ({ clients: [local] }), socketUserIds: null, bus });
  assert(startRealtimeBus() === true, 'Bus subscription starts when a bus is configured');
  assert(getRealtimeHealth().busSubscribed === true, 'Health reports the subscription');

  // Publishing: delivered locally once, published to the bus once, and the
  // echo of our own envelope is ignored (no double delivery).
  const sent = publishRealtime('STRATEGY_STATE', { setupId: 'bus-1' }, { userId: 7 });
  assert(sent === 1 && local.sent.length === 1, 'Local delivery happens exactly once');
  assert(bus.publishedMessages.length === 1, 'Envelope is handed to the bus');
  const envelope = JSON.parse(bus.publishedMessages[0]);
  assert(envelope.origin === realtimeInstanceId() && envelope.userId === 7 && envelope.type === 'STRATEGY_STATE', 'Bus envelope carries origin, user and type');
  await new Promise((r) => setTimeout(r, 0));
  assert(local.sent.length === 1, 'Our own echo from the bus is dropped');
  assert(getRealtimeHealth().busDropped === 1 && getRealtimeHealth().busReceived === 0, 'Health counts the dropped echo');

  // A message from ANOTHER instance is fanned out to our sockets with the same envelope shape.
  const remote = { type: 'POSITION_UPDATE', data: { id: 5 }, ts: new Date().toISOString(), userId: null, origin: 'other-instance' };
  for (const handler of bus.handlers) handler(JSON.stringify(remote));
  assert(local.sent.length === 2, 'Remote envelopes reach local sockets');
  const delivered = JSON.parse(local.sent[1]);
  assert(delivered.type === 'POSITION_UPDATE' && delivered.data.id === 5 && !('origin' in delivered), 'Clients receive {type,data,ts} only');
  assert(getRealtimeHealth().busReceived === 1, 'Health counts received envelopes');

  // Garbage on the channel is ignored.
  for (const handler of bus.handlers) handler('not json');
  assert(local.sent.length === 2, 'Malformed bus messages are dropped');

  // Bus failure never blocks local delivery.
  configureRealtime({ bus: { publish: () => { throw new Error('redis down'); }, subscribe: () => null } });
  assert(publishRealtime('KILL_SWITCH', {}) === 1 && local.sent.length === 3, 'Local fan-out survives a throwing bus');
  await stopRealtimeBus();
  resetRealtimeForTests();
  assert(startRealtimeBus() === false, 'No bus configured => no subscription, no throw');
}

runTests().catch((err) => { console.error(err); process.exit(1); });
