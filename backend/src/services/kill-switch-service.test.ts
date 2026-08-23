import { KillSwitchService } from './kill-switch-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

type PgScript = {
  limit?: string;          // daily_loss_limit_dollars global setting
  disarmed?: string;       // live_trading_disarmed setting row
  realizedPnl?: number;    // sum for CLOSED positions today
  openPnl?: number;        // sum for open-exposure positions
};

function createPg(script: PgScript) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string, _values: any[] = []) => {
      calls.push(sql);
      if (sql.includes('DISTINCT ON (s.key)')) {
        return {
          rows: script.limit !== undefined
            ? [{ key: KillSwitchService.SETTING_KEY, value: script.limit }]
            : []
        };
      }
      if (sql.includes('SELECT value FROM settings')) {
        return { rows: script.disarmed !== undefined ? [{ value: script.disarmed }] : [] };
      }
      if (sql.includes("status = 'CLOSED'")) {
        return { rows: [{ pnl: script.realizedPnl ?? 0 }] };
      }
      if (sql.includes('status = ANY')) {
        return { rows: [{ pnl: script.openPnl ?? 0 }] };
      }
      return { rows: [] };
    }
  };
}

async function testDisabledLimitSkipsPnlQueries() {
  const pg = createPg({});
  const status = await KillSwitchService.evaluate(pg, 'live', 7);
  assert(status.enabled === false, 'No configured limit must disable the loss halt');
  assert(status.halted === false, 'Disabled + not disarmed must not halt');
  assert(!pg.calls.some((sql) => sql.includes("status = 'CLOSED'")), 'Disabled switch must skip the realized P&L query');
  assert(!pg.calls.some((sql) => sql.includes('status = ANY')), 'Disabled switch must skip the open P&L query');
}

async function testOpenLossCountsTowardTheHalt() {
  // Realized alone is inside the limit; realized + open premium is not.
  // On 0DTE the open drawdown IS the risk.
  const pg = createPg({ limit: '200', realizedPnl: -120, openPnl: -110 });
  const status = await KillSwitchService.evaluate(pg, 'live', 7);
  assert(status.dayRealizedPnl === -120, 'Realized P&L must be reported');
  assert(status.dayOpenPnl === -110, 'Open P&L must be reported');
  assert(status.dayTotalPnl === -230, 'Total must be realized + open');
  assert(status.halted === true, 'Realized + open beyond the limit must halt');
  assert(Boolean(status.reason && status.reason.includes('open')), 'The halt reason must show the open-loss component');
}

async function testRealizedOnlyMathNoLongerMasksOpenDrawdown() {
  const pg = createPg({ limit: '200', realizedPnl: -50, openPnl: 30 });
  const status = await KillSwitchService.evaluate(pg, 'live', 7);
  assert(status.halted === false, 'A total inside the limit must not halt');
}

async function testManualDisarmHaltsEvenWithLimitDisabled() {
  const pg = createPg({ disarmed: 'true' });
  const status = await KillSwitchService.evaluate(pg, 'live', 7);
  assert(status.disarmed === true, 'Disarm flag must be reported');
  assert(status.halted === true, 'A manual disarm must halt live entries even with no loss limit configured');
  assert(Boolean(status.reason && status.reason.toLowerCase().includes('disarmed')), 'The reason must name the manual disarm');
}

async function testPaperScopeIgnoresLiveDisarm() {
  const pg = createPg({ disarmed: 'true', limit: '200', realizedPnl: 0, openPnl: 0 });
  const status = await KillSwitchService.evaluate(pg, 'paper');
  assert(status.disarmed === false, 'The live disarm must not apply to the paper scope');
  assert(status.halted === false, 'Paper must not halt on the live disarm flag');
}

async function testLiveScopeRequiresUserId() {
  const pg = createPg({ limit: '200' });
  let threw = false;
  try {
    await KillSwitchService.evaluate(pg, 'live');
  } catch {
    threw = true;
  }
  assert(threw, 'Live scope without a userId must fail loud, not silently match no rows');
}

async function main() {
  console.log('Running KillSwitchService tests...');
  await testDisabledLimitSkipsPnlQueries();
  await testOpenLossCountsTowardTheHalt();
  await testRealizedOnlyMathNoLongerMasksOpenDrawdown();
  await testManualDisarmHaltsEvenWithLimitDisabled();
  await testPaperScopeIgnoresLiveDisarm();
  await testLiveScopeRequiresUserId();
  console.log('All KillSwitchService tests passed!');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
