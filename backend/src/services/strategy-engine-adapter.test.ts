import { StrategyEngineAdapter } from './strategy-engine-adapter';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createAdapter() {
  return new StrategyEngineAdapter({
    pg: { query: async () => ({ rows: [] }) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }
  } as any) as any;
}

function signal(overrides: Record<string, any> = {}) {
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = (type: string) => dateParts.find(item => item.type === type)?.value || '';
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
      plan_quality: { reward_risk: 2, meets_minimum: true },
      option: { local_symbol: 'SPY  260730C00551000', strike: 551, expiry: '20260730' }
    },
    put_setup: {},
    blockers: [],
    lifecycle: { entry_allowed: false, targets_hit: 0 },
    session_policy: {
      valid: true,
      market_date: `${part('year')}-${part('month')}-${part('day')}`,
      is_trading_day: true,
      open_minute_et: 0,
      entry_cutoff_minute_et: 24 * 60
    },
    ...overrides
  };
}

async function runTests() {
  const adapter = createAdapter();
  assert(adapter.getMode() === 'primary', 'The replacement strategy must remain the active signal source');

  // Ledger reconciliation confidence (safety-critical timing for the phantom-
  // managed-position fix): only declare a lane confidently position-less once a
  // fill can no longer be in flight.
  const NOW = 1_000_000;
  assert(StrategyEngineAdapter.laneReconciliation(true, NOW - 100, NOW, 30).confident === true,
    'An open position is always confident');
  const missed = StrategyEngineAdapter.laneReconciliation(false, NOW - 31, NOW, 30);
  assert(missed.open === false && missed.confident === true,
    'A no-fill entry past its window+grace must be confidently missed');
  assert(StrategyEngineAdapter.laneReconciliation(false, NOW - 10, NOW, 30).confident === false,
    'An in-flight entry (within window+grace) must not be declared missed');
  assert(StrategyEngineAdapter.laneReconciliation(false, 0, NOW, 30).confident === false,
    'Without an entry window, timing alone must not force a demotion');
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
  adapter.currentSignal = signal({
    market_data_readiness: {
      status: 'BLOCKED',
      codes: ['SPY_QUOTE_STALE'],
      summary: 'IBKR SPY quote is stale'
    }
  });
  assert(
    adapter.getCurrentState().marketDataReadiness?.codes?.[0] === 'SPY_QUOTE_STALE',
    'The strategy-state API must expose the exact market-data readiness cause'
  );
  adapter.currentSignal = null;
  const first = adapter.planFingerprint(signal());
  const quoteChurn = adapter.planFingerprint(signal({ spot: 550.1 }));
  assert(first === quoteChurn, 'Plan identity must ignore spot churn');

  // Observed 2026-08-24: strike re-centering flip-flopped 763P/764P on an
  // unchanged plan, superseding the setup every few minutes. Contract
  // selection must not mint a new identity.
  const strikeRecenter = adapter.planFingerprint(signal({
    call_setup: {
      ...signal().call_setup,
      option: { ...signal().call_setup.option, local_symbol: 'SPY260827C00764000', strike: 764 }
    }
  }));
  assert(first === strikeRecenter, 'Plan identity must survive option strike re-centering');

  const changedPlan = adapter.planFingerprint(signal({
    call_setup: {
      ...signal().call_setup,
      trigger: 551
    }
  }));
  assert(first !== changedPlan, 'A changed frozen trigger must create a new setup identity');
  const firstFamilyEvent = adapter.planFingerprint(signal({
    strategy: 'VWAP_TREND',
    call_setup: { ...signal().call_setup, source_event_id: 'vwap:event:1' }
  }));
  const secondFamilyEvent = adapter.planFingerprint(signal({
    strategy: 'VWAP_TREND',
    call_setup: { ...signal().call_setup, source_event_id: 'vwap:event:2' }
  }));
  assert(firstFamilyEvent !== secondFamilyEvent, 'Distinct VWAP reclaim events must create distinct setup identities even when their rounded levels match');

  adapter.updateSetupIdentity(signal());
  const setupId = adapter.currentSetupId;
  adapter.updateSetupIdentity(signal({ state: 'ACTIVE', lifecycle: { entry_allowed: true } }));
  assert(adapter.currentSetupId === setupId, 'ARMED to ACTIVE must preserve setup identity');
  const supersededSetupId = adapter.updateSetupIdentity(signal({
    call_setup: { ...signal().call_setup, trigger: 551 }
  }));
  assert(supersededSetupId === setupId, 'A changed frozen plan must identify the prior setup for retirement');

  const concurrentAdapter = createAdapter();
  concurrentAdapter.persistEvent = async () => false;
  concurrentAdapter.persistPrimarySignal = async (_snapshot: any, laneSetupId: string) => laneSetupId ? 1 : null;
  concurrentAdapter.retireSupersededSetup = async () => undefined;
  const concurrentExecutions: string[] = [];
  concurrentAdapter.maybeExecuteAutonomousLiveEntries = async (snapshot: any) => {
    concurrentExecutions.push(snapshot.strategy_lane);
  };
  const activeOrb = signal({
    strategy_lane: 'orb_index',
    strategy: 'ORB_INDEX',
    state: 'ACTIVE',
    lifecycle: { entry_allowed: true, paper_position_open: true },
    call_setup: { ...signal().call_setup, source_event_id: 'orb:event:1' }
  });
  const activeVwap = signal({
    strategy_lane: 'vwap_trend',
    strategy: 'VWAP_TREND',
    state: 'ACTIVE',
    lifecycle: { entry_allowed: true, paper_position_open: true },
    call_setup: { ...signal().call_setup, source_event_id: 'vwap:event:1' }
  });
  await concurrentAdapter.processLaneSnapshot('orb_index', activeOrb);
  await concurrentAdapter.processLaneSnapshot('vwap_trend', activeVwap);
  assert(
    concurrentAdapter.laneSetupIds.orb_index
      && concurrentAdapter.laneSetupIds.vwap_trend
      && concurrentAdapter.laneSetupIds.orb_index !== concurrentAdapter.laneSetupIds.vwap_trend,
    'Simultaneous ORB and VWAP activations must retain independent setup identities'
  );
  assert(
    concurrentExecutions.includes('orb_index') && concurrentExecutions.includes('vwap_trend'),
    'Each active strategy lane must independently reach guarded execution'
  );
  assert(
    concurrentAdapter.getCurrentState().strategySignals.length === 2,
    'The strategy-state API must expose simultaneous lane snapshots to the UI'
  );

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
  const retrySetupId = retryAdapter.laneSetupIds.mtf;
  assert(
    retrySetupId && retrySetupId !== '44444444-4444-4444-8444-444444444444',
    'A failed setup replacement must retain its new id for an idempotent retry'
  );
  await retryAdapter.poll();
  assert(persistenceAttempts === 2, 'An unchanged snapshot must retry after a transient persistence failure');
  assert(retryAdapter.currentSignal === replacementSignal, 'A successful retry must publish the replacement snapshot');
  assert(retryAdapter.currentSetupId === retrySetupId, 'A persistence retry must not generate a second setup id');

  const lifecycleIsolationAdapter = createAdapter();
  const lifecycleErrors: string[] = [];
  lifecycleIsolationAdapter.fastify.log.error = (message: string) => lifecycleErrors.push(message);
  lifecycleIsolationAdapter.persistEvent = async () => true;
  lifecycleIsolationAdapter.persistPrimarySignal = async () => 77;
  lifecycleIsolationAdapter.notifyStrategyLifecycle = async () => undefined;
  lifecycleIsolationAdapter.retireSupersededSetup = () => new Promise<void>(() => undefined);
  lifecycleIsolationAdapter.maybeExecuteAutonomousLiveEntries = async () => {
    throw new Error('simulated autonomous manager failure');
  };
  lifecycleIsolationAdapter.laneSetupIds.mtf_trend_break = 'old-setup';
  lifecycleIsolationAdapter.lanePlanFingerprints.mtf_trend_break = 'old-plan';
  const isolatedSignal = signal({
    strategy_lane: 'mtf_trend_break',
    state: 'ACTIVE',
    lifecycle: { entry_allowed: true },
    call_setup: { ...signal().call_setup, trigger: 551 }
  });
  await lifecycleIsolationAdapter.processLaneSnapshot('mtf_trend_break', isolatedSignal);
  assert(lifecycleIsolationAdapter.currentSignals.mtf_trend_break === isolatedSignal, 'Lifecycle-manager failures must not roll back a newly generated strategy signal');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(lifecycleErrors.length === 1, 'Lifecycle-manager failures must be recorded separately from the signal stream');

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
  reviewAdapter.currentSignal.call_setup.plan_quality = { reward_risk: 1.2, meets_minimum: false };
  await reviewAdapter.assertSignalExecutable(7).then(
    () => { throw new Error('A subminimum frozen plan must block execution'); },
    (error: Error) => assert(error.message.includes('reward/risk'), 'Plan-quality rejection must name reward/risk')
  );
  reviewAdapter.currentSignal.call_setup.plan_quality = { reward_risk: 2, meets_minimum: true };
  reviewAdapter.currentSignal.session_policy.valid = false;
  await reviewAdapter.assertSignalExecutable(7).then(
    () => { throw new Error('An invalid session policy must block execution'); },
    (error: Error) => assert(error.message.includes('session'), 'Session rejection must name the stale or closed policy')
  );
  reviewAdapter.currentSignal.session_policy.valid = true;
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
  const savedReviewQuery = reviewAdapter.fastify.pg.query;
  reviewAdapter.fastify.pg.query = async () => ({ rows: [{ strategy_setup_id: null }] });
  await reviewAdapter.assertSignalExecutable(7).then(
    () => { throw new Error('A signal without a strategy setup id must fail closed, not bypass the gates'); },
    (error: Error) => assert(error.message.includes('setup'), 'Missing setup identity must name the setup in its rejection')
  );
  reviewAdapter.fastify.pg.query = async () => ({ rows: [] });
  await reviewAdapter.assertSignalExecutable(7).then(
    () => { throw new Error('A missing signal row must fail closed'); },
    (error: Error) => assert(error.message.includes('exists'), 'A missing signal row must be rejected explicitly')
  );
  reviewAdapter.fastify.pg.query = savedReviewQuery;

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
        planned_total_debit: 250,
        estimated_stop_risk: { per_contract_dollars: 55, total_dollars: 110 }
      }
    },
    decision_telemetry: {
      version: 'strategy-decision-v1',
      entry_structure_context: {
        mode: 'shadow',
        confluence: { grade: 'TRIPLE_CONFLUENCE', entry_authority: false }
      },
      strategy_family_context: {
        mode: 'primary',
        entry_authority: true,
        orb_index: { status: 'FRESH_BREAK', candidate: { event_id: 'orb-index:test' } },
        shared_risk: { trim_ladder_pct: [25, 45, 75] }
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
  assert(persistedOption.plan_quality.reward_risk === 2, 'Persisted signal must retain authoritative plan quality');
  assert(persistedOption.estimated_stop_risk.per_contract_dollars === 55, 'Persisted signal must retain modeled stop risk');
  assert(persistedOption.decision_telemetry.version === 'strategy-decision-v1', 'Persisted signal must retain replay telemetry');
  assert(persistedOption.decision_telemetry.entry_structure_context.mode === 'shadow', 'Persisted signal must retain compact shadow entry evidence');
  assert(persistedOption.decision_telemetry.entry_structure_context.confluence.entry_authority === false, 'Persisted shadow evidence must remain non-authoritative');
  assert(persistedOption.decision_telemetry.strategy_family_context.entry_authority === true, 'Persisted primary strategy family evidence must retain entry authority');
  assert(persistedOption.decision_telemetry.strategy_family_context.shared_risk.trim_ladder_pct[2] === 75, 'Persisted strategy family evidence must retain the trim ladder');
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
  const supersededPositionUpdate = queries.find((query) => query.sql.includes('strategy_exit_reason = $2'));
  assert(supersededPositionUpdate?.values[1] === 'SUPERSEDED', 'A linked open position must receive a superseded exit request');

  const autonomousCalls: any[] = [];
  const autonomousUserIds = [9191, 9192];
  let activeAutonomousCalls = 0;
  let maxActiveAutonomousCalls = 0;
  const autonomousAdapter = new StrategyEngineAdapter({
    pg: {
      query: async (sql: string, values: any[] = []) => {
        if (sql.includes("key = 'autonomous_live_entry_enabled'")) return { rows: autonomousUserIds.map(user_id => ({ user_id })) };
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
            { key: 'max_trades_per_day', value: '2' },
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
        autonomousCalls.push({ userId, signalId, settings });
        activeAutonomousCalls += 1;
        maxActiveAutonomousCalls = Math.max(maxActiveAutonomousCalls, activeAutonomousCalls);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeAutonomousCalls -= 1;
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
  const callsBeforeReady = autonomousCalls.length;
  assert(callsBeforeReady === 0, 'Autonomous entries must stay blocked until exit-monitoring services are running');
  autonomousAdapter.markLiveEntriesReady();
  await autonomousAdapter.maybeExecuteAutonomousLiveEntries(autonomousAdapter.currentSignal, 88);
  assert(autonomousCalls.length === 2 && autonomousCalls.every(call => call.signalId === 88), 'Every eligible autonomous user must route the active strategy signal');
  assert(maxActiveAutonomousCalls === 2, 'Independent autonomous users must execute concurrently');
  assert(autonomousCalls.every(call => call.settings.contracts_per_trade === '1'), 'Autonomous live entries must hard-cap each order at one contract');
  assert(autonomousCalls.every(call => call.settings.max_trades_per_day === '2'), 'Autonomous live entries must preserve each user daily trade limit');
  assert(autonomousCalls.every(call => call.settings.max_correlated_positions === '4'), 'Autonomous live entries must preserve each configured concurrent exposure limit');

  queries.length = 0;
  await persistenceAdapter.persistPrimarySignal(signal({ state: 'WAIT', signal_phase: 'INVALIDATED' }));
  assert(
    queries.some((query) => query.sql.includes('strategy_exit_requested_at')),
    'Terminal strategy state must request an exit for linked open positions'
  );
  const terminalPositionUpdate = queries.find((query) => query.sql.includes('strategy_exit_requested_at'));
  assert(terminalPositionUpdate?.values[1] === 'INVALIDATED', 'Position exit reason must retain the terminal lifecycle state');

  const familyHistoryDir = await mkdtemp(path.join(os.tmpdir(), 'strategy-family-history-'));
  try {
    await mkdir(path.join(familyHistoryDir, 'history'));
    const orbRecord = {
      journaled_at: 1_786_000_100,
      generated_at: 1_786_000_099,
      spot: 550.25,
      strategy_family_context: {
        mode: 'shadow',
        entry_authority: false,
        orb_index: {
          strategy: 'ORB_INDEX',
          status: 'FRESH_BREAK',
          observation: 'SHADOW: calls ORB close confirmed',
          opening_range: { high: 550, low: 548 },
          candidate: {
            side: 'calls',
            event_id: 'orb-index:2026-08-10:calls:1786000099',
            confirmed_at: 1_786_000_099,
            fresh: true
          }
        },
        shared_risk: { trim_ladder_pct: [25, 45, 75] }
      },
      raw_bar_history: [{ close: 550.25 }]
    };
    const vwapRecord = {
      journaled_at: 1_786_000_200,
      generated_at: 1_786_000_199,
      spot: 551,
      strategy_family_context: {
        mode: 'primary',
        entry_authority: true,
        vwap_trend: {
          strategy: 'VWAP_TREND',
          status: 'REENTRY_COOLDOWN',
          observation: 'PRIMARY: reclaim inside cooldown',
          trend: { side: 'calls', vwap: 550.5, slope_bps: 3.2 },
          suppressed_candidate: {
            side: 'calls',
            event_id: 'vwap-trend:2026-08-10:calls:1786000199',
            confirmed_at: 1_786_000_199,
            fresh: true
          }
        }
      }
    };
    await writeFile(
      path.join(familyHistoryDir, 'history', 'signals-2026-08-10.jsonl'),
      [JSON.stringify(orbRecord), JSON.stringify(orbRecord), '{bad json', JSON.stringify(vwapRecord)].join('\n')
    );
    const familyAdapter = createAdapter();
    familyAdapter.dataDir = familyHistoryDir;

    const familyEvents = await familyAdapter.getStrategyFamilyHistory(10);

    assert(familyEvents.length === 2, 'Family history must deduplicate stable event IDs and ignore malformed rows');
    assert(familyEvents[0].event_id.startsWith('vwap-trend:'), 'Family history must return newest candidates first');
    assert(familyEvents[0].suppressed === true, 'Family history must retain suppressed VWAP observations');
    assert(familyEvents[0].entry_authority === true, 'Family history must retain primary authority for promoted strategy candidates');
    assert(familyEvents[1].family === 'ORB_INDEX', 'Family history must retain standalone ORB observations');
    assert(familyEvents[1].entry_authority === false, 'Family history must remain explicitly non-authoritative');
    assert(!('raw_bar_history' in familyEvents[1]), 'Family history must never expose raw bar history');
  } finally {
    await rm(familyHistoryDir, { recursive: true, force: true });
  }
}

runTests()
  .then(() => console.log('All StrategyEngineAdapter tests passed!'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
