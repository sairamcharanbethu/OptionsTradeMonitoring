import dotenv from 'dotenv';
import path from 'path';
import pg from 'pg';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const { Pool } = pg;
const SHARED_ACCOUNT_ID = 'shared-paper';
const LEGACY_ACCOUNT_IDS = ['strategy-system', 'wall-reaction-system', 'shared-paper'];
const APPLY = process.argv.includes('--apply');

type Row = Record<string, any>;

function poolFor(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    ssl: connectionString.includes('aivencloud') || connectionString.includes('render')
      ? { rejectUnauthorized: false }
      : undefined
  });
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function strategyFor(row: Row, fallback?: string): 'DAY_TRADING' | 'WALL_REACTION' {
  const explicit = String(row.paper_strategy || row.strategy_name || '').toUpperCase();
  if (explicit === 'WALL_REACTION') return 'WALL_REACTION';
  if (explicit === 'DAY_TRADING') return 'DAY_TRADING';
  if (row.paper_account_id === 'wall-reaction-system' || row.account_id === 'wall-reaction-system'
    || row.execution_broker === 'wall_reaction_paper' || fallback === 'WALL_REACTION') return 'WALL_REACTION';
  return 'DAY_TRADING';
}

async function columnsFor(client: pg.PoolClient, table: string): Promise<Set<string>> {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  if (!rows.length) throw new Error(`Target table ${table} does not exist. Deploy the shared-paper-account release first.`);
  return new Set(rows.map((row) => String(row.column_name)));
}

async function insertRow(
  client: pg.PoolClient,
  table: string,
  allowedColumns: Set<string>,
  source: Row,
  overrides: Row,
  options: { returningId?: boolean; onConflict?: string } = {}
): Promise<number | null> {
  const record = { ...source, ...overrides };
  delete record.id;
  const fields = Object.keys(record).filter((field) => allowedColumns.has(field) && record[field] !== undefined);
  const values = fields.map((field) => record[field]);
  const placeholders = fields.map((_, index) => `$${index + 1}`);
  const result = await client.query(
    `INSERT INTO ${quoteIdentifier(table)} (${fields.map(quoteIdentifier).join(', ')})
     VALUES (${placeholders.join(', ')})${options.onConflict || ''}${options.returningId === false ? '' : ' RETURNING id'}`,
    values
  );
  return options.returningId === false ? null : Number(result.rows[0]?.id || 0) || null;
}

async function countTargetPaperRows(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM positions WHERE paper_account_id=$1) +
      (SELECT COUNT(*)::int FROM paper_trade_decisions WHERE account_id=$1) +
      (SELECT COUNT(*)::int FROM paper_orders WHERE account_id=$1) +
      (SELECT COUNT(*)::int FROM paper_trade_journal WHERE account_id=$1) AS total
  `, [SHARED_ACCOUNT_ID]);
  return Number(rows[0]?.total || 0);
}

async function prepareTargetSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS paper_ledger_migrations (
      migration_key VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS paper_strategy_controls (
      strategy_name VARCHAR(50) PRIMARY KEY,
      automation_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING'`);
  await client.query(`ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING'`);
  await client.query(`ALTER TABLE paper_trade_journal ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING'`);
  await client.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS paper_strategy VARCHAR(50)`);
}

async function run(): Promise<void> {
  const targetUrl = process.env.DATABASE_URL;
  const sourceUrl = process.env.PAPER_LEGACY_DATABASE_URL;
  if (!targetUrl) throw new Error('DATABASE_URL is required for the destination database.');
  if (!sourceUrl) throw new Error('PAPER_LEGACY_DATABASE_URL is required and must point to the database or backup containing the old paper ledger.');
  if (targetUrl === sourceUrl) throw new Error('Source and destination must be different databases.');

  const sourcePool = poolFor(sourceUrl);
  const targetPool = poolFor(targetUrl);
  const source = await sourcePool.connect();
  const target = await targetPool.connect();
  try {
    const sourceAccounts = await source.query(
      `SELECT id FROM paper_accounts WHERE id = ANY($1::varchar[]) ORDER BY id`, [LEGACY_ACCOUNT_IDS]
    );
    const availableAccountIds = sourceAccounts.rows.map((row) => String(row.id));
    if (!availableAccountIds.length) throw new Error('The source database has no legacy or shared paper account to import.');
    const sourceActivity = await source.query(`
      SELECT
        (SELECT COUNT(*)::int FROM positions WHERE paper_account_id='shared-paper') +
        (SELECT COUNT(*)::int FROM paper_trade_decisions WHERE account_id='shared-paper') AS shared_rows,
        (SELECT COUNT(*)::int FROM positions WHERE paper_account_id IN ('strategy-system','wall-reaction-system')) +
        (SELECT COUNT(*)::int FROM paper_trade_decisions WHERE account_id IN ('strategy-system','wall-reaction-system')) AS legacy_rows
    `);
    const sharedRows = Number(sourceActivity.rows[0]?.shared_rows || 0);
    const legacyRows = Number(sourceActivity.rows[0]?.legacy_rows || 0);
    if (sharedRows > 0 && legacyRows > 0) {
      throw new Error('The source contains both shared and legacy paper activity. Resolve that partial migration before importing to avoid duplicate trades.');
    }
    const accountIds = sharedRows > 0
      ? [SHARED_ACCOUNT_ID]
      : availableAccountIds.filter((id) => id !== SHARED_ACCOUNT_ID);
    if (!accountIds.length) throw new Error('The source shared paper account is empty and no legacy paper accounts are available.');

    const [decisions, positions, orders, snapshots, reports, journal, baselines] = await Promise.all([
      source.query(`SELECT * FROM paper_trade_decisions WHERE account_id = ANY($1::varchar[]) ORDER BY id`, [accountIds]),
      source.query(`SELECT * FROM positions WHERE paper_account_id = ANY($1::varchar[]) ORDER BY id`, [accountIds]),
      source.query(`SELECT * FROM paper_orders WHERE account_id = ANY($1::varchar[]) ORDER BY id`, [accountIds]),
      source.query(`SELECT * FROM paper_equity_snapshots WHERE account_id = ANY($1::varchar[]) ORDER BY id`, [accountIds]),
      source.query(`SELECT * FROM paper_monthly_reports WHERE account_id = ANY($1::varchar[]) ORDER BY generated_at, id`, [accountIds]),
      source.query(`SELECT * FROM paper_trade_journal WHERE account_id = ANY($1::varchar[]) ORDER BY id`, [accountIds]),
      source.query(`SELECT * FROM paper_baseline_trades WHERE account_id = ANY($1::varchar[]) ORDER BY id`, [accountIds])
    ]);
    const sourceCounts = {
      decisions: decisions.rows.length,
      positions: positions.rows.length,
      orders: orders.rows.length,
      snapshots: snapshots.rows.length,
      reports: reports.rows.length,
      journal: journal.rows.length,
      baselines: baselines.rows.length
    };
    const total = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0);
    if (!total) throw new Error('The source paper account exists but has no ledger records to import.');
    console.log(`Found ${total} source paper-ledger records.`, sourceCounts);
    if (!APPLY) {
      console.log('Dry run only. Re-run with --apply after stopping paper automation on the destination.');
      return;
    }

    await target.query('BEGIN');
    try {
      await target.query(`LOCK TABLE paper_accounts IN SHARE ROW EXCLUSIVE MODE`);
      await prepareTargetSchema(target);
      const existingImport = await target.query(
        `SELECT migration_key FROM paper_ledger_migrations WHERE migration_key='shared-paper-import-v1'`
      );
      if (existingImport.rows[0]) {
        await target.query('COMMIT');
        console.log('Shared paper import was already completed; nothing to do.');
        return;
      }
      if (await countTargetPaperRows(target) > 0) {
        throw new Error('Destination already has shared paper activity. The importer will not merge or overwrite live ledger rows.');
      }
      await target.query(`
        INSERT INTO paper_accounts (id, name, initial_equity, cash_balance, equity, high_water_mark, start_of_day_equity, start_of_day_date)
        VALUES ($1, 'Shared Paper Trading Account', 100000, 100000, 100000, 100000, 100000, (NOW() AT TIME ZONE 'America/New_York')::date)
        ON CONFLICT (id) DO NOTHING
      `, [SHARED_ACCOUNT_ID]);
      await target.query(`
        INSERT INTO paper_strategy_controls (strategy_name) VALUES ('DAY_TRADING'), ('WALL_REACTION')
        ON CONFLICT (strategy_name) DO NOTHING
      `);

      const targetColumns = new Map<string, Set<string>>();
      for (const table of ['paper_trade_decisions', 'positions', 'paper_orders', 'paper_equity_snapshots', 'paper_monthly_reports', 'paper_trade_journal', 'paper_baseline_trades']) {
        targetColumns.set(table, await columnsFor(target, table));
      }
      const decisionIds = new Map<string, number>();
      const positionIds = new Map<string, number>();
      const decisionStrategies = new Map<string, 'DAY_TRADING' | 'WALL_REACTION'>();
      const positionStrategies = new Map<string, 'DAY_TRADING' | 'WALL_REACTION'>();

      for (const row of decisions.rows) {
        const strategy = strategyFor(row);
        const id = await insertRow(target, 'paper_trade_decisions', targetColumns.get('paper_trade_decisions')!, row, {
          account_id: SHARED_ACCOUNT_ID,
          strategy_name: strategy
        });
        if (!id) throw new Error(`Could not import decision ${row.id}.`);
        decisionIds.set(String(row.id), id);
        decisionStrategies.set(String(row.id), strategy);
      }
      for (const row of positions.rows) {
        const strategy = strategyFor(row);
        const id = await insertRow(target, 'positions', targetColumns.get('positions')!, row, {
          account_id: SHARED_ACCOUNT_ID,
          paper_account_id: SHARED_ACCOUNT_ID,
          paper_decision_id: row.paper_decision_id == null ? null : decisionIds.get(String(row.paper_decision_id)) || null,
          paper_strategy: strategy
        });
        if (!id) throw new Error(`Could not import position ${row.id}.`);
        positionIds.set(String(row.id), id);
        positionStrategies.set(String(row.id), strategy);
      }
      for (const row of orders.rows) {
        const strategy = strategyFor(row, decisionStrategies.get(String(row.decision_id)));
        await insertRow(target, 'paper_orders', targetColumns.get('paper_orders')!, row, {
          account_id: SHARED_ACCOUNT_ID,
          decision_id: row.decision_id == null ? null : decisionIds.get(String(row.decision_id)) || null,
          position_id: row.position_id == null ? null : positionIds.get(String(row.position_id)) || null,
          strategy_name: strategy
        });
      }
      for (const row of snapshots.rows) {
        await insertRow(target, 'paper_equity_snapshots', targetColumns.get('paper_equity_snapshots')!, row, { account_id: SHARED_ACCOUNT_ID });
      }
      const newestReportByMonth = new Map<string, Row>();
      for (const row of reports.rows) newestReportByMonth.set(String(row.month), row);
      for (const row of newestReportByMonth.values()) {
        await insertRow(target, 'paper_monthly_reports', targetColumns.get('paper_monthly_reports')!, row, { account_id: SHARED_ACCOUNT_ID }, {
          returningId: false,
          onConflict: ' ON CONFLICT (account_id, month) DO NOTHING'
        });
      }
      for (const row of journal.rows) {
        const strategy = strategyFor(row, decisionStrategies.get(String(row.decision_id)) || positionStrategies.get(String(row.position_id)));
        await insertRow(target, 'paper_trade_journal', targetColumns.get('paper_trade_journal')!, row, {
          account_id: SHARED_ACCOUNT_ID,
          decision_id: row.decision_id == null ? null : decisionIds.get(String(row.decision_id)) || null,
          position_id: row.position_id == null ? null : positionIds.get(String(row.position_id)) || null,
          strategy_name: strategy
        });
      }
      for (const row of baselines.rows) {
        const decisionId = decisionIds.get(String(row.decision_id));
        if (!decisionId) throw new Error(`Baseline trade ${row.id} refers to an unavailable decision ${row.decision_id}.`);
        await insertRow(target, 'paper_baseline_trades', targetColumns.get('paper_baseline_trades')!, row, {
          account_id: SHARED_ACCOUNT_ID,
          decision_id: decisionId,
          position_id: row.position_id == null ? null : positionIds.get(String(row.position_id)) || null
        });
      }
      const totals = await target.query(`
        SELECT
          COALESCE(SUM(realized_pnl),0)::numeric AS realized_pnl,
          COALESCE(SUM(entry_price*quantity*100) FILTER (WHERE status='OPEN'),0)::numeric AS open_cost,
          COALESCE(SUM(COALESCE(current_price, entry_price)*quantity*100) FILTER (WHERE status='OPEN'),0)::numeric AS market_value
        FROM positions WHERE paper_account_id=$1
      `, [SHARED_ACCOUNT_ID]);
      const pending = await target.query(`
        SELECT COALESCE(SUM(reserved_debit),0)::numeric AS reserved_cash
        FROM paper_orders WHERE account_id=$1 AND intent='ENTRY' AND status='PENDING'
      `, [SHARED_ACCOUNT_ID]);
      const cash = 100000 + Number(totals.rows[0]?.realized_pnl || 0) - Number(totals.rows[0]?.open_cost || 0);
      const equity = cash + Number(totals.rows[0]?.market_value || 0);
      await target.query(`
        UPDATE paper_accounts
        SET name='Shared Paper Trading Account', initial_equity=100000, cash_balance=$1, reserved_cash=$2,
            equity=$3, high_water_mark=GREATEST(high_water_mark,100000,$3), start_of_day_equity=$3,
            start_of_day_date=(NOW() AT TIME ZONE 'America/New_York')::date, updated_at=NOW()
        WHERE id=$4
      `, [cash, Number(pending.rows[0]?.reserved_cash || 0), equity, SHARED_ACCOUNT_ID]);
      await target.query(`INSERT INTO paper_ledger_migrations (migration_key) VALUES ('shared-paper-import-v1')`);
      await target.query('COMMIT');
      console.log(`Imported ${total} ledger records into the shared $100,000 paper account.`);
    } catch (error) {
      await target.query('ROLLBACK');
      throw error;
    }
  } finally {
    source.release();
    target.release();
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error: any) => {
  console.error(`Shared paper import failed: ${error.message || String(error)}`);
  process.exitCode = 1;
});
