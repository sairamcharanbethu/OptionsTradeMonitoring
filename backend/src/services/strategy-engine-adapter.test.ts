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
  const persistedOption = JSON.parse(signalInsert?.values[13]);
  assert(persistedOption.planned_contracts === 2, 'Persisted signal must retain planned contract quantity');
  assert(positionUpdate?.values[2] === 554, 'Open strategy positions must follow the same target-2 lifecycle');

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
