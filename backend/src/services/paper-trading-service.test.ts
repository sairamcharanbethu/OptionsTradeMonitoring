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
  service.mandatoryFlattenDue = () => false;
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
  await Promise.all([firstSnapshot, secondSnapshot]);
  assert.equal(maxActiveSnapshots, 1, 'different strategy setups must never mutate the paper ledger concurrently');
  assert.deepEqual(processedSetups, ['setup-one', 'setup-two'], 'the latest queued setup must run after the active setup');

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
    lifecycle: { entry_allowed: true },
    call_setup: {
      invalidation: 753.78,
      targets: [755, 755.46],
      option: { local_symbol: entryOrder.osi_ticker, bid: 0.58, ask: 0.59, quote_age_seconds: 0.1 }
    }
  }, entryOrder.setup_id).then(
    () => { throw new Error('An unverified Redis entry state must not commit the PostgreSQL fill'); },
    (error: Error) => assert.match(error.message, /Redis did not persist live paper state/)
  );
  assert.ok(entryQueries.includes('ROLLBACK'), 'entry must roll back when Redis state cannot be verified');
  assert.ok(!entryQueries.includes('COMMIT'), 'entry must not commit before Redis state is durable');
  assert.equal(entryRedisDeletes, 1, 'a rolled-back entry must remove any partial Redis state');

  const exitQueries: string[] = [];
  const exitClient = {
    query: async (sql: string) => {
      exitQueries.push(sql);
      if (sql.includes('FROM positions') && sql.includes('FOR UPDATE')) return { rows: [{ quantity: 2, status: 'OPEN', realized_pnl: 0 }] };
      if (sql.includes('INSERT INTO paper_orders')) return { rows: [{ id: 71 }] };
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
  }, 1, 1.5, 'TARGET_1_TRIM').then(
    () => { throw new Error('The Redis verification failure should be surfaced after the durable exit commit'); },
    (error: Error) => assert.match(error.message, /Redis did not persist live paper state/)
  );
  const exitCommitIndex = exitQueries.indexOf('COMMIT');
  assert.ok(exitCommitIndex > -1, 'a partial exit must commit its durable ledger even if the subsequent Redis refresh fails');
  assert.ok(exitQueries.findIndex(sql => sql.includes('INSERT INTO paper_trade_journal')) < exitCommitIndex,
    'the exit journal must be inside the committed transaction');
  assert.ok(exitQueries.findIndex(sql => sql.includes('INSERT INTO paper_equity_snapshots')) < exitCommitIndex,
    'the exit equity checkpoint must be inside the committed transaction');

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

  console.log('All PaperTradingService tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
