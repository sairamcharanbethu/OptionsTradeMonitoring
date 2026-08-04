import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  blockingEconomicEvent, calendarCoversDate, mergeEconomicEvents, normalizeBeaEvents,
  providerAgeSeconds, WallReactionProviders
} from './wall-reaction-providers';
import { WALL_REACTION_BUNDLED_EVENTS } from './wall-reaction-economic-calendar';

async function run() {
  const beaEvents = normalizeBeaEvents({
    'Personal Income and Outlays': {
      release_dates: ['2026-08-26T12:30:00+00:00', 'invalid', '2026-09-30T12:30:00+00:00']
    }
  });
  assert.equal(beaEvents.length, 2);
  assert.equal(beaEvents[0].name, 'Personal Income and Outlays (PCE)');
  assert.equal(beaEvents[0].scheduledAt, '2026-08-26T12:30:00.000Z');
  assert.deepEqual(normalizeBeaEvents([]), []);
  assert.deepEqual(normalizeBeaEvents({}), []);
  assert.equal(mergeEconomicEvents(beaEvents, beaEvents).length, 2);
  assert.equal(new Set(WALL_REACTION_BUNDLED_EVENTS.map((item) => item.id)).size, WALL_REACTION_BUNDLED_EVENTS.length);
  assert.equal(WALL_REACTION_BUNDLED_EVENTS.every((item) => item.scheduledAt >= '2026-08-03' && item.scheduledAt < '2027-01-01'), true);
  assert.equal(WALL_REACTION_BUNDLED_EVENTS.find((item) => item.id === 'ism-manufacturing-2026-11-02')?.scheduledAt, '2026-11-02T15:00:00.000Z');
  assert.equal(providerAgeSeconds('2026-08-03T14:00:00Z', new Date('2026-08-03T14:00:08Z')), 8);
  assert.equal(providerAgeSeconds('2026-08-03T14:00:10Z', new Date('2026-08-03T14:00:08Z')), -2);

  const event = {
    id: 'ism-2026-08-03', name: 'ISM Manufacturing PMI', country: 'United States', importance: 3,
    source: 'ISM', scheduledAt: '2026-08-03T14:00:00.000Z'
  };
  const snapshot = {
    fetchedAt: '2026-08-03T12:00:00.000Z', coverageStart: '2026-08-03', coverageThrough: '2026-12-31', events: [event]
  };
  assert.equal(calendarCoversDate(snapshot, new Date('2026-08-03T13:00:00Z')), true);
  assert.equal(calendarCoversDate(snapshot, new Date('2027-01-01T02:00:00Z')), true);
  assert.equal(calendarCoversDate(snapshot, new Date('2027-01-01T05:00:00Z')), false);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T13:29:59Z')).blocked, false);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T13:30:00Z')).blocked, true);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T14:15:00Z')).blocked, true);
  assert.equal(blockingEconomicEvent(snapshot, new Date('2026-08-03T14:15:01Z')).blocked, false);
  assert.equal(blockingEconomicEvent({ ...snapshot, events: [] }, new Date('2026-08-04T14:00:00Z')).blocked, false);
  assert.match(blockingEconomicEvent(snapshot, new Date('2027-01-04T14:00:00Z')).reason, /coverage is unavailable/);
  assert.equal(blockingEconomicEvent(null).blocked, true);
  assert.equal(blockingEconomicEvent({ ...snapshot, fetchedAt: '2026-08-03T13:00:10Z' }, new Date('2026-08-03T13:00:00Z')).blocked, true);

  let authorization = 'not-checked';
  let requestedUrl = '';
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'wall-reaction-calendar-'));
  try {
    const providers = new WallReactionProviders(path.join(cacheRoot, 'trade'), async (url, init) => {
      requestedUrl = String(url);
      authorization = String((init?.headers as any)?.Authorization || '');
      return new Response(JSON.stringify({
        'Personal Income and Outlays': { release_dates: ['2026-08-27T12:30:00+00:00', '2027-01-29T13:30:00+00:00'] }
      }), { status: 200 });
    });
    assert.equal(providers.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).status, 'READY');
    assert.equal(providers.getCalendar().events.some((item) => item.name === 'ISM Manufacturing PMI'), true);
    assert.equal(blockingEconomicEvent(providers.getCalendar(), new Date('2026-08-03T13:30:00Z')).event?.name, 'ISM Manufacturing PMI');
    const refreshed = await providers.refreshCalendar(new Date('2026-08-03T12:00:00Z'));
    assert.equal(refreshed.events.some((item) => item.scheduledAt === '2027-01-29T13:30:00.000Z'), true);
    assert.equal(refreshed.events.some((item) => item.id === 'bea-pio-2026-08-26'), false);
    assert.equal(refreshed.events.some((item) => item.id === 'bea-pio-2026-08-27'), true);
    assert.equal(authorization, '');
    assert.equal(requestedUrl, 'https://apps.bea.gov/API/signup/release_dates.json');
    assert.equal(providers.calendarCachePath(), path.join(cacheRoot, 'wall-reaction', 'economic-calendar.json'));
    assert.equal(providers.zeroGexPath('SPY'), path.join(cacheRoot, 'trade', 'zerogex.json'));
    assert.equal(providers.zeroGexPath('QQQ'), path.join(cacheRoot, 'wall-reaction', 'QQQ-zerogex.json'));

    const restarted = new WallReactionProviders(path.join(cacheRoot, 'trade'), async () => new Response('', { status: 503 }));
    await assert.rejects(restarted.refreshCalendar(new Date('2026-08-03T12:15:00Z')), /BEA calendar request failed/);
    assert.equal(restarted.getCalendar().events.some((item) => item.scheduledAt === '2027-01-29T13:30:00.000Z'), true);
    assert.equal(restarted.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).status, 'DEGRADED');
    assert.equal(restarted.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).nextEvent?.scheduledAt, '2026-08-03T14:00:00.000Z');
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }

  const corruptRoot = await mkdtemp(path.join(os.tmpdir(), 'wall-reaction-calendar-corrupt-'));
  try {
    await mkdir(path.join(corruptRoot, 'wall-reaction'), { recursive: true });
    await writeFile(path.join(corruptRoot, 'wall-reaction', 'economic-calendar.json'), '{broken', 'utf8');
    const provider = new WallReactionProviders(path.join(corruptRoot, 'trade'), async () => new Response('', { status: 503 }));
    await assert.rejects(provider.refreshCalendar(new Date('2026-08-03T12:00:00Z')), /BEA calendar request failed/);
    assert.equal(provider.getCalendar().events.some((item) => item.name === 'ISM Manufacturing PMI'), true);
    assert.equal(provider.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).status, 'DEGRADED');
  } finally {
    await rm(corruptRoot, { recursive: true, force: true });
  }

  const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'wall-reaction-provider-'));
  try {
    const missing = new WallReactionProviders(path.join(missingRoot, 'trade'));
    await assert.rejects(missing.readZeroGex('QQQ'), /zerogex-prefetch-qqq has not produced its snapshot/);
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
}

run().then(() => console.log('All WallReactionProviders tests passed!')).catch((error) => {
  console.error(error);
  process.exit(1);
});
