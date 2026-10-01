import '@fastify/postgres';
import { BrokerPositionReconciler } from './broker-position-reconciler';
import { DiscordAlertService } from './discord-alert-service';
import { constructOSITicker, parseOSITicker } from '../lib/occ-ticker';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const alerts: any[] = [];
const originalSend = DiscordAlertService.prototype.send;
DiscordAlertService.prototype.send = async function (input: any) { alerts.push(input); return true; };

// Monday 2026-10-05 10:00 ET (14:00Z) — a regular session.
const SESSION_START = new Date('2026-10-05T14:00:00.000Z');
const TICKER = 'SPY261016C00640000';

type Harness = ReturnType<typeof createHarness>;

function createHarness(options: {
  open?: any[];
  inflight?: any[];
  evidence?: any[];
  slot?: any[];
  holdings?: any[];
  orders?: any[];
  adoptError?: any;
} = {}) {
  const state = {
    records: [] as any[],
    nextRecordId: 1,
    open: options.open || [],
    inflight: options.inflight || [],
    evidence: options.evidence || [],
    slot: options.slot || [],
    holdings: options.holdings || [],
    orders: options.orders || [],
    adoptError: options.adoptError || null,
    updates: [] as Array<{ tag: string; params: any[] }>,
    inserts: [] as any[],
    events: [] as any[]
  };
  const tagOf = (sql: string) => (sql.match(/reconciler:([a-z-]+)/) || [])[1] || (sql.includes('INSERT INTO trade_events') ? 'event' : 'other');
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params: any[] = []) => {
        const tag = tagOf(sql);
        switch (tag) {
          case 'users': return { rows: [{ user_id: 7 }] };
          case 'inflight': return { rows: state.inflight };
          case 'open': return { rows: state.open.map((r) => ({ ...r })) };
          case 'records': return { rows: state.records.filter((r) => r.user_id === params[0] && !r.resolved_at).map((r) => ({ ...r })) };
          case 'insert': {
            state.records.push({ id: state.nextRecordId++, user_id: params[0], osi_ticker: params[1], position_id: params[2], mismatch_class: params[3], first_seen_at: params[4], last_seen_at: params[4], strikes: 1, resolved_at: null, action: null });
            return { rows: [], rowCount: 1 };
          }
          case 'strike': {
            const rec = state.records.find((r) => r.id === params[0]);
            if (rec) { rec.last_seen_at = params[1]; rec.strikes = params[2]; }
            return { rows: [], rowCount: 1 };
          }
          case 'resolve': {
            const rec = state.records.find((r) => r.id === params[0]);
            if (rec) { rec.resolved_at = params[1]; rec.action = rec.action || 'CLEARED'; }
            return { rows: [], rowCount: 1 };
          }
          case 'resolve-action': {
            for (const rec of state.records) {
              if (rec.user_id === params[0] && rec.osi_ticker === params[5] && rec.mismatch_class === params[6] && !rec.resolved_at) { rec.resolved_at = params[1]; rec.action = params[2]; }
            }
            return { rows: [], rowCount: 1 };
          }
          case 'note-action': {
            for (const rec of state.records) {
              if (rec.user_id === params[0] && rec.osi_ticker === params[1] && rec.mismatch_class === params[4] && !rec.resolved_at) rec.action = params[2];
            }
            return { rows: [], rowCount: 1 };
          }
          case 'close-phantom': {
            state.updates.push({ tag, params });
            const pos = state.open.find((p) => p.id === params[0]);
            if (pos) { pos.status = 'CLOSED'; state.open = state.open.filter((p) => p.id !== params[0]); return { rows: [], rowCount: 1 }; }
            return { rows: [], rowCount: 0 };
          }
          case 'evidence': return { rows: state.evidence };
          case 'slot': return { rows: state.slot };
          case 'adopt': {
            if (state.adoptError) throw state.adoptError;
            state.inserts.push(params);
            const row = { id: 900 + state.inserts.length, user_id: params[0], symbol: params[1], option_type: params[2], strike_price: params[3], expiration_date: params[4], entry_price: params[5], quantity: params[6], status: 'OPEN' };
            state.open.push(row);
            return { rows: [{ id: row.id }], rowCount: 1 };
          }
          case 'shrink': {
            state.updates.push({ tag, params });
            const pos = state.open.find((p) => p.id === params[0]);
            if (pos) pos.quantity = params[1];
            return { rows: [], rowCount: 1 };
          }
          case 'event': state.events.push(params); return { rows: [], rowCount: 1 };
          default: return { rows: [], rowCount: 0 };
        }
      }
    }
  } as any;
  const broker = {
    resolveTradingAccountIds: async () => ['7:acct-1'],
    listOptionHoldings: async () => state.holdings.map((h) => ({ ...h })),
    listRecentOrderSummaries: async () => state.orders
  };
  const reconciler = new BrokerPositionReconciler(fastify, broker as any);
  let clock = SESSION_START.getTime();
  reconciler.now = () => new Date(clock);
  const advance = (ms: number) => { clock += ms; };
  return { reconciler, state, advance, fastify };
}

const openPosition = (overrides: any = {}) => ({
  id: 501, user_id: 7, symbol: 'SPY', option_type: 'CALL', strike_price: 640, expiration_date: '2026-10-16',
  entry_price: 1.5, current_price: 1.1, quantity: 1, status: 'OPEN', execution_status: 'FILLED', strategy_managed: true,
  account_id: '7:acct-1', notes: '', ...overrides
});
const holding = (overrides: any = {}) => ({
  accountId: '7:acct-1', ticker: TICKER, optionType: 'CALL', strike: 640, expiration: '2026-10-16', underlying: 'SPY',
  units: 1, price: 1.3, averagePurchasePrice: 1.45, raw: {}, ...overrides
});

async function twoStrikes(h: Harness) {
  const first = await h.reconciler.runForUser(7);
  h.advance(5 * 60 * 1000);
  const second = await h.reconciler.runForUser(7);
  return { first, second };
}

async function testOccTickerHelpers() {
  assert(constructOSITicker('SPY', 640, 'CALL', '2026-10-16') === TICKER, 'OSI ticker is built in OCC format');
  const parsed = parseOSITicker('SPY 261016P00635500');
  assert(parsed?.symbol === 'SPY' && parsed.optionType === 'PUT' && parsed.strike === 635.5 && parsed.expiration === '2026-10-16', 'OSI ticker parses back, ignoring whitespace');
}

async function testPhantomOpenIsClosedWithBrokerFillAfterTwoStrikes() {
  alerts.length = 0;
  const h = createHarness({
    open: [openPosition()],
    holdings: [],
    orders: [{ ids: ['o-1'], ticker: TICKER, action: 'SELL_CLOSE', status: 'EXECUTED', filled: true, filledQuantity: 1, fillPrice: 1.27, placedAt: null, executedAt: '2026-10-05T13:50:00.000Z' }]
  });
  const first = await h.reconciler.runForUser(7);
  assert(first.observed === 1 && first.acted === 0 && h.state.updates.length === 0, `The first sighting only records the mismatch (got ${JSON.stringify(first)})`);
  h.advance(5 * 60 * 1000);
  const second = await h.reconciler.runForUser(7);
  assert(h.state.records.length === 1 && h.state.records[0].strikes === 2, 'The second run adds a strike to the same record');
  assert(second.acted === 1 && second.actions[0].action === 'CLOSED_LOCALLY', `The second strike closes the phantom (got ${JSON.stringify(second.actions)})`);
  const close = h.state.updates.find((u) => u.tag === 'close-phantom')!;
  assert(close.params[1] === 1.27 && close.params[3] === 'BROKER_RECONCILED_FLAT', 'The broker fill price and reason are used');
  assert(Math.abs(close.params[2] - (1.27 - 1.5) * 100) < 1e-9, 'Realized P&L is computed from the broker fill');
  assert(h.state.records[0].resolved_at && h.state.records[0].action === 'CLOSED_LOCALLY', 'The ledger row is resolved with the action');
  assert(alerts.some((a) => a.category === 'broker-reconcile' && a.severity === 'critical'), 'The operator is paged');
  assert(h.state.events.some((e) => e[3] === 'BROKER_RECONCILE_CLOSED'), 'A BROKER_RECONCILE_CLOSED event is recorded');
  assert(h.reconciler.entryBlockReason(7) === null, 'A healed class-A mismatch does not block entries');
}

async function testPhantomOpenWithoutFillIsClosedAsEstimated() {
  const h = createHarness({ open: [openPosition({ current_price: 1.05 })], holdings: [], orders: [] });
  const { second } = await twoStrikes(h);
  const close = h.state.updates.find((u) => u.tag === 'close-phantom')!;
  assert(second.acted === 1 && close.params[1] === 1.05 && close.params[3] === 'BROKER_FLAT_UNKNOWN_FILL', 'Without a broker fill the last price is used and flagged');
  assert(String(close.params[4]).includes('ESTIMATED'), 'The note says the P&L is estimated');
}

async function testTwoStrikesNeedFourMinutes() {
  const h = createHarness({ open: [openPosition()], holdings: [] });
  await h.reconciler.runForUser(7);
  h.advance(60 * 1000);
  const quick = await h.reconciler.runForUser(7);
  assert(quick.acted === 0 && h.state.records[0].strikes === 2, 'Two sightings one minute apart do not act yet');
  h.advance(4 * 60 * 1000);
  const later = await h.reconciler.runForUser(7);
  assert(later.acted === 1, 'Once four minutes have passed since first sight the action runs');
}

async function testOrphanWithOurEvidenceIsAdopted() {
  alerts.length = 0;
  const h = createHarness({
    open: [],
    holdings: [holding()],
    evidence: [{ id: 480, symbol: 'SPY', option_type: 'CALL', strike_price: 640, expiration_date: '2026-10-16', execution_status: 'ENTRY_ABANDONED', signal_id: 31, strategy_setup_id: null, account_id: '7:acct-1', execution_account_id: null, updated_at: '2026-10-05T13:00:00.000Z' }],
    orders: [{ ids: ['o-2'], ticker: TICKER, action: 'BUY_OPEN', status: 'EXECUTED', filled: true, filledQuantity: 1, fillPrice: 1.42, placedAt: null, executedAt: null }]
  });
  const first = await h.reconciler.runForUser(7);
  assert(first.acted === 0 && Boolean(h.reconciler.entryBlockReason(7)?.includes('under observation')), 'An unexplained broker position blocks entries from first sight');
  h.advance(5 * 60 * 1000);
  const second = await h.reconciler.runForUser(7);
  assert(second.acted === 1 && second.actions[0].action === 'ADOPTED', `Our own unseen fill is adopted (got ${JSON.stringify(second.actions)})`);
  const insert = h.state.inserts[0];
  assert(insert[5] === 1.42 && insert[6] === 1 && insert[8] === 15 && insert[7] === 1.14, 'Adopted with broker fill, 1 contract, 20% stop and 15% trail');
  assert(insert[12] === 31, 'The original signal id is carried over');
  assert(h.state.events.some((e) => e[3] === 'BROKER_RECONCILE_ADOPTED'), 'A BROKER_RECONCILE_ADOPTED event is recorded');
  assert(h.reconciler.entryBlockReason(7) === null, 'After adoption the user is no longer blocked');
  // Next run: the holding now matches the adopted row — nothing to do.
  h.advance(5 * 60 * 1000);
  const third = await h.reconciler.runForUser(7);
  assert(third.observed === 0, 'The adopted position reconciles cleanly on the next run');
}

async function testUnknownOrphanIsAlertOnlyAndBlocks() {
  alerts.length = 0;
  const h = createHarness({ open: [], holdings: [holding()], evidence: [], orders: [] });
  const { second } = await twoStrikes(h);
  assert(second.acted === 0 && second.unresolvedBlocking === 1 && second.actions[0].action === 'ALERT_ONLY_UNKNOWN_ORIGIN', 'An orphan without our evidence is never adopted');
  assert(h.state.inserts.length === 0, 'No position row is created for an unknown orphan');
  assert(alerts.some((a) => a.title === 'Unknown option position at broker' && a.severity === 'critical'), 'The operator is paged about the unknown position');
  const reason = h.reconciler.entryBlockReason(7);
  assert(Boolean(reason) && reason!.includes('unresolved broker mismatch'), `Entries stay blocked (${reason})`);
  assert(h.state.records[0].resolved_at === null && h.state.records[0].action === 'ALERT_ONLY_UNKNOWN_ORIGIN', 'The ledger row stays open with the action noted');
}

async function testOrphanWithSlotOccupiedIsAlertOnly() {
  const h = createHarness({
    open: [],
    holdings: [holding()],
    evidence: [{ id: 480, symbol: 'SPY', option_type: 'CALL', strike_price: 640, expiration_date: '2026-10-16', execution_status: 'CANCELED', signal_id: 31, account_id: '7:acct-1', updated_at: '2026-10-05T13:00:00.000Z' }],
    slot: [{ id: 777 }]
  });
  const { second } = await twoStrikes(h);
  assert(second.actions[0].action === 'ALERT_ONLY_SLOT_OCCUPIED' && h.state.inserts.length === 0, 'A second long is never adopted when the slot is held');
}

async function testAdoptionUniqueViolationFallsBackToAlert() {
  const err: any = new Error('duplicate key value violates unique constraint "uq_positions_swing_slot_active"');
  err.code = '23505';
  const h = createHarness({
    open: [],
    holdings: [holding()],
    evidence: [{ id: 480, symbol: 'SPY', option_type: 'CALL', strike_price: 640, expiration_date: '2026-10-16', execution_status: 'ENTRY_STALE', signal_id: 31, account_id: '7:acct-1', updated_at: '2026-10-05T13:00:00.000Z' }],
    adoptError: err
  });
  const { second } = await twoStrikes(h);
  assert(second.actions[0].action === 'ALERT_ONLY_SLOT_GUARD' && second.unresolvedBlocking === 1, 'The DB slot guard turns adoption into alert-only');
}

async function testPreconditionSkipsWhileOrderWorkInFlight() {
  const h = createHarness({ open: [openPosition()], holdings: [], inflight: [{ id: 501, status: 'OPEN', execution_status: 'PENDING_EXIT' }] });
  const result = await h.reconciler.runForUser(7);
  assert(result.skipped?.includes('order work in flight') === true && result.observed === 0, 'A pending exit makes the snapshot ambiguous; skip');
  assert(h.state.records.length === 0, 'Nothing is recorded while skipped');
}

async function testQuantityMismatches() {
  alerts.length = 0;
  const shrink = createHarness({ open: [openPosition({ quantity: 2 })], holdings: [holding({ units: 1 })] });
  const { second } = await twoStrikes(shrink);
  assert(second.actions[0].action === 'SHRUNK_TO_BROKER' && shrink.state.updates[0].params[1] === 1, 'DB > broker shrinks the local quantity');
  assert(shrink.reconciler.entryBlockReason(7) === null, 'A shrunk quantity is resolved and does not block');

  const excess = createHarness({ open: [openPosition({ quantity: 1 })], holdings: [holding({ units: 3 })] });
  const outcome = await twoStrikes(excess);
  assert(outcome.second.actions[0].action === 'ALERT_ONLY_BROKER_EXCESS' && excess.state.updates.length === 0, 'DB < broker is alert-only');
  assert(Boolean(excess.reconciler.entryBlockReason(7)), 'Unmanaged extra contracts block new entries');
}

async function testClearedMismatchResolvesLedgerRow() {
  const h = createHarness({ open: [openPosition()], holdings: [] });
  await h.reconciler.runForUser(7);
  assert(h.state.records.length === 1 && !h.state.records[0].resolved_at, 'Mismatch recorded');
  // Holding lagged the fill and now appears: the mismatch clears.
  h.state.holdings = [holding()];
  h.advance(5 * 60 * 1000);
  const result = await h.reconciler.runForUser(7);
  assert(result.observed === 0 && result.resolved === 1 && h.state.records[0].resolved_at && h.state.records[0].action === 'CLEARED', 'A cleared mismatch resolves its row without acting');
}

async function testEntryGateStaleness() {
  const h = createHarness({ open: [], holdings: [] });
  assert(h.reconciler.entryBlockReason(7, SESSION_START)?.includes('not completed yet') === true, 'Before the first run, in-session entries are blocked');
  assert(h.reconciler.entryBlockReason(7, new Date('2026-10-05T23:00:00.000Z')) === null, 'Outside the session a missing run does not block');
  await h.reconciler.runForUser(7);
  assert(h.reconciler.entryBlockReason(7) === null, 'A fresh successful run clears the gate');
  h.advance(31 * 60 * 1000);
  assert(h.reconciler.entryBlockReason(7)?.includes('stale') === true, 'A run older than 30 minutes blocks again');
}

async function testSchedule() {
  const h = createHarness({ open: [], holdings: [] });
  assert(h.reconciler.shouldRun(new Date('2026-10-05T14:00:00.000Z')) === true, 'Due immediately in-session with no prior run');
  await h.reconciler.runAll();
  assert(h.reconciler.shouldRun(new Date('2026-10-05T14:02:00.000Z')) === false, 'Not due two minutes after a run');
  assert(h.reconciler.shouldRun(new Date('2026-10-05T14:06:00.000Z')) === true, 'Due five minutes after a run');
  assert(h.reconciler.shouldRun(new Date('2026-10-05T20:10:00.000Z')) === false, 'Not due ten minutes after the close');
  assert(h.reconciler.shouldRun(new Date('2026-10-05T20:35:00.000Z')) === true, 'Due once ~30 minutes after the close');
  await h.reconciler.tick(new Date('2026-10-05T20:35:00.000Z'));
  assert(h.reconciler.shouldRun(new Date('2026-10-05T20:50:00.000Z')) === false, 'The post-close run happens once per day');
  assert(h.reconciler.shouldRun(new Date('2026-10-03T15:00:00.000Z')) === false, 'Never due on a weekend');
  assert(h.reconciler.getHealth().status === 'UP' && h.reconciler.getHealth().runs === 2, 'Health reports the runs');
}

async function runTests() {
  console.log('Running BrokerPositionReconciler tests...');
  try {
    await testOccTickerHelpers();
    await testPhantomOpenIsClosedWithBrokerFillAfterTwoStrikes();
    await testPhantomOpenWithoutFillIsClosedAsEstimated();
    await testTwoStrikesNeedFourMinutes();
    await testOrphanWithOurEvidenceIsAdopted();
    await testUnknownOrphanIsAlertOnlyAndBlocks();
    await testOrphanWithSlotOccupiedIsAlertOnly();
    await testAdoptionUniqueViolationFallsBackToAlert();
    await testPreconditionSkipsWhileOrderWorkInFlight();
    await testQuantityMismatches();
    await testClearedMismatchResolvesLedgerRow();
    await testEntryGateStaleness();
    await testSchedule();
  } finally {
    DiscordAlertService.prototype.send = originalSend;
  }
  console.log('All BrokerPositionReconciler tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
