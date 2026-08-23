/**
 * Standalone runner for the SignalReplayBacktester.
 *
 * Replays stored `signals` against captured `option_market_history` and prints
 * expectancy metrics per scenario — win rate, profit factor, PnL, max drawdown.
 * Needs only a database connection (no running backend, no auth).
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     npx ts-node src/scripts/run-signal-replay.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD] \
 *       [--max 1000] [--tp 12] [--sl 20] [--contracts 5]
 *
 * Notes:
 *  - Replays whatever is in the `signals` table for the window. Signals stored
 *    before the wall-reaction merge reflect the legacy engine; narrow --start to
 *    the wall deploy date to isolate the new setups.
 *  - The blocked-signal AI replay is neutralized here (no network / API key).
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { SignalReplayBacktester } from '../services/signal-replay-backtester';

dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: set DATABASE_URL (the Aiven/Postgres connection string).');
    process.exit(1);
  }
  const needsSsl = /aivencloud|sslmode=require|supabase/.test(dbUrl) || process.env.PGSSLMODE === 'require';
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });

  const fastify: any = {
    pg: pool,
    log: {
      info: () => {},
      warn: () => {},
      error: (m: any) => console.error('[backtester]', m),
      debug: () => {},
    },
  };

  const bt = new SignalReplayBacktester(fastify);
  // Neutralize the blocked-signal AI replay so the run needs no network/API key.
  (bt as any).aiService = { askTradingJSON: async () => ({ decision: 'SKIP', verdict: 'SKIP' }) };

  const input: any = { maxSignals: Number(arg('max') ?? 1000) };
  if (arg('start')) input.startDate = arg('start');
  if (arg('end')) input.endDate = arg('end');
  if (arg('tp')) input.takeProfitPct = Number(arg('tp'));
  if (arg('sl')) input.stopLossPct = Number(arg('sl'));
  if (arg('contracts')) input.contractsPerTrade = Number(arg('contracts'));

  console.log('Running signal-replay backtest...');
  const res = await bt.run(1, input);

  const c = res.config;
  console.log('\n============================================================');
  console.log(`SIGNAL REPLAY  ${c.startDate} → ${c.endDate}`);
  console.log(`TP ${c.takeProfitPct}%  SL ${c.stopLossPct}%  contracts ${c.contractsPerTrade}  maxSignals ${c.maxSignals}`);
  console.log('============================================================');
  console.log(`signals loaded:     ${res.signalsLoaded}  (generated ${res.generatedSignalsLoaded}, blocked ${res.blockedSignalsLoaded})`);
  console.log(`usable (had option data): ${res.signalsUsable}    missing option data: ${res.missingOptionData}`);
  if (res.engineGate.available) {
    console.log(`engine gate (python signal_engine): evaluated ${res.engineGate.evaluated}/${res.engineGate.total} signals`);
  } else {
    console.log(`engine gate UNAVAILABLE (${res.engineGate.error}) — structure_gated skipped every signal; nothing was approximated in TS`);
  }

  const pct = (n: number) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
  const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');
  const pf = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—');

  for (const s of res.scenarios) {
    const m = s.summary;
    console.log(`\n── ${s.name} ──  ${s.description}`);
    console.log(`   trades ${m.trades}  (W ${m.wins} / L ${m.losses})   win rate ${pct(m.winRate)}`);
    console.log(`   profit factor ${pf(m.profitFactor)}   total PnL ${money(m.totalPnl)}   max DD ${money(m.maxDrawdown)}`);
    console.log(`   avg win ${money(m.averageWin)}   avg loss ${money(m.averageLoss)}   days ${m.daysTested} (green ${m.greenDays}/red ${m.redDays})`);
    if (m.trades > 0) {
      const expectancy = m.totalPnl / m.trades;
      console.log(`   >>> expectancy/trade ${money(expectancy)}   ${expectancy > 0 ? 'POSITIVE' : 'NEGATIVE'} (gross of commission)`);
    }
  }

  console.log('\nParity:', JSON.stringify(res.parity));
  console.log('\nNOTE: PnL is GROSS — the replay does not subtract commissions. On 1–5');
  console.log('contract 0DTE, commissions are a meaningful haircut; judge edge accordingly.');

  await pool.end();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
