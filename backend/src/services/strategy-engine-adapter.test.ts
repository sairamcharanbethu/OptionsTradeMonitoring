import { StrategyEngineAdapter } from './strategy-engine-adapter';

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
    adapter.isTerminal(signal({ state: 'WAIT', signal_phase: 'INVALIDATED' })),
    'A terminal signal phase must close the setup even when the top-level state is WAIT'
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
