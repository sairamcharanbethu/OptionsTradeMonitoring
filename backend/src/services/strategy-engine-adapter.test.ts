import { StrategyEngineAdapter } from './strategy-engine-adapter';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';

function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createAdapter() {
  return new StrategyEngineAdapter({
    pg: { query: async () => ({ rows: [] }) },
    log: { info: () => undefined, warn: () => undefined }
  } as any) as any;
}

function signal(overrides: Record<string, any> = {}) {
  return {
    generated_at: 1_786_000_000,
    engine_version: 'signal-only-v2',
    execution_enabled: false,
    state: 'ARMED',
    signal_phase: 'ARMED',
    favoring: 'calls',
    strategy: 'MTF_TREND_BREAK',
    call_setup: {
      trigger: 550,
      invalidation: 548,
      targets: [552, 554],
      option: { local_symbol: 'SPY  260730C00551000', strike: 551, expiry: '20260730' }
    },
    put_setup: {},
    blockers: [],
    lifecycle: { entry_allowed: false, targets_hit: 0 },
    ...overrides
  };
}

async function runTests() {
  const adapter = createAdapter();
  assert(adapter.getMode() === 'primary', 'The replacement strategy must remain the active signal source');
  assert(adapter.autonomousEntryWindow(new Date('2026-08-03T18:59:00.000Z')).open, 'Regular-session autonomous entry should remain open before 15:00 ET');
  assert(adapter.autonomousEntryWindow(new Date('2026-08-03T19:00:00.000Z')).reason === 'AUTO_ENTRY_CUTOFF', 'Regular-session autonomous entry must stop at 15:00 ET');
  assert(adapter.autonomousEntryWindow(new Date('2026-11-27T16:59:00.000Z')).open, 'Early-close autonomous entry should remain open before 12:00 ET');
  assert(adapter.autonomousEntryWindow(new Date('2026-11-27T17:00:00.000Z')).reason === 'AUTO_ENTRY_CUTOFF', 'Early-close autonomous entry must stop at 12:00 ET');
  assert(adapter.isAutonomousLiveEntryConfigured({
    autonomous_live_entry_enabled: 'true',
    day_trading_enabled: 'true',
    execution_broker: 'wealthsimple_snaptrade',
    snaptrade_auto_trade: 'true',
    live_trading_acknowledged: 'true',
    snaptrade_trading_account_id: 'account-1',
    shadow_trading_enabled: 'false'
  }), 'Autonomous live entry should require every explicit live-routing gate');
  assert(!adapter.isAutonomousLiveEntryConfigured({
    autonomous_live_entry_enabled: 'true',
    day_trading_enabled: 'true',
    execution_broker: 'wealthsimple_snaptrade',
    snaptrade_auto_trade: 'true',
    live_trading_acknowledged: 'false',
    snaptrade_trading_account_id: 'account-1'
  }), 'Missing live acknowledgement must block autonomous entry');
  adapter.currentSignal = signal({ generated_at: Date.now() / 1000 + 60 });
  assert(adapter.getCurrentState().ageSeconds < 0, 'A future-dated strategy snapshot must remain visibly invalid instead of appearing fresh');
  adapter.currentSignal = null;
  const first = adapter.planFingerprint(signal());
  const quoteChurn = adapter.planFingerprint(signal({ spot: 550.1 }));
  assert(first === quoteChurn, 'Plan identity must ignore spot churn');

  const changedPlan = adapter.planFingerprint(signal({
    call_setup: {
      ...signal().call_setup,
      trigger: 551
    }
  }));
  assert(first !== changedPlan, 'A changed frozen trigger must create a new setup identity');

  adapter.updateSetupIdentity(signal());
  const setupId = adapter.currentSetupId;
  adapter.updateSetupIdentity(signal({ state: 'ACTIVE', lifecycle: { entry_allowed: true } }));
  assert(adapter.currentSetupId === setupId, 'ARMED to ACTIVE must preserve setup identity');
  const supersededSetupId = adapter.updateSetupIdentity(signal({
    call_setup: { ...signal().call_setup, trigger: 551 }
  }));
  assert(supersededSetupId === setupId, 'A changed frozen plan must identify the prior setup for retirement');

  const retryAdapter = createAdapter();
  const previousSignal = signal();
  const replacementSignal = signal({
    generated_at: 1_786_000_001,
    call_setup: { ...signal().call_setup, trigger: 551 }
  });
  retryAdapter.currentSignal = previousSignal;
  retryAdapter.currentPlanFingerprint = retryAdapter.planFingerprint(previousSignal);
  retryAdapter.currentSetupId = '44444444-4444-4444-8444-444444444444';
  retryAdapter.lastEventFingerprint = retryAdapter.eventFingerprint(previousSignal);
  retryAdapter.readJson = async (filePath: string) => filePath.endsWith('signal.json') ? replacementSignal : {};
  retryAdapter.retireSupersededSetup = async () => undefined;
  retryAdapter.broadcast = () => undefined;
  retryAdapter.persistPrimarySignal = async () => null;
  let persistenceAttempts = 0;
  retryAdapter.persistEvent = async () => {
    persistenceAttempts += 1;
    if (persistenceAttempts === 1) throw new Error('temporary database failure');
    return false;
  };
  await retryAdapter.poll().then(
    () => { throw new Error('The first persistence attempt should fail'); },
    () => undefined
  );
  assert(retryAdapter.currentSignal === previousSignal, 'A failed snapshot persistence must restore the previous in-memory signal');
  assert(retryAdapter.currentSetupId === '44444444-4444-4444-8444-444444444444', 'A failed setup replacement must restore the previous setup id');
  await retryAdapter.poll();
  assert(persistenceAttempts === 2, 'An unchanged snapshot must retry after a transient persistence failure');
  assert(retryAdapter.currentSignal === replacementSignal, 'A successful retry must publish the replacement snapshot');

  const eventOne = adapter.eventFingerprint(signal());
  const eventTwo = adapter.eventFingerprint(signal({ spot: 551, generated_at: 1_786_000_001 }));
  assert(eventOne === eventTwo, 'Lifecycle events must ignore quote and clock churn');

  assert(
    adapter.gexAgeSeconds(signal({ gex: { provider_age_seconds: 4 } })) === 4,
    'Execution freshness must prefer the provider-reported GEX age'
  );
  assert(
    adapter.gexAgeSeconds(signal({ zerogex_shadow: { provider_age_seconds: 6 } })) === 6,
    'Execution freshness must read the ZeroGEX provider age'
  );
  assert(
    adapter.gexAgeSeconds(signal({ gex: { provider_age_seconds: null } })) === null,
    'Missing GEX age must not be treated as a fresh zero-second snapshot'
  );
  assert(
    adapter.isTerminal(signal({ state: 'WAIT', signal_phase: 'INVALIDATED' })),
    'A terminal signal phase must close the setup even when the top-level state is WAIT'
  );
  const armedAlert = adapter.strategyAlert(signal());
  assert(armedAlert?.category === 'strategy-armed', 'ARMED lifecycle must produce one reliable setup alert');
  assert(armedAlert?.title.startsWith('WAIT'), 'ARMED notification must lead with the required trader action');
  assert(armedAlert?.message.includes('DO NOT ENTER YET'), 'ARMED notification must explicitly prohibit early entry');
  assert(armedAlert?.message.includes('5-minute, 15-minute, and 1-hour trends'), 'MTF notification must explain the setup in plain language');
  assert(!armedAlert?.message.includes('MTF_TREND_BREAK'), 'Notification must not expose an unexplained internal strategy code');

  const activeAlert = adapter.strategyAlert(signal({ state: 'ACTIVE', lifecycle: { entry_allowed: true } }));
  assert(activeAlert?.category === 'strategy-active', 'ACTIVE lifecycle must notify that manual order review is available');
  assert(activeAlert?.title.startsWith('REVIEW NOW'), 'ACTIVE notification must lead with the manual review action');
  assert(activeAlert?.message.includes('manual approval'), 'ACTIVE notification must preserve the manual execution gate');
  const targetAlert = adapter.strategyAlert(signal({ state: 'MANAGE', lifecycle: { targets_hit: 1 } }));
  assert(targetAlert?.eventKey === 'target:1', 'Each newly reached strategy target must have a stable Discord dedupe key');
  assert(targetAlert?.message.includes('DO NOT ADD A NEW POSITION'), 'Target notification must prohibit duplicate entry');

  const stopAlert = adapter.strategyAlert(signal({ state: 'FAILED', lifecycle: { close_reason: 'protected_invalidation' } }));
  assert(stopAlert?.category === 'strategy-stop', 'Invalidation must produce a critical stop notification');
  assert(stopAlert?.message.includes('verify its exit status immediately'), 'Stop notification must tell the trader to reconcile any broker position');

  const credentialDirectory = await mkdtemp(path.join(os.tmpdir(), 'zerogex-credential-'));
  try {
    adapter.dataDir = credentialDirectory;
    await adapter.publishZeroGexCredential('test-key');
    const credentialPath = path.join(credentialDirectory, 'zerogex.env');
    assert(
      await readFile(credentialPath, 'utf8') === 'ZEROGEX_API_KEY=test-key\n',
      'ZeroGEX credential must be published in the prefetch env-file format'
    );
    assert(
      ((await stat(credentialPath)).mode & 0o777) === 0o600,
      'ZeroGEX credential file must be readable only by its container user'
    );
  } finally {
    await rm(credentialDirectory, { recursive: true, force: true });
  }

  let activeRefreshes = 0;
  let maxActiveRefreshes = 0;
  let refreshCalls = 0;
  adapter.poll = async () => {
    refreshCalls += 1;
    activeRefreshes += 1;
    maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
    await new Promise(resolve => setTimeout(resolve, 5));
    activeRefreshes -= 1;
  };
  await Promise.all([adapter.requestRefresh(), adapter.requestRefresh()]);
  assert(refreshCalls === 2, 'A Redis event received during refresh must queue one follow-up file read');
  assert(maxActiveRefreshes === 1, 'Strategy snapshot refreshes must never overlap');

  const reviewAdapter = createAdapter();
  reviewAdapter.currentSetupId = '22222222-2222-4222-8222-222222222222';
  reviewAdapter.currentSignal = signal({
    generated_at: Date.now() / 1000,
    gex: { provider_age_seconds: 2 },
    call_setup: {
      ...signal().call_setup,
      option: { ...signal().call_setup.option, quote_age_seconds: 3 }
    }
  });
  reviewAdapter.fastify.pg.query = async () => ({
    rows: [{ strategy_setup_id: reviewAdapter.currentSetupId }]
  });
  const freshReview = await reviewAdapter.assertSignalReviewable(7);
  assert(freshReview.optionQuoteFresh, 'Fresh option quote must allow a current AI review');
  reviewAdapter.currentSignal.state = 'ACTIVE';
  reviewAdapter.currentSignal.lifecycle = { entry_allowed: true };
  reviewAdapter.currentSignal.gex.provider_age_seconds = 40.1;
  await reviewAdapter.assertSignalExecutable(7);
  reviewAdapter.currentSignal.gex.provider_age_seconds = 120.1;
  await reviewAdapter.assertSignalExecutable(7).then(
    () => { throw new Error('GEX older than the provider contract must block execution'); },
    (error: Error) => assert(error.message.includes('GEX'), 'Stale GEX must return the authoritative freshness error')
  );
  reviewAdapter.currentSignal.gex.provider_age_seconds = 2;
  reviewAdapter.currentSignal.call_setup.option.quote_age_seconds = null;
  const missingQuoteReview = await reviewAdapter.assertSignalReviewable(7);
  assert(!missingQuoteReview.optionQuoteFresh, 'Missing option quote must downgrade rather than suppress AI review');
  await reviewAdapter.assertSignalExecutable(7).then(
    () => { throw new Error('Missing option quote age must block execution'); },
    (error: Error) => assert(error.message.includes('quote'), 'Execution must report the stale or missing option quote')
  );

  const queries: Array<{ sql: string; values: any[] }> = [];
  const persistenceAdapter = new StrategyEngineAdapter({
    pg: {
      query: async (sql: string, values: any[] = []) => {
        queries.push({ sql, values });
        return { rows: [] };
      }
    },
    log: { info: () => undefined, warn: () => undefined }
  } as any) as any;
  persistenceAdapter.currentSetupId = '11111111-1111-4111-8111-111111111111';
  await persistenceAdapter.persistPrimarySignal(signal({
    state: 'ACTIVE',
    confidence_score: 92,
    lifecycle: { entry_allowed: true },
    paper_policy: { exit_after_target: 2 },
    call_setup: {
      ...signal().call_setup,
      option: {
        ...signal().call_setup.option,
        planned_contracts: 2,
        planned_limit_price: 1.25,
        planned_total_debit: 250
      }
    }
  }));
  const signalInsert = queries.find((query) => query.sql.includes('INSERT INTO signals'));
  const positionUpdate = queries.find((query) => query.sql.includes('UPDATE positions'));
  assert(
    signalInsert?.sql.includes('ON CONFLICT (strategy_setup_id) WHERE strategy_setup_id IS NOT NULL'),
    'Strategy upsert must match the partial unique setup-id index used by PostgreSQL'
  );
  assert(signalInsert?.values[5] === 554, 'Persisted strategy target must honor paper exit target 2');
  assert(signalInsert?.values[20] === 'BULLISH', 'Primary CALL signals must store a directional trade bias');
  assert(signalInsert?.values[21] === 'A+', 'A strong executable primary signal must store its scored A+ grade');
  const persistedOption = JSON.parse(signalInsert?.values[13]);
  assert(persistedOption.planned_contracts === 2, 'Persisted signal must retain planned contract quantity');
  assert(positionUpdate?.values[2] === 552, 'Open strategy positions must retain the first target as TP1');
  assert(positionUpdate?.values[3] === 554, 'Open strategy positions must retain the configured final target as TP2');
  queries.length = 0;
  await persistenceAdapter.persistPrimarySignal(signal({
    state: 'ACTIVE',
    confidence_score: 78,
    lifecycle: { entry_allowed: true }
  }));
  const qualifiedSignalInsert = queries.find((query) => query.sql.includes('INSERT INTO signals'));
  assert(qualifiedSignalInsert?.values[21] === 'A', 'A qualified continuation must persist as A instead of being promoted to A+');
  queries.length = 0;
  await persistenceAdapter.retireSupersededSetup('old-setup', signal());
  assert(queries.some((query) => query.sql.includes("lifecycle_status = 'SUPERSEDED'")), 'A replaced setup signal must become terminal');
  assert(queries.some((query) => query.sql.includes("strategy_exit_reason = 'SUPERSEDED'")), 'A linked open position must receive a superseded exit request');

  let autonomousCall: any = null;
  const autonomousUserId = 9191;
  const autonomousAdapter = new StrategyEngineAdapter({
    pg: {
      query: async (sql: string, values: any[] = []) => {
        if (sql.includes("key = 'autonomous_live_entry_enabled'")) return { rows: [{ user_id: autonomousUserId }] };
        if (sql.includes('SELECT DISTINCT ON')) return { rows: [] };
        if (sql.includes('SELECT key, value FROM settings')) {
          return { rows: [
            { key: 'autonomous_live_entry_enabled', value: 'true' },
            { key: 'day_trading_enabled', value: 'true' },
            { key: 'execution_broker', value: 'wealthsimple_snaptrade' },
            { key: 'snaptrade_auto_trade', value: 'true' },
            { key: 'live_trading_acknowledged', value: 'true' },
            { key: 'snaptrade_trading_account_id', value: 'account-1' },
            { key: 'shadow_trading_enabled', value: 'false' },
            { key: 'contracts_per_trade', value: '4' },
            { key: 'max_correlated_positions', value: '4' }
          ] };
        }
        if (sql.includes('SELECT strategy_setup_id')) {
          return { rows: [{ strategy_setup_id: autonomousAdapter.currentSetupId }] };
        }
        return { rows: [], values };
      }
    },
    scanner: {
      executeSignalForUser: async (userId: number, signalId: number, settings: any) => {
        autonomousCall = { userId, signalId, settings };
        return { success: true };
      }
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }
  } as any) as any;
  autonomousAdapter.currentSetupId = '33333333-3333-4333-8333-333333333333';
  autonomousAdapter.currentSignal = signal({
    generated_at: Date.now() / 1000,
    state: 'ACTIVE',
    lifecycle: { entry_allowed: true },
    gex: { provider_age_seconds: 2 },
    call_setup: {
      ...signal().call_setup,
      option: { ...signal().call_setup.option, quote_age_seconds: 2 }
    }
  });
  autonomousAdapter.autonomousEntryWindow = () => ({ open: true, reason: 'OPEN', cutoffMinutes: 900, closeMinutes: 960 });
  await autonomousAdapter.maybeExecuteAutonomousLiveEntries(autonomousAdapter.currentSignal, 88);
  assert(autonomousCall?.userId === autonomousUserId && autonomousCall?.signalId === 88, 'Eligible autonomous user must route the active strategy signal');
  assert(autonomousCall?.settings.contracts_per_trade === '1', 'Autonomous live entry must hard-cap the order at one contract');
  assert(autonomousCall?.settings.max_correlated_positions === '1', 'Autonomous live entry must hard-cap concurrent correlated exposure at one');

  queries.length = 0;
  await persistenceAdapter.persistPrimarySignal(signal({ state: 'WAIT', signal_phase: 'INVALIDATED' }));
  assert(
    queries.some((query) => query.sql.includes('strategy_exit_requested_at')),
    'Terminal strategy state must request an exit for linked open positions'
  );
  const terminalPositionUpdate = queries.find((query) => query.sql.includes('strategy_exit_requested_at'));
  assert(terminalPositionUpdate?.values[1] === 'INVALIDATED', 'Position exit reason must retain the terminal lifecycle state');
}

runTests()
  .then(() => console.log('All StrategyEngineAdapter tests passed!'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
