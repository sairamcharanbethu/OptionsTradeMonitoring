import fs from 'fs';
import path from 'path';
import { KILL_RULES, WeeklyParityReportService, evaluateLane } from './weekly-parity-report-service';
import { SWING_EXPECTATIONS } from '../config/swing-expectations';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const trade = (pnl: number, exitReason = pnl > 0 ? 'SWING_TRAILING_STOP' : 'SWING_PREMIUM_STOP') => ({ pnl, exitReason });

async function testExpectationsParity() {
  const jsonPath = path.resolve(__dirname, '../../../shared/swing-expectations.json');
  assert(fs.existsSync(jsonPath), 'shared/swing-expectations.json exists');
  const shared = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  delete shared.$comment;
  const a = JSON.stringify(shared, Object.keys(shared).sort());
  const b = JSON.stringify(JSON.parse(JSON.stringify(SWING_EXPECTATIONS)), Object.keys(shared).sort());
  assert(a === b, `TS mirror drifted from shared/swing-expectations.json\n${a}\n${b}`);
}

async function testEvaluateLaneMilestonesAndRules() {
  const empty = evaluateLane([], 0);
  assert(empty.milestone === 'NOISE' && empty.breaches.length === 0 && empty.cumulative.winRate === null, 'No trades: noise, no breaches');

  // 30 trades, 10 small wins / 20 losses -> PF well below 0.9, stop-heavy.
  const losing = [...Array(10).fill(0).map(() => trade(40)), ...Array(20).fill(0).map(() => trade(-50))];
  const lose = evaluateLane(losing, 1);
  assert(lose.milestone === 'PRELIMINARY', '30 trades is preliminary');
  assert(lose.rolling30.profitFactor === 0.4 && lose.breaches.includes('PF_BELOW_FLOOR'), `Rolling PF 0.4 breaches the floor (${JSON.stringify(lose.rolling30)})`);
  assert(lose.breaches.includes('STOP_HEAVY'), '20/30 premium-stop exits is stop-heavy');
  assert(!lose.breaches.includes('NEGATIVE_EXPECTANCY'), 'Negative expectancy needs 50 trades');
  assert(lose.drawdown.fromPeak === 1000 && !lose.breaches.includes('DRAWDOWN_LIMIT'), `Exactly $1000 from the $400 peak does not exceed the limit (${JSON.stringify(lose.drawdown)})`);

  // Win rate far below the benchmark (26%): 2/30 -> z <= -2.
  const coldStreak = [...Array(2).fill(0).map(() => trade(100, 'SWING_TRAILING_STOP')), ...Array(28).fill(0).map(() => trade(-10, 'SWING_INVALIDATION'))];
  const cold = evaluateLane(coldStreak, 0);
  assert(cold.benchmark.winRateZ !== null && cold.benchmark.winRateZ <= KILL_RULES.winRateZFloor && cold.breaches.includes('WIN_RATE_BELOW_BENCHMARK'), `2/30 wins is a win-rate breach (z=${cold.benchmark.winRateZ})`);
  assert(!cold.breaches.includes('STOP_HEAVY'), 'Invalidation exits are not premium stops');

  // Drawdown: run up $800, then lose $1,100.
  const dd = evaluateLane([trade(400), trade(400), trade(-300), trade(-400), trade(-400)], 0);
  assert(dd.drawdown.peak === 800 && dd.drawdown.fromPeak === 1100 && dd.breaches.includes('DRAWDOWN_LIMIT'), `Drawdown from peak is measured on the equity path (${JSON.stringify(dd.drawdown)})`);

  // A healthy lane: 60 trades, 45% wins, 2:1 payoff.
  // Interleaved so the rolling-30 window is representative: 9 wins / 11 losses per block of 20.
  const healthy = Array(60).fill(0).map((_, i) => (i % 9 < 4 ? trade(100) : trade(-50, i % 2 ? 'SWING_PREMIUM_STOP' : 'SWING_INVALIDATION')));
  const good = evaluateLane(healthy, 0);
  assert(good.milestone === 'PRELIMINARY' && good.breaches.length === 0, `A profitable lane has no breaches (${good.breaches})`);
  assert(good.cumulative.profitFactor !== null && good.cumulative.profitFactor > 1.5 && (good.benchmark.winRateZ || 0) > 2, 'Healthy stats computed');
  const decision = evaluateLane([...healthy, ...healthy], 0);
  assert(decision.milestone === 'DECISION', '100+ trades reaches the decision milestone');

  // Negative expectancy needs 50 trades.
  const slowBleed = Array(50).fill(0).map((_, i) => trade(i % 2 ? 30 : -35, 'SWING_TRAILING_STOP'));
  const bleed = evaluateLane(slowBleed, 0);
  assert(bleed.breaches.includes('NEGATIVE_EXPECTANCY') && bleed.cumulative.expectancy !== null && bleed.cumulative.expectancy < 0, 'Negative expectancy over 50 trades is flagged');
}

async function testWeekEndingAndReportAssembly() {
  const queries: any[] = [];
  const alerts: any[] = [];
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params?: any[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM paper_strategy_controls')) return { rows: [{ strategy_name: 'SWING', automation_status: 'ACTIVE' }, { strategy_name: 'SWING_NOAI', automation_status: 'PAUSED' }] };
        if (sql.includes("status='CLOSED'") && sql.includes('paper_strategy AS lane')) {
          return { rows: [
            { lane: 'SWING', realized_pnl: 120, exit_reason: 'SWING_TRAILING_STOP', updated_at: '2026-10-06T15:00:00.000Z' },
            { lane: 'SWING', realized_pnl: -60, exit_reason: 'SWING_PREMIUM_STOP', updated_at: '2026-10-08T15:00:00.000Z' },
            { lane: 'SWING_NOAI', realized_pnl: -80, exit_reason: 'SWING_PREMIUM_STOP', updated_at: '2026-09-25T15:00:00.000Z' }
          ] };
        }
        if (sql.includes("status='OPEN'") && sql.includes('GROUP BY')) return { rows: [{ lane: 'SWING', n: 1 }] };
        if (sql.includes("execution_broker='wealthsimple_snaptrade'") && sql.includes("status='CLOSED'")) return { rows: [] };
        if (sql.includes("execution_broker='wealthsimple_snaptrade'") && sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
        if (sql.includes('INSERT INTO weekly_parity_reports')) return { rows: [{ id: 9, discord_sent_at: null }] };
        if (sql.includes("role='ADMIN'")) return { rows: [{ id: 1 }] };
        return { rows: [] };
      }
    }
  } as any;
  const service = new WeeklyParityReportService(fastify);
  service.now = () => new Date('2026-10-09T20:45:00.000Z'); // Fri 16:45 ET
  assert(service.weekEnding() === '2026-10-09', `Friday maps to itself (${service.weekEnding()})`);
  assert(service.weekEnding(new Date('2026-10-07T14:00:00.000Z')) === '2026-10-09', 'Wednesday maps to the coming Friday');
  assert(service.weekEnding(new Date('2026-10-10T14:00:00.000Z')) === '2026-10-16', 'Saturday maps to the next Friday');

  const DiscordAlertService = require('./discord-alert-service').DiscordAlertService;
  const originalSend = DiscordAlertService.prototype.send;
  DiscordAlertService.prototype.send = async function (input: any) { alerts.push(input); return true; };
  try {
    const report = await service.generate();
    assert(report.weekEnding === '2026-10-09' && report.lanes.length === 2, 'One entry per variant lane');
    const swing = report.lanes.find((l) => l.lane === 'SWING')!;
    assert(swing.week.closed === 2 && swing.week.realizedPnl === 60, `This week's two SWING closes net +$60 (${JSON.stringify(swing.week)})`);
    assert(swing.cumulative.closed === 2 && swing.cumulative.openTrades === 1 && swing.milestone === 'NOISE', 'Cumulative stats and open slot are carried');
    const noai = report.lanes.find((l) => l.lane === 'SWING_NOAI')!;
    assert(noai.week.closed === 0 && noai.cumulative.closed === 1 && noai.automationStatus === 'PAUSED', 'Older closes count cumulatively but not in the week');
    assert(report.liveLane === null, 'No live trades -> no live lane');
    assert(report.benchmark.trades === 78 && report.benchmark.profitFactor === 0.83, 'The benchmark rides along');
    assert(queries.some((q) => q.sql.includes('INSERT INTO weekly_parity_reports') && q.params?.[0] === '2026-10-09'), 'The report is persisted by week');
    assert(alerts.length === 1 && alerts[0].category === 'weekly-parity-report' && alerts[0].dedupeKey === 'weekly-parity:2026-10-09', 'One Discord post per week');
    assert(alerts[0].message.includes('Swing (live rules)') && alerts[0].message.includes('Benchmark'), 'The post lists lanes and the benchmark');
    assert(queries.some((q) => q.sql.includes('SET discord_sent_at')), 'Posting is recorded');
  } finally {
    DiscordAlertService.prototype.send = originalSend;
  }
}

async function runTests() {
  console.log('Running WeeklyParityReportService tests...');
  await testExpectationsParity();
  await testEvaluateLaneMilestonesAndRules();
  await testWeekEndingAndReportAssembly();
  console.log('All WeeklyParityReportService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
