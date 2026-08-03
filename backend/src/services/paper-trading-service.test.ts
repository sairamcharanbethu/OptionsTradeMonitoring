import assert from 'node:assert/strict';
import { PaperTradingService } from './paper-trading-service';

async function run() {
  assert.deepEqual(
    PaperTradingService.quantityForTier(100_000, 1.53, 'CAUTIOUS'),
    { quantity: 1, maxAffordable: 653 }
  );
  assert.deepEqual(
    PaperTradingService.quantityForTier(100_000, 1.53, 'STANDARD'),
    { quantity: 2, maxAffordable: 653 }
  );
  assert.deepEqual(
    PaperTradingService.quantityForTier(100_000, 1.53, 'FULL'),
    { quantity: 3, maxAffordable: 653 }
  );
  assert.equal(PaperTradingService.quantityForTier(100, 1.53, 'FULL').quantity, 0);

  assert.deepEqual(PaperTradingService.normalizeTokenUsage({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }), {
    promptTokens: 80, completionTokens: 20, totalTokens: 100
  });
  assert.deepEqual(PaperTradingService.aiReviewReasons({ confidence_score: 92 }, { spread_pct: 4 }, 11 * 60), []);
  assert.deepEqual(
    PaperTradingService.aiReviewReasons(
      { confidence_score: 74, favoring: 'calls', market_context: { rvol_1m: 1.1 }, zerogex_decision: { gates: { calls: { warnings: ['flow is split'] } } } },
      { spread_pct: 9 },
      15 * 60
    ),
    ['borderline confidence 74', 'wider spread 9.0%', 'low relative volume 1.10', 'ZeroGEX risk warnings', 'late-session entry']
  );

  assert.deepEqual(PaperTradingService.normalizeAIDecision({
    decision: 'trade', risk_tier: 'standard', exit_profile: 'balanced_t2',
    rationale: 'Aligned and liquid', risk_flags: ['late entry']
  }), {
    decision: 'TRADE', riskTier: 'STANDARD', exitProfile: 'BALANCED_T2', source: 'AI',
    rationale: 'Aligned and liquid', riskFlags: ['late entry']
  });
  assert.equal(PaperTradingService.normalizeAIDecision({ decision: 'TRADE', risk_tier: 'UNBOUNDED', exit_profile: 'BALANCED_T2' }), null);
  assert.equal(PaperTradingService.normalizeAIDecision({ decision: 'TRADE', risk_tier: 'FULL', exit_profile: 'TRAIL_FOREVER' }), null);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const scheduledIntervals: Array<{ callback: () => void; milliseconds: number; handle: any }> = [];
  const clearedIntervals: any[] = [];
  try {
    (globalThis as any).setInterval = (callback: () => void, milliseconds: number) => {
      const handle = { milliseconds };
      scheduledIntervals.push({ callback, milliseconds, handle });
      return handle;
    };
    (globalThis as any).clearInterval = (handle: any) => { clearedIntervals.push(handle); };
    let scheduledRecoveries = 0;
    const scheduledService = new PaperTradingService({
      log: { warn() {}, info() {}, error() {} }
    } as any) as any;
    scheduledService.ensurePriorMonthReport = async () => {};
    scheduledService.recover = async () => {};
    scheduledService.recoverOverdueOpenPositions = async () => { scheduledRecoveries += 1; };
    scheduledService.start();
    scheduledService.start();
    assert.deepEqual(
      scheduledIntervals.map(interval => interval.milliseconds),
      [60 * 60 * 1000, 60 * 1000],
      'paper automation must schedule one monthly report timer and one idempotent minute exit recovery timer'
    );
    scheduledIntervals[1].callback();
    assert.equal(scheduledRecoveries, 1, 'the one-minute sweep must invoke overdue paper-exit recovery');
    scheduledService.stop();
    assert.equal(clearedIntervals.length, 2, 'stopping paper automation must clear both timers');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  const positionUpdates: any[][] = [];
  const liveWrites: Array<{ key: string; values: Record<string, any> }> = [];
  let quoteRequests = 0;
  let equityRefreshes = 0;
  const storedSnapshot = { state: 'ACTIVE', lifecycle: { entry_allowed: true }, setup_id: 'old-setup' };
  const openPosition = {
    id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    strike_price: 753,
    expiration_date: '2026-08-03',
    entry_price: 0.97,
    current_price: 1.24,
    quantity: 1,
    contracts_requested: 1,
    trailing_high_price: 1.24,
    suggested_stop_loss: 753,
    suggested_take_profit_1: 755,
    suggested_take_profit_2: 756,
    strategy_setup_id: 'old-setup',
    strategy_snapshot: storedSnapshot,
    paper_decision_id: 11,
    exit_profile: 'BALANCED_T2',
    policy_version: 'paper-exit-v2',
    decision_trailing_stop_pct: 15,
    analysis_data: { originalQuantity: 1, t1Reached: false, trailingStopPct: 15 }
  };
  const pg = {
    query: async (sql: string, values: any[] = []) => {
      if (sql.includes('FROM positions p') && sql.includes("p.status='OPEN'")) return { rows: [openPosition] };
      if (sql.includes('SELECT * FROM paper_accounts')) return { rows: [{
        id: 'strategy-system',
        cash_balance: 99_903,
        equity: 100_027,
        high_water_mark: 100_027,
        start_of_day_equity: 100_000,
        automation_status: 'ACTIVE'
      }] };
      if (sql.includes('FROM settings s')) return { rows: [] };
      if (sql.includes('SELECT * FROM paper_trade_decisions')) return { rows: [] };
      if (sql.includes('SELECT * FROM paper_orders')) return { rows: [] };
      if (sql.includes('SELECT * FROM paper_monthly_reports')) return { rows: [] };
      if (sql.includes("COUNT(*) FILTER (WHERE intent='ENTRY'")) return { rows: [{ entries: 1 }] };
      if (sql.includes('AS daily_calls')) return { rows: [{ daily_calls: 0, daily_tokens: 0, monthly_calls: 0, monthly_tokens: 0 }] };
      if (sql.includes('SELECT * FROM paper_trade_journal')) return { rows: [] };
      if (sql.includes('AS closed_trades')) return { rows: [{ closed_trades: 0, wins: 0, open_trades: 1, realized_pnl: 0, managed_realized_pnl: 0 }] };
      if (sql.includes('UPDATE positions SET current_price')) positionUpdates.push(values);
      if (sql.includes('UPDATE paper_accounts pa SET')) equityRefreshes += 1;
      return { rows: [] };
    }
  };
  const liveState = new Map<string, Record<string, string>>();
  const redis = {
    isReady: () => true,
    hgetall: async (key: string) => liveState.get(key) || {},
    hset: async (key: string, values: Record<string, any>) => {
      liveWrites.push({ key, values });
      liveState.set(key, Object.fromEntries(Object.entries(values).map(([field, value]) => [field, String(value)])));
    },
    del: async (key: string) => { liveState.delete(key); }
  };
  const service = new PaperTradingService({
    pg,
    ibkrMarketData: {
      getOptionQuoteForOsi: async () => {
        quoteRequests += 1;
        return { bid: 1.31 };
      }
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  service.expirationExitIntent = () => null;
  await service.refreshOpenPositions({
    state: 'ACTIVE',
    spot: 754.56,
    lifecycle: { entry_allowed: true },
    call_setup: { option: { local_symbol: 'SPY  260803C00755000', bid: 0.58, quote_age_seconds: 0.1 } }
  }, 'new-setup');
  assert.equal(quoteRequests, 1, 'an older open setup must be repriced from its own OSI contract');
  assert.equal(liveWrites.length, 1, 'an older open setup must remain under active Redis management');
  assert.equal(liveWrites[0].key, 'paper:position:7:live');
  assert.equal(liveWrites[0].values.currentPrice, 1.31, 'Redis must retain the latest option bid');
  assert.equal(liveWrites[0].values.underlyingPrice, 754.56, 'Redis must retain the latest SPY spot for exits');
  assert.deepEqual(JSON.parse(liveWrites[0].values.analysis), {
    originalQuantity: 1,
    t1Reached: false,
    trailingStopPct: 15,
    trailingHighPremium: 1.31,
    policyVersion: 'paper-exit-v2',
    trailingActive: false,
    trailingStopPremium: null
  });
  assert.equal(positionUpdates.length, 0, 'live paper repricing must not update PostgreSQL positions');
  assert.equal(equityRefreshes, 0, 'live paper repricing must not update PostgreSQL equity');
  const summary = await service.getAccountSummary();
  assert.equal(summary.openPositions[0].current_price, 1.31, 'paper summary must overlay the Redis option mark');
  assert.equal(summary.account.equity, 100_034, 'paper summary must calculate live equity from cash and the Redis mark');
  assert.equal(summary.session.pnl, 34, 'paper summary must calculate live session P&L without a PostgreSQL write');
  assert.equal(summary.limits.maxOpenPositions, null, 'paper trading must not expose a concurrent-position ceiling');

  const checkpointAccount = {
    id: 'strategy-system', cash_balance: 99_500, reserved_cash: 0,
    equity: 100_000, high_water_mark: 100_000
  };
  const checkpointPositions = [
    { id: 21, entry_price: 1, current_price: 1, quantity: 1, status: 'OPEN' },
    { id: 22, entry_price: 2, current_price: 2, quantity: 2, status: 'OPEN' }
  ];
  let capturedSnapshotValues: any[] | null = null;
  const checkpointPg = {
    query: async (sql: string, values: any[] = []) => {
      if (sql.includes('SELECT * FROM paper_accounts')) return { rows: [checkpointAccount] };
      if (sql.includes("FROM positions WHERE paper_account_id=$1 AND status='OPEN'")) return { rows: checkpointPositions };
      if (sql.includes('SUM(realized_pnl)')) return { rows: [{ realized: 25 }] };
      if (sql.includes('UPDATE paper_accounts pa SET')) {
        checkpointAccount.equity = values[0];
        checkpointAccount.high_water_mark = Math.max(checkpointAccount.high_water_mark, Number(values[0]));
      }
      if (sql.includes('INSERT INTO paper_equity_snapshots')) capturedSnapshotValues = values;
      return { rows: [] };
    }
  };
  const checkpointLiveState = new Map<string, Record<string, string>>([
    ['paper:position:21:live', { currentPrice: '1.5', updatedAt: new Date().toISOString() }],
    ['paper:position:22:live', { currentPrice: '2.5', updatedAt: new Date().toISOString() }]
  ]);
  const checkpointService = new PaperTradingService({
    pg: checkpointPg,
    log: { warn() {}, info() {}, error() {} }
  } as any, {
    isReady: () => true,
    hgetall: async (key: string) => checkpointLiveState.get(key) || {}
  }) as any;
  await checkpointService.refreshAccountEquity();
  await checkpointService.captureEquity();
  assert.equal(checkpointAccount.equity, 100_150,
    'a durable checkpoint must value every concurrent position from its Redis mark');
  assert.deepEqual((capturedSnapshotValues as unknown as any[]).slice(1), [100_150, 99_500, 0, 25, 150],
    'the equity snapshot must persist combined realized and Redis-priced unrealized P&L');

  let blockedDatabaseQueries = 0;
  const blockedService = new PaperTradingService({
    pg: { query: async () => { blockedDatabaseQueries += 1; return { rows: [] }; } },
    log: { warn() {}, info() {}, error() {} }
  } as any, { isReady: () => false }) as any;
  await blockedService.processSnapshot({ state: 'ACTIVE', lifecycle: { entry_allowed: true } }, 'redis-required').then(
    () => { throw new Error('Redis outage must stop autonomous paper processing'); },
    (error: Error) => assert.match(error.message, /Redis is required/)
  );
  assert.equal(blockedDatabaseQueries, 0, 'a Redis outage must not fall back to live PostgreSQL mutations');

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  let sessionConnections = 0;
  const sessionService = new PaperTradingService({
    pg: {
      query: async () => ({ rows: [{ id: 'strategy-system', start_of_day_date: today }] }),
      connect: async () => { sessionConnections += 1; throw new Error('same-day rollover must not start a transaction'); }
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  await sessionService.rollSessionIfNeeded();
  assert.equal(sessionConnections, 0, 'normal snapshots must not write PostgreSQL account equity');

  const serializedService = new PaperTradingService({ log: { warn() {}, info() {}, error() {} } } as any, redis) as any;
  let activeSnapshots = 0;
  let maxActiveSnapshots = 0;
  const processedSetups: string[] = [];
  serializedService.processSnapshotOnce = async (_signal: any, setupId: string) => {
    activeSnapshots += 1;
    maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
    processedSetups.push(setupId);
    await new Promise(resolve => setTimeout(resolve, 5));
    activeSnapshots -= 1;
  };
  const firstSnapshot = serializedService.processSnapshot({ state: 'ACTIVE' }, 'setup-one');
  const secondSnapshot = serializedService.processSnapshot({ state: 'ACTIVE' }, 'setup-two');
  const thirdSnapshot = serializedService.processSnapshot({ state: 'ACTIVE' }, 'setup-three');
  await Promise.all([firstSnapshot, secondSnapshot, thirdSnapshot]);
  assert.equal(maxActiveSnapshots, 1, 'different strategy setups must never mutate the paper ledger concurrently');
  assert.deepEqual(processedSetups, ['setup-one', 'setup-two', 'setup-three'],
    'every distinct queued setup must run without overlapping ledger mutations');

  const failureQueueService = new PaperTradingService({ log: { warn() {}, info() {}, error() {} } } as any, redis) as any;
  failureQueueService.processSnapshotOnce = async (_signal: any, setupId: string) => {
    failureQueueService.lastError = null;
    if (setupId === 'setup-fails') throw new Error('first setup failed');
  };
  const failedSnapshot = failureQueueService.processSnapshot({ state: 'ACTIVE' }, 'setup-fails');
  const successfulSnapshot = failureQueueService.processSnapshot({ state: 'ACTIVE' }, 'setup-succeeds');
  await Promise.all([failedSnapshot, successfulSnapshot]).then(
    () => { throw new Error('a queued setup failure must be surfaced'); },
    (error: Error) => assert.match(error.message, /first setup failed/)
  );
  assert.equal(failureQueueService.getHealth().lastError, 'first setup failed',
    'a later queued success must not erase an earlier setup failure from paper health');

  let concurrentCapacityQueries = 0;
  let concurrentOrderCreated = false;
  let concurrentPendingProcessed = false;
  const concurrentEntryClient = {
    query: async (sql: string) => {
      if (sql.includes('SELECT cash_balance, reserved_cash, automation_status')) {
        return { rows: [{ cash_balance: 99_000, reserved_cash: 0, automation_status: 'ACTIVE' }] };
      }
      if (sql.includes('INSERT INTO paper_orders')) {
        concurrentOrderCreated = true;
        return { rows: [{ id: 301 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const concurrentEntryService = new PaperTradingService({
    pg: {
      query: async (sql: string) => {
        if (sql.includes('COUNT(*) FROM positions')) {
          concurrentCapacityQueries += 1;
          return { rows: [{ count: 1 }] };
        }
        if (sql.includes('SELECT * FROM paper_accounts')) {
          return { rows: [{ cash_balance: 99_000, reserved_cash: 0, automation_status: 'ACTIVE' }] };
        }
        if (sql.includes('SELECT id FROM paper_trade_decisions')) return { rows: [] };
        if (sql.includes('FROM settings s')) return { rows: [] };
        if (sql.includes('SELECT id FROM signals')) return { rows: [{ id: 201 }] };
        if (sql.includes('INSERT INTO paper_trade_decisions')) return { rows: [{
          id: 202, setup_id: 'concurrent-setup', signal_id: 201, decision: 'TRADE',
          policy_version: 'paper-exit-v2', quantity: 2
        }] };
        return { rows: [] };
      },
      connect: async () => concurrentEntryClient
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  concurrentEntryService.processPendingEntry = async () => { concurrentPendingProcessed = true; };
  await concurrentEntryService.maybeCreateEntry({
    state: 'ACTIVE',
    generated_at: Date.now() / 1000,
    lifecycle: { entry_allowed: true },
    favoring: 'calls',
    confidence_score: 90,
    market_context: { rvol_1m: 1.5 },
    call_setup: {
      invalidation: 754,
      targets: [756, 757],
      option: {
        eligible: true,
        bid: 0.49,
        ask: 0.50,
        mid: 0.495,
        spread_pct: 2,
        quote_age_seconds: 0.1,
        expiry: '2026-08-03',
        local_symbol: 'SPY 260803C00756000',
        strike: 756
      }
    }
  }, 'concurrent-setup');
  assert.equal(concurrentCapacityQueries, 0,
    'an existing paper position must not be queried as a capacity blocker for a distinct setup');
  assert.equal(concurrentOrderCreated, true, 'a distinct qualified setup must reserve its own paper entry');
  assert.equal(concurrentPendingProcessed, true, 'a newly reserved concurrent entry must proceed to autonomous fill processing');

  let invalidQuoteQueries = 0;
  const invalidQuoteService = new PaperTradingService({
    pg: { query: async () => { invalidQuoteQueries += 1; return { rows: [] }; } },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  const otherwiseEligibleSignal = {
    state: 'ACTIVE',
    generated_at: Date.now() / 1000,
    lifecycle: { entry_allowed: true },
    favoring: 'calls',
    call_setup: {
      option: {
        eligible: true,
        bid: 0.49,
        ask: 0.50,
        expiry: '2026-08-03',
        local_symbol: 'SPY 260803C00756000',
        strike: 756
      }
    }
  };
  await invalidQuoteService.maybeCreateEntry(otherwiseEligibleSignal, 'missing-quote-age');
  assert.equal(invalidQuoteQueries, 0, 'an option quote without a provider age must not reach autonomous paper reservation');
  await invalidQuoteService.maybeCreateEntry({
    ...otherwiseEligibleSignal,
    generated_at: Date.now() / 1000 + 60,
    call_setup: { option: { ...otherwiseEligibleSignal.call_setup.option, quote_age_seconds: 0.1 } }
  }, 'future-snapshot');
  assert.equal(invalidQuoteQueries, 0, 'a future-dated strategy snapshot must not reach autonomous paper reservation');

  let invalidFillConnections = 0;
  const invalidFillOrder = {
    id: 30,
    option_type: 'CALL',
    osi_ticker: 'SPY 260803C00755000',
    expires_at: new Date(Date.now() + 60_000).toISOString()
  };
  const invalidFillService = new PaperTradingService({
    pg: {
      query: async (sql: string) => {
        if (sql.includes('FROM paper_orders po')) return { rows: [{ ...invalidFillOrder, setup_id: 'missing-fill-age' }] };
        if (sql.includes('SELECT * FROM paper_accounts')) return { rows: [{ automation_status: 'ACTIVE' }] };
        return { rows: [] };
      },
      connect: async () => { invalidFillConnections += 1; throw new Error('stale quote must not start a fill transaction'); }
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  await invalidFillService.processPendingEntry({
    state: 'ACTIVE',
    generated_at: Date.now() / 1000,
    lifecycle: { entry_allowed: true },
    call_setup: { option: { eligible: true, local_symbol: invalidFillOrder.osi_ticker, bid: 0.58, ask: 0.59 } }
  }, 'missing-fill-age');
  assert.equal(invalidFillConnections, 0, 'a pending order must not fill without a provider quote age');

  const entryQueries: string[] = [];
  let entryRedisDeletes = 0;
  const entryOrder = {
    id: 31,
    decision_id: 41,
    setup_id: 'entry-rollback',
    signal_id: 51,
    option_type: 'CALL',
    osi_ticker: 'SPY 260803C00755000',
    strike: 755,
    expiration: '2026-08-03',
    quantity: 1,
    limit_price: 0.59,
    reserved_debit: 59,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    exit_profile: 'BALANCED_T2',
    policy_version: 'paper-exit-v2',
    trailing_stop_pct: 15
  };
  const entryClient = {
    query: async (sql: string) => {
      entryQueries.push(sql);
      if (sql.includes('SELECT automation_status FROM paper_accounts')) return { rows: [{ automation_status: 'ACTIVE' }] };
      if (sql.includes('SELECT status FROM paper_orders')) return { rows: [{ status: 'PENDING' }] };
      if (sql.includes('INSERT INTO positions')) return { rows: [{
        id: 61,
        current_price: 0.58,
        trailing_high_price: 0.59,
        trailing_stop_loss_pct: 15,
        suggested_stop_loss: 753.78,
        analysis_data: { originalQuantity: 1, t1Reached: false }
      }] };
      return { rows: [] };
    },
    release() {}
  };
  const entryService = new PaperTradingService({
    pg: {
      query: async (sql: string) => {
        if (sql.includes('FROM paper_orders po')) return { rows: [entryOrder] };
        if (sql.includes('SELECT * FROM paper_accounts')) return { rows: [{ automation_status: 'ACTIVE' }] };
        return { rows: [] };
      },
      connect: async () => entryClient
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, {
    isReady: () => true,
    hset: async () => {},
    hgetall: async () => ({}),
    del: async () => { entryRedisDeletes += 1; }
  }) as any;
  await entryService.processPendingEntry({
    state: 'ACTIVE',
    generated_at: Date.now() / 1000,
    lifecycle: { entry_allowed: true },
    call_setup: {
      invalidation: 753.78,
      targets: [755, 755.46],
      option: { eligible: true, local_symbol: entryOrder.osi_ticker, bid: 0.58, ask: 0.59, quote_age_seconds: 0.1 }
    }
  }, entryOrder.setup_id).then(
    () => { throw new Error('An unverified Redis entry state must not commit the PostgreSQL fill'); },
    (error: Error) => assert.match(error.message, /Redis did not persist live paper state/)
  );
  assert.ok(entryQueries.includes('ROLLBACK'), 'entry must roll back when Redis state cannot be verified');
  assert.ok(!entryQueries.includes('COMMIT'), 'entry must not commit before Redis state is durable');
  assert.equal(entryRedisDeletes, 1, 'a rolled-back entry must remove any partial Redis state');

  const exitQueries: string[] = [];
  let exitOrderMetadata: Record<string, any> = {};
  let exitJournalMetadata: Record<string, any> = {};
  const exitClient = {
    query: async (sql: string, values: any[] = []) => {
      exitQueries.push(sql);
      if (sql.includes('FROM positions') && sql.includes('FOR UPDATE')) return { rows: [{ quantity: 2, status: 'OPEN', realized_pnl: 0 }] };
      if (sql.includes('INSERT INTO paper_orders')) {
        exitOrderMetadata = JSON.parse(values[12]);
        return { rows: [{ id: 71 }] };
      }
      if (sql.includes('INSERT INTO paper_trade_journal')) exitJournalMetadata = JSON.parse(values[10]);
      if (sql.includes('SELECT * FROM paper_accounts')) return { rows: [{
        equity: 100_000, cash_balance: 99_900, reserved_cash: 0
      }] };
      if (sql.includes('AS realized')) return { rows: [{ realized: 53, unrealized: 0 }] };
      return { rows: [] };
    },
    release() {}
  };
  const exitService = new PaperTradingService({
    pg: {
      connect: async () => exitClient,
      query: async () => ({ rows: [] })
    },
    log: { warn() {}, info() {}, error() {} },
    websocketServer: null
  } as any, {
    isReady: () => true,
    hset: async () => {},
    hgetall: async () => ({}),
    del: async () => {}
  }) as any;
  await exitService.closePaperQuantity({
    id: 81,
    paper_decision_id: 91,
    strategy_setup_id: 'partial-exit',
    signal_id: 101,
    option_type: 'CALL',
    strike_price: 755,
    expiration_date: '2026-08-03',
    entry_price: 0.97,
    quantity: 2,
    underlying_price: 755,
    trailing_high_price: 1.5,
    trailing_stop_loss_pct: 15,
    suggested_stop_loss: 754.39,
    analysis_data: { originalQuantity: 2, t1Reached: true }
  }, 1, 1.5, 'TARGET_1_TRIM', { requestedByUserId: 7, quoteAgeMs: 900 }).then(
    () => { throw new Error('The Redis verification failure should be surfaced after the durable exit commit'); },
    (error: Error) => assert.match(error.message, /Redis did not persist live paper state/)
  );
  const exitCommitIndex = exitQueries.indexOf('COMMIT');
  assert.ok(exitCommitIndex > -1, 'a partial exit must commit its durable ledger even if the subsequent Redis refresh fails');
  assert.ok(exitQueries.findIndex(sql => sql.includes('INSERT INTO paper_trade_journal')) < exitCommitIndex,
    'the exit journal must be inside the committed transaction');
  assert.ok(exitQueries.findIndex(sql => sql.includes('INSERT INTO paper_equity_snapshots')) < exitCommitIndex,
    'the exit equity checkpoint must be inside the committed transaction');
  assert.equal(exitOrderMetadata.requestedByUserId, 7, 'exit order evidence must retain the requesting administrator');
  assert.equal(exitJournalMetadata.quoteAgeMs, 900, 'exit journal evidence must retain quote freshness');

  const duplicateExitQueries: string[] = [];
  const duplicateExitService = new PaperTradingService({
    pg: {
      connect: async () => ({
        query: async (sql: string) => {
          duplicateExitQueries.push(sql);
          if (sql.includes('FROM positions') && sql.includes('FOR UPDATE')) {
            return { rows: [{ quantity: 0, status: 'CLOSED', realized_pnl: 53 }] };
          }
          return { rows: [] };
        },
        release() {}
      })
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  await duplicateExitService.closePaperQuantity({
    ...openPosition,
    id: 82,
    quantity: 1,
    strategy_setup_id: 'duplicate-exit'
  }, 1, 1.5, 'TRAILING_STOP');
  assert.ok(duplicateExitQueries.includes('ROLLBACK'), 'an already-closed position must end the duplicate exit transaction');
  assert.ok(!duplicateExitQueries.some(sql => sql.includes('INSERT INTO paper_orders')),
    'an already-closed position must not create another exit or credit cash again');

  const calendarService = new PaperTradingService({
    pg: { query: async () => ({ rows: [] }) },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  assert.equal(calendarService.exitAlertType('END_OF_DAY_RECOVERY'), 'EOD', 'recovered EOD exits must not be mislabeled as stop losses');
  assert.equal(calendarService.exitAlertType('STRATEGY_TERMINAL'), 'EXIT', 'strategy-terminal exits must use a neutral exit alert');
  assert.equal(calendarService.exitAlertType('MANUAL_EXIT'), 'EXIT', 'manual exits must use a neutral exit alert');
  assert.equal(calendarService.exitAlertType('PREMIUM_STOP'), 'SL', 'premium stops must remain stop-loss alerts');
  assert.equal(
    calendarService.mandatoryFlattenDue({ expiration_date: '2026-11-27' }, new Date('2026-11-27T17:20:00.000Z')),
    true,
    'paper 0DTE flatten must begin 40 minutes before an early close'
  );
  assert.equal(
    calendarService.mandatoryFlattenDue({ expiration_date: '2026-11-28' }, new Date('2026-11-27T17:20:00.000Z')),
    false,
    'paper flatten must not close a later-dated contract'
  );
  assert.equal(
    calendarService.expirationExitIntent({ expiration_date: '2026-11-27' }, new Date('2026-11-27T18:05:00.000Z')),
    'END_OF_DAY_RECOVERY',
    'a missed early-close flatten must remain recoverable after the market closes'
  );
  assert.equal(
    calendarService.expirationExitIntent({ expiration_date: '2026-11-26' }, new Date('2026-11-27T18:05:00.000Z')),
    'EXPIRED_RECOVERY',
    'an expired paper contract must remain recoverable on a later date'
  );

  const manualPosition = {
    ...openPosition,
    id: 91,
    strategy_setup_id: 'manual-close-setup',
    quantity: 1,
    entry_price: 1.20,
    current_price: 0.90
  };
  let manualCloseCall: any = null;
  let manualQuoteTicker = '';
  let manualFinalExitReason = 'MANUAL_EXIT';
  const manualCloseService = new PaperTradingService({
    pg: {
      query: async (sql: string) => sql.includes('SELECT status, exit_reason')
        ? { rows: [{ status: 'CLOSED', exit_reason: manualFinalExitReason, exit_price: 0.85, realized_pnl: -35 }] }
        : { rows: [manualPosition] }
    },
    ibkrMarketData: {
      getOptionQuoteForOsi: async (_userId: number | null, ticker: string) => {
        manualQuoteTicker = ticker;
        return { source: 'ibkr', bid: 0.85, quoteAgeMs: 900, timestamp: '2026-08-03T15:00:00.000Z' };
      }
    },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  manualCloseService.getLivePosition = async () => ({ currentPrice: 0.90, underlyingPrice: 752, analysis: {} });
  manualCloseService.closePaperQuantity = async (...args: any[]) => { manualCloseCall = args; };
  const manualCloseResult = await manualCloseService.closeOpenPosition(91, 7);
  assert.equal(manualQuoteTicker, 'SPY260803C00753000', 'manual close must quote the exact paper OSI contract');
  assert.equal(manualCloseCall[2], 0.85, 'manual close must sell at the fresh IBKR bid');
  assert.equal(manualCloseCall[3], 'MANUAL_EXIT', 'manual close must use an auditable exit intent');
  assert.equal(manualCloseCall[4].requestedByUserId, 7, 'manual close must journal the requesting administrator');
  assert.equal(manualCloseResult.realizedPnl, -35, 'manual close must report the realized one-contract loss');
  assert.equal(manualCloseResult.warning, null, 'a clean manual close must not report a runtime warning');

  manualCloseService.closePaperQuantity = async () => { throw new Error('Redis cleanup failed after commit'); };
  const committedWithWarning = await manualCloseService.closeOpenPosition(91, 7);
  assert.match(committedWithWarning.warning, /live cache cleanup needs attention/, 'a durable manual close must return a safe warning instead of a false failure');

  manualCloseService.closePaperQuantity = async () => {};
  manualFinalExitReason = 'TARGET_2';
  await assert.rejects(
    () => manualCloseService.closeOpenPosition(91, 7),
    (error: any) => error.statusCode === 409 && /closed concurrently as TARGET_2/.test(error.message),
    'manual close must not claim an automatic concurrent exit as its own fill'
  );
  manualFinalExitReason = 'MANUAL_EXIT';

  manualCloseService.fastify.ibkrMarketData.getOptionQuoteForOsi = async () => ({ source: 'ibkr', bid: 0.85, quoteAgeMs: null });
  manualCloseCall = null;
  await assert.rejects(
    () => manualCloseService.closeOpenPosition(91, 7),
    (error: any) => error.statusCode === 409 && /no older than 15 seconds/.test(error.message),
    'manual close must reject a quote without a trustworthy provider age'
  );
  assert.equal(manualCloseCall, null, 'a stale manual close must not enter the ledger path');

  let overdueExitIntent = '';
  let overdueExitBid = -1;
  const overduePosition = {
    id: 92,
    option_type: 'CALL',
    strike_price: 755,
    expiration_date: '2026-08-03',
    strategy_setup_id: 'overdue-setup',
    strategy_snapshot: {},
    entry_price: 0.97,
    current_price: 1.24,
    quantity: 1,
    suggested_stop_loss: 750,
    suggested_take_profit_1: 760,
    suggested_take_profit_2: 762,
    trailing_high_price: 1.24,
    trailing_stop_loss_pct: 15,
    exit_profile: 'BALANCED_T2',
    policy_version: 'paper-exit-v2',
    analysis_data: {}
  };
  const overdueService = new PaperTradingService({
    pg: {
      query: async (sql: string) => sql.includes('JOIN paper_trade_decisions')
        ? { rows: [overduePosition] }
        : sql.includes('SELECT * FROM positions WHERE id=')
          ? { rows: [{ ...overduePosition, status: 'OPEN' }] }
          : { rows: [] }
    },
    ibkrMarketData: { getOptionQuoteForOsi: async () => null },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  overdueService.expirationExitIntent = () => 'END_OF_DAY_RECOVERY';
  overdueService.getLivePosition = async () => ({ currentPrice: 1.24, analysis: {} });
  overdueService.setLivePosition = async () => new Date().toISOString();
  overdueService.closePaperQuantity = async (_position: any, _quantity: number, bid: number, intent: string) => {
    overdueExitBid = bid;
    overdueExitIntent = intent;
  };
  await overdueService.refreshOpenPositions({
    spot: 755,
    state: 'ACTIVE',
    lifecycle: { status: 'ACTIVE' },
    call_setup: { option: {} }
  }, 'different-setup');
  assert.equal(overdueExitIntent, 'END_OF_DAY_RECOVERY', 'an overdue 0DTE paper position must close without a fresh option bid');
  assert.equal(overdueExitBid, 1.24, 'overdue recovery should use the last Redis mark when IBKR has no bid');

  let restartRecoveryIntent = '';
  const restartRecoveryService = new PaperTradingService({
    pg: { query: async () => ({ rows: [overduePosition] }) },
    ibkrMarketData: { getOptionQuoteForOsi: async () => null },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  restartRecoveryService.expirationExitIntent = () => 'END_OF_DAY_RECOVERY';
  restartRecoveryService.getLivePosition = async () => ({ currentPrice: 1.24, analysis: {} });
  restartRecoveryService.closePaperQuantity = async (_position: any, _quantity: number, _bid: number, intent: string) => {
    restartRecoveryIntent = intent;
  };
  await restartRecoveryService.recoverOverdueOpenPositions();
  assert.equal(restartRecoveryIntent, 'END_OF_DAY_RECOVERY', 'service restart recovery must close an overdue open paper position');

  let premiumStopIntent = '';
  const premiumStopPosition = {
    id: 93,
    option_type: 'CALL',
    strike_price: 755,
    expiration_date: '2026-08-04',
    strategy_setup_id: 'premium-stop-setup',
    strategy_snapshot: {},
    entry_price: 1,
    current_price: 1,
    stop_loss_trigger: 0.8,
    quantity: 1,
    suggested_stop_loss: 99,
    suggested_take_profit_1: 110,
    suggested_take_profit_2: 112,
    trailing_high_price: 1,
    trailing_stop_loss_pct: 15,
    exit_profile: 'BALANCED_T2',
    policy_version: 'paper-exit-v2',
    analysis_data: {}
  };
  const premiumStopService = new PaperTradingService({
    pg: {
      query: async (sql: string) => sql.includes('JOIN paper_trade_decisions')
        ? { rows: [premiumStopPosition] }
        : { rows: [] }
    },
    ibkrMarketData: { getOptionQuoteForOsi: async () => null },
    log: { warn() {}, info() {}, error() {} }
  } as any, redis) as any;
  premiumStopService.getLivePosition = async () => null;
  premiumStopService.setLivePosition = async () => new Date().toISOString();
  premiumStopService.closePaperQuantity = async (_position: any, _quantity: number, _bid: number, intent: string) => {
    premiumStopIntent = intent;
  };
  await premiumStopService.refreshOpenPositions({
    spot: 100,
    state: 'ACTIVE',
    lifecycle: { status: 'ACTIVE' },
    call_setup: {
      option: {
        local_symbol: 'SPY260804C00755000',
        bid: 0.79,
        quote_age_seconds: 0.1
      }
    }
  }, 'premium-stop-setup');
  assert.equal(premiumStopIntent, 'PREMIUM_STOP', 'the stored 20% paper premium stop must be enforced');

  console.log('All PaperTradingService tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
