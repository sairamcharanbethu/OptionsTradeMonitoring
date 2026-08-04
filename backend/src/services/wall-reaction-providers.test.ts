import assert from 'node:assert/strict';
import { blockingEconomicEvent, normalizeTradingEconomicsEvents, providerAgeSeconds, WallReactionProviders } from './wall-reaction-providers';

async function run() {
  const events = normalizeTradingEconomicsEvents([
    { CalendarID: '1', Date: '2026-08-03T14:00:00Z', Country: 'United States', Event: 'ISM', Importance: 3 },
    { CalendarID: '2', Date: '2026-08-03T15:00:00Z', Country: 'Canada', Event: 'Other', Importance: 3 },
    { CalendarID: '3', Date: '2026-08-03T16:00:00Z', Country: 'United States', Event: 'Low', Importance: 1 }
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'ISM');
  assert.equal(providerAgeSeconds('2026-08-03T14:00:00Z', new Date('2026-08-03T14:00:08Z')), 8);
  assert.equal(providerAgeSeconds('2026-08-03T14:00:10Z', new Date('2026-08-03T14:00:08Z')), -2);
  const snapshot = { fetchedAt: '2026-08-03T13:20:00Z', events };
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T13:29:59Z'), 2 * 60 * 60 * 1000).blocked, false);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T13:30:00Z'), 2 * 60 * 60 * 1000).blocked, true);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T14:15:00Z'), 2 * 60 * 60 * 1000).blocked, true);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T14:15:01Z'), 2 * 60 * 60 * 1000).blocked, false);
  assert.equal(blockingEconomicEvent(null).blocked, true);
  assert.equal(blockingEconomicEvent({ ...snapshot, fetchedAt: '2026-08-03T12:00:00Z' }, new Date('2026-08-03T14:00:00Z')).blocked, true);

  let authorization = '';
  const providers = new WallReactionProviders('/tmp/trade', async (_url, init) => {
    authorization = String((init?.headers as any)?.Authorization || '');
    return new Response(JSON.stringify([{ date: '2026-08-03T14:00:00Z', country: 'United States', event: 'ISM', importance: 3 }]), { status: 200 });
  });
  const refreshed = await providers.refreshCalendar('private-key', new Date('2026-08-03T12:00:00Z'));
  assert.equal(refreshed.events.length, 1);
  assert.equal(authorization, 'Client private-key');
  assert.equal(providers.zeroGexPath('SPY'), '/tmp/trade/zerogex.json');
  assert.equal(providers.zeroGexPath('QQQ'), '/tmp/wall-reaction/QQQ-zerogex.json');
}

run().then(() => console.log('All WallReactionProviders tests passed!')).catch((error) => {
  console.error(error);
  process.exit(1);
});
