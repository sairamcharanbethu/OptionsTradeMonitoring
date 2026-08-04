import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  blockingEconomicEvent, calendarCoversDate, mergeEconomicEvents, normalizeBeaEvents,
  normalizeBlsEvents, normalizeCachedEvents, providerAgeSeconds, WallReactionProviders
} from './wall-reaction-providers';
import { WALL_REACTION_BUNDLED_EVENTS } from './wall-reaction-economic-calendar';

const BLS_CALENDAR = `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:jolts-august\r
DTSTART;TZID=US-Eastern:20260804T100000\r
SUMMARY:Job Openings and Labor Turnover \r
 Survey\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:productivity-august\r
DTSTART;TZID=US-Eastern:20260806T083000\r
SUMMARY:Productivity and Costs (P)\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:cpi-august\r
DTSTART;TZID=US-Eastern:20260812T083000\r
SUMMARY:Consumer Price Index\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:employment-september\r
DTSTART;TZID=US-Eastern:20260904T083000\r
SUMMARY:Employment Situation\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ppi-november\r
DTSTART;TZID=US-Eastern:20261113T083000\r
SUMMARY:Producer Price Index\r
END:VEVENT\r
END:VCALENDAR`;

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
  const blsEvents = normalizeBlsEvents(BLS_CALENDAR);
  assert.equal(blsEvents.length, 5);
  assert.equal(blsEvents.find((item) => item.name === 'Job Openings and Labor Turnover Survey')?.scheduledAt, '2026-08-04T14:00:00.000Z');
  assert.equal(blsEvents.find((item) => item.name === 'Job Openings and Labor Turnover Survey')?.impact, 'BLOCKING');
  assert.equal(blsEvents.find((item) => item.name === 'Productivity and Costs (P)')?.impact, 'INFORMATIONAL');
  assert.equal(blsEvents.find((item) => item.name === 'Producer Price Index')?.scheduledAt, '2026-11-13T13:30:00.000Z');
  assert.deepEqual(normalizeBlsEvents('not a calendar'), []);
  assert.equal(normalizeCachedEvents([{ ...blsEvents[0], impact: undefined, importance: 3 }])[0].impact, 'BLOCKING');
  assert.deepEqual(normalizeCachedEvents([{ name: '', source: 'BLS', scheduledAt: 'invalid' }]), []);
  assert.equal(mergeEconomicEvents(beaEvents, beaEvents).length, 2);
  assert.equal(new Set(WALL_REACTION_BUNDLED_EVENTS.map((item) => item.id)).size, WALL_REACTION_BUNDLED_EVENTS.length);
  assert.equal(WALL_REACTION_BUNDLED_EVENTS.every((item) => item.scheduledAt >= '2026-08-03' && item.scheduledAt < '2027-01-01'), true);
  assert.equal(WALL_REACTION_BUNDLED_EVENTS.find((item) => item.id === 'bls-jolts-2026-08-04')?.scheduledAt, '2026-08-04T14:00:00.000Z');
  assert.equal(WALL_REACTION_BUNDLED_EVENTS.find((item) => item.id === 'census-factory-orders-2026-08-04')?.impact, 'INFORMATIONAL');
  assert.equal(WALL_REACTION_BUNDLED_EVENTS.find((item) => item.id === 'ism-manufacturing-2026-11-02')?.scheduledAt, '2026-11-02T15:00:00.000Z');
  assert.equal(providerAgeSeconds('2026-08-03T14:00:00Z', new Date('2026-08-03T14:00:08Z')), 8);
  assert.equal(providerAgeSeconds('2026-08-03T14:00:10Z', new Date('2026-08-03T14:00:08Z')), -2);

  const event = {
    id: 'ism-2026-08-03', name: 'ISM Manufacturing PMI', country: 'United States', importance: 3,
    impact: 'BLOCKING' as const, source: 'ISM', scheduledAt: '2026-08-03T14:00:00.000Z'
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
  assert.equal(blockingEconomicEvent({ ...snapshot, events: [{ ...event, importance: 1, impact: 'INFORMATIONAL' }] }, new Date('2026-08-03T14:00:00Z')).blocked, false);
  assert.equal(blockingEconomicEvent({ ...snapshot, events: [] }, new Date('2026-08-04T14:00:00Z')).blocked, false);
  assert.match(blockingEconomicEvent(snapshot, new Date('2027-01-04T14:00:00Z')).reason, /coverage is unavailable/);
  assert.equal(blockingEconomicEvent(null).blocked, true);
  assert.equal(blockingEconomicEvent({ ...snapshot, fetchedAt: '2026-08-03T13:00:10Z' }, new Date('2026-08-03T13:00:00Z')).blocked, true);

  const requestedUrls: string[] = [];
  let authorization = 'not-checked';
  let blsUserAgent = '';
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'wall-reaction-calendar-'));
  try {
    const providers = new WallReactionProviders(path.join(cacheRoot, 'trade'), async (url, init) => {
      requestedUrls.push(String(url));
      authorization = String((init?.headers as any)?.Authorization || '');
      if (String(url).includes('bls.gov')) {
        blsUserAgent = String((init?.headers as any)?.['User-Agent'] || '');
        return new Response(BLS_CALENDAR, { status: 200 });
      }
      return new Response(JSON.stringify({
        'Personal Income and Outlays': { release_dates: ['2026-08-27T12:30:00+00:00', '2027-01-29T13:30:00+00:00'] }
      }), { status: 200 });
    });
    assert.equal(providers.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).status, 'READY');
    assert.equal(providers.getCalendar().events.some((item) => item.name === 'ISM Manufacturing PMI'), true);
    assert.equal(blockingEconomicEvent(providers.getCalendar(), new Date('2026-08-03T13:30:00Z')).event?.name, 'ISM Manufacturing PMI');
    assert.equal(blockingEconomicEvent(providers.getCalendar(), new Date('2026-08-04T13:29:59Z')).blocked, false);
    assert.equal(blockingEconomicEvent(providers.getCalendar(), new Date('2026-08-04T13:30:00Z')).event?.name, 'Job Openings and Labor Turnover Survey');
    assert.equal(blockingEconomicEvent(providers.getCalendar(), new Date('2026-08-04T14:15:00Z')).blocked, true);
    assert.equal(blockingEconomicEvent(providers.getCalendar(), new Date('2026-08-04T14:15:01Z')).blocked, false);
    const refreshed = await providers.refreshCalendar(new Date('2026-08-03T12:00:00Z'));
    assert.equal(refreshed.events.some((item) => item.scheduledAt === '2027-01-29T13:30:00.000Z'), true);
    assert.equal(refreshed.events.some((item) => item.id === 'bea-pio-2026-08-26'), false);
    assert.equal(refreshed.events.some((item) => item.id === 'bea-pio-2026-08-27'), true);
    assert.equal(refreshed.events.some((item) => item.name === 'Job Openings and Labor Turnover Survey'), true);
    assert.equal(authorization, '');
    assert.match(blsUserAgent, /^StrikePilot\/1\.0/);
    assert.deepEqual(requestedUrls.sort(), [
      'https://apps.bea.gov/API/signup/release_dates.json',
      'https://www.bls.gov/schedule/news_release/bls.ics'
    ]);
    assert.equal(providers.calendarCachePath(), path.join(cacheRoot, 'wall-reaction', 'economic-calendar.json'));
    assert.equal(providers.zeroGexPath('SPY'), path.join(cacheRoot, 'trade', 'zerogex.json'));
    assert.equal(providers.zeroGexPath('QQQ'), path.join(cacheRoot, 'wall-reaction', 'QQQ-zerogex.json'));
    const persisted = JSON.parse(await readFile(providers.calendarCachePath(), 'utf8'));
    assert.equal(persisted.sources.BLS.lastRefreshAt, '2026-08-03T12:00:00.000Z');
    assert.equal(persisted.events.some((item: any) => item.name === 'Productivity and Costs (P)' && item.impact === 'INFORMATIONAL'), true);

    const partial = new WallReactionProviders(path.join(cacheRoot, 'trade'), async (url) => {
      if (String(url).includes('bls.gov')) return new Response('', { status: 503 });
      return new Response(JSON.stringify({
        'Personal Income and Outlays': { release_dates: ['2026-08-28T12:30:00+00:00', '2027-01-29T13:30:00+00:00'] }
      }), { status: 200 });
    });
    await partial.refreshCalendar(new Date('2026-08-03T12:10:00Z'));
    const partialHealth = partial.getCalendarHealth(new Date('2026-08-03T13:00:00Z'));
    assert.equal(partialHealth.status, 'DEGRADED');
    assert.equal(partialHealth.sources.find((source) => source.source === 'BLS')?.mode, 'CACHED');
    assert.equal(partialHealth.sources.find((source) => source.source === 'BLS')?.lastRefreshAt, '2026-08-03T12:00:00.000Z');
    assert.equal(partialHealth.sources.find((source) => source.source === 'BEA')?.lastRefreshAt, '2026-08-03T12:10:00.000Z');

    const restarted = new WallReactionProviders(path.join(cacheRoot, 'trade'), async () => new Response('', { status: 503 }));
    await restarted.refreshCalendar(new Date('2026-08-03T12:15:00Z'));
    assert.equal(restarted.getCalendar().events.some((item) => item.scheduledAt === '2027-01-29T13:30:00.000Z'), true);
    assert.equal(restarted.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).status, 'DEGRADED');
    assert.equal(restarted.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).nextEvent?.scheduledAt, '2026-08-03T14:00:00.000Z');
    assert.equal(restarted.getCalendarHealth(new Date('2026-08-04T13:00:00Z')).nextBlockingEvent?.name, 'Job Openings and Labor Turnover Survey');
    assert.equal(restarted.getCalendarHealth(new Date('2026-08-04T13:00:00Z')).sources.find((source) => source.source === 'BLS')?.mode, 'CACHED');
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }

  const corruptRoot = await mkdtemp(path.join(os.tmpdir(), 'wall-reaction-calendar-corrupt-'));
  try {
    await mkdir(path.join(corruptRoot, 'wall-reaction'), { recursive: true });
    await writeFile(path.join(corruptRoot, 'wall-reaction', 'economic-calendar.json'), '{broken', 'utf8');
    const provider = new WallReactionProviders(path.join(corruptRoot, 'trade'), async () => new Response('', { status: 503 }));
    await provider.refreshCalendar(new Date('2026-08-03T12:00:00Z'));
    assert.equal(provider.getCalendar().events.some((item) => item.name === 'ISM Manufacturing PMI'), true);
    assert.equal(provider.getCalendarHealth(new Date('2026-08-03T13:00:00Z')).status, 'DEGRADED');
  } finally {
    await rm(corruptRoot, { recursive: true, force: true });
  }

  const staleRoot = await mkdtemp(path.join(os.tmpdir(), 'wall-reaction-calendar-stale-'));
  try {
    await mkdir(path.join(staleRoot, 'wall-reaction'), { recursive: true });
    const staleEvents = normalizeBlsEvents(BLS_CALENDAR.replaceAll('2026', '2025'));
    await writeFile(path.join(staleRoot, 'wall-reaction', 'economic-calendar.json'), JSON.stringify({
      savedAt: '2025-08-03T12:00:00.000Z', events: staleEvents
    }), 'utf8');
    const provider = new WallReactionProviders(path.join(staleRoot, 'trade'), async () => new Response('', { status: 503 }));
    await provider.refreshCalendar(new Date('2026-08-03T12:00:00Z'));
    const health = provider.getCalendarHealth(new Date('2026-08-04T13:00:00Z'));
    assert.equal(health.sources.find((source) => source.source === 'BLS')?.mode, 'BUNDLED');
    assert.equal(health.nextBlockingEvent?.name, 'Job Openings and Labor Turnover Survey');
  } finally {
    await rm(staleRoot, { recursive: true, force: true });
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
