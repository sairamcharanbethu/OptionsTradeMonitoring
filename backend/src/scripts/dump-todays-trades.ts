/**
 * Dump today's trades (rows in the `positions` table) from the configured database.
 *
 * Connects via DATABASE_URL — inside the deployed backend container it therefore
 * targets the exact same database the app uses.
 *
 * Usage (inside the backend container on the instance):
 *   node dist/scripts/dump-todays-trades.js
 *   node dist/scripts/dump-todays-trades.js --date 2026-08-19
 *   node dist/scripts/dump-todays-trades.js --field updated_at   # everything touched today
 *   node dist/scripts/dump-todays-trades.js --tz UTC
 *   node dist/scripts/dump-todays-trades.js --csv > today.csv
 *   node dist/scripts/dump-todays-trades.js --json > today.json
 *
 * Local dev: `ts-node src/scripts/dump-todays-trades.ts` (uses the localhost fallback).
 */
import pg from 'pg';
const { Pool } = pg;

type Args = {
  date?: string;
  field: 'created_at' | 'updated_at';
  tz: string;
  format: 'table' | 'csv' | 'json';
};

function parseArgs(argv: string[]): Args {
  const args: Args = { field: 'created_at', tz: 'America/New_York', format: 'table' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--field') {
      const v = argv[++i];
      if (v !== 'created_at' && v !== 'updated_at') {
        throw new Error(`--field must be created_at or updated_at (got "${v}")`);
      }
      args.field = v;
    } else if (a === '--tz') args.tz = argv[++i];
    else if (a === '--csv') args.format = 'csv';
    else if (a === '--json') args.format = 'json';
    else if (a === '-h' || a === '--help') {
      console.log('Usage: dump-todays-trades [--date YYYY-MM-DD] [--field created_at|updated_at] [--tz Area/City] [--csv|--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

const COLUMNS = [
  'id', 'symbol', 'option_type', 'strike_price', 'expiration_date',
  'quantity', 'entry_price', 'exit_price', 'current_price',
  'status', 'execution_status', 'realized_pnl',
  'execution_broker', 'account_id', 'broker_order_id',
  'is_simulated', 'paper_account_id',
  'created_at', 'updated_at'
];

function toCsv(rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = COLUMNS.join(',');
  const body = rows.map((r) => COLUMNS.map((c) => esc(r[c])).join(',')).join('\n');
  return rows.length ? `${header}\n${body}` : header;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring',
  });

  // Resolve the target day: explicit --date, else "today" in the requested timezone.
  const dateExpr = args.date ? '$1::date' : `(now() AT TIME ZONE $1)::date`;
  const params = args.date ? [args.date, args.tz] : [args.tz];
  // When --date is given, $1 is the date and $2 is the tz; otherwise $1 is the tz.
  const tzParamIndex = args.date ? 2 : 1;

  const sql = `
    SELECT ${COLUMNS.join(', ')}
    FROM positions
    WHERE (${args.field} AT TIME ZONE $${tzParamIndex})::date = ${dateExpr}
    ORDER BY ${args.field} DESC
  `;

  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);

    if (args.format === 'json') {
      console.log(JSON.stringify(rows, null, 2));
    } else if (args.format === 'csv') {
      console.log(toCsv(rows));
    } else {
      const day = args.date || 'today';
      console.error(`\nTrades where ${args.field} = ${day} (${args.tz}) — ${rows.length} row(s)\n`);
      console.table(
        rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          type: r.option_type,
          strike: r.strike_price,
          exp: r.expiration_date,
          qty: r.quantity,
          entry: r.entry_price,
          exit: r.exit_price,
          status: r.status,
          exec: r.execution_status,
          pnl: r.realized_pnl,
          broker: r.execution_broker,
          sim: r.is_simulated,
          created_at: r.created_at,
        }))
      );

      const realized = rows.reduce((sum: number, r: any) => sum + (Number(r.realized_pnl) || 0), 0);
      const closed = rows.filter((r: any) => r.status === 'CLOSED').length;
      const open = rows.filter((r: any) => r.status === 'OPEN').length;
      console.error(`\nSummary: ${rows.length} total · ${open} open · ${closed} closed · realized PnL ${realized.toFixed(2)}\n`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
