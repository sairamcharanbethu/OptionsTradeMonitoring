import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PaperTradingService, PAPER_POLICY_VERSION } from './paper-trading-service';

const databaseUrl = process.env.PAPER_TEST_DATABASE_URL;

async function run() {
  if (!databaseUrl) {
    console.log('PaperTradingService database integration tests skipped: PAPER_TEST_DATABASE_URL is not set.');
    return;
  }

  const schema = `paper_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

  try {
    await pool.query(`
      CREATE TABLE paper_accounts (
        id varchar(50) PRIMARY KEY, initial_equity numeric NOT NULL, cash_balance numeric NOT NULL,
        reserved_cash numeric NOT NULL, equity numeric NOT NULL, high_water_mark numeric NOT NULL,
        start_of_day_equity numeric NOT NULL, start_of_day_date date NOT NULL,
        automation_status varchar(20) NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE paper_trade_decisions (
        id bigserial PRIMARY KEY, account_id varchar(50) NOT NULL, setup_id uuid NOT NULL,
        policy_version varchar(50) NOT NULL, trailing_stop_pct numeric NOT NULL
      );
      CREATE TABLE paper_orders (
        id bigserial PRIMARY KEY, account_id varchar(50) NOT NULL, decision_id bigint, position_id integer,
        setup_id uuid NOT NULL, signal_id integer, intent varchar(50) NOT NULL, action varchar(30) NOT NULL,
        status varchar(20) NOT NULL, osi_ticker varchar(50) NOT NULL, option_type varchar(4) NOT NULL,
        strike numeric NOT NULL, expiration date NOT NULL, quantity integer NOT NULL,
        limit_price numeric, fill_price numeric, reserved_debit numeric NOT NULL DEFAULT 0,
        quote_snapshot jsonb DEFAULT '{}', failure_reason text, expires_at timestamptz,
        filled_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        UNIQUE(account_id, setup_id, intent)
      );
      CREATE TABLE positions (
        id serial PRIMARY KEY, paper_account_id varchar(50), paper_decision_id bigint, strategy_setup_id uuid,
        signal_id integer, option_type varchar(4), strike_price numeric, expiration_date date,
        entry_price numeric, quantity integer, contracts_requested integer, current_price numeric,
        underlying_price numeric, trailing_high_price numeric, trailing_stop_loss_pct numeric,
        suggested_stop_loss numeric, status varchar(20), realized_pnl numeric DEFAULT 0, exit_price numeric,
        execution_status varchar(30), exit_reason varchar(50), analysis_data jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE paper_baseline_trades (
        id bigserial PRIMARY KEY, account_id varchar(50), decision_id bigint, setup_id uuid, position_id integer,
        quantity integer DEFAULT 1, status varchar(20), entry_price numeric, current_price numeric,
        exit_price numeric, realized_pnl numeric DEFAULT 0, exit_reason varchar(50), policy_version varchar(50),
        trailing_stop_pct numeric, created_at timestamptz DEFAULT now(), closed_at timestamptz, updated_at timestamptz DEFAULT now(),
        UNIQUE(account_id, decision_id)
      );
      CREATE TABLE paper_trade_journal (
        id bigserial PRIMARY KEY, account_id varchar(50), setup_id uuid, decision_id bigint, position_id integer,
        event_type varchar(50), policy_version varchar(50), message text, premium numeric,
        underlying_price numeric, quantity integer, metadata jsonb, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE paper_equity_snapshots (
        id bigserial PRIMARY KEY, account_id varchar(50), equity numeric, cash_balance numeric,
        reserved_cash numeric, realized_pnl numeric, unrealized_pnl numeric, captured_at timestamptz DEFAULT now()
      );
      CREATE TABLE users (id serial PRIMARY KEY, role varchar(20));
    `);
    await pool.query(
      `INSERT INTO paper_accounts (
         id,initial_equity,cash_balance,reserved_cash,equity,high_water_mark,
         start_of_day_equity,start_of_day_date,automation_status
       ) VALUES ('strategy-system',100000,100000,999,100000,100000,100000,current_date,'ACTIVE')`
    );
    const setup1 = '11111111-1111-4111-8111-111111111111';
    const setup2 = '22222222-2222-4222-8222-222222222222';
    const decisions = await pool.query(
      `INSERT INTO paper_trade_decisions (account_id,setup_id,policy_version,trailing_stop_pct)
       VALUES ('strategy-system',$1,$3,15),('strategy-system',$2,$3,15) RETURNING id,setup_id`,
      [setup1, setup2, PAPER_POLICY_VERSION]
    );
    const firstDecision = decisions.rows.find(row => row.setup_id === setup1).id;
    await pool.query(
      `INSERT INTO paper_orders (account_id,decision_id,setup_id,intent,action,status,osi_ticker,option_type,strike,expiration,quantity,reserved_debit,expires_at)
       VALUES ('strategy-system',$1,$2,'ENTRY','BUY_TO_OPEN','PENDING','SPY260801C00750000','CALL',750,'2026-08-01',1,500,now()-interval '1 minute'),
              ('strategy-system',$1,$3,'ENTRY','BUY_TO_OPEN','PENDING','SPY260802C00750000','CALL',750,'2026-08-02',1,200,now()+interval '1 hour')`,
      [firstDecision, setup1, setup2]
    );

    const fastify: any = { pg: pool, log: { warn() {}, info() {}, error() {} } };
    const liveState = new Map<string, Record<string, string>>();
    const redis = {
      isReady: () => true,
      hset: async (key: string, values: Record<string, any>) => {
        liveState.set(key, Object.fromEntries(Object.entries(values).map(([field, value]) => [field, String(value)])));
      },
      hgetall: async (key: string) => liveState.get(key) || {},
      del: async (key: string) => { liveState.delete(key); }
    };
    const service = new PaperTradingService(fastify, redis);
    await service.recover();
    const recovered = await pool.query(`SELECT reserved_cash,equity FROM paper_accounts WHERE id='strategy-system'`);
    assert.equal(Number(recovered.rows[0].reserved_cash), 200, 'restart recovery must rebuild pending-order reserves');
    assert.equal(Number(recovered.rows[0].equity), 100000, 'restart recovery must reconcile account equity');
    const expired = await pool.query(`SELECT status FROM paper_orders WHERE setup_id=$1`, [setup1]);
    assert.equal(expired.rows[0].status, 'EXPIRED', 'restart recovery must expire stale entries');

    await pool.query(`UPDATE paper_orders SET status='EXPIRED' WHERE setup_id=$1`, [setup2]);
    await pool.query(`UPDATE paper_accounts SET cash_balance=99800,reserved_cash=0,equity=100000 WHERE id='strategy-system'`);
    const position = (await pool.query(
      `INSERT INTO positions (
         paper_account_id,paper_decision_id,strategy_setup_id,option_type,strike_price,expiration_date,
         entry_price,quantity,contracts_requested,current_price,underlying_price,status,analysis_data
       ) VALUES ('strategy-system',$1,$2,'CALL',750,'2026-08-01',1,2,2,1,750,'OPEN',$3) RETURNING *`,
      [firstDecision, setup1, JSON.stringify({ originalQuantity: 2, policyVersion: PAPER_POLICY_VERSION, trailingStopPct: 15 })]
    )).rows[0];
    await pool.query(
      `INSERT INTO paper_baseline_trades (account_id,decision_id,setup_id,position_id,status,entry_price,current_price,policy_version,trailing_stop_pct)
       VALUES ('strategy-system',$1,$2,$3,'OPEN',1,1,$4,15)`,
      [firstDecision, setup1, position.id, PAPER_POLICY_VERSION]
    );

    await service.closePaperQuantity(position, 1, 1.5, 'TARGET_1_TRIM');
    const partial = await pool.query(`SELECT quantity,status,realized_pnl FROM positions WHERE id=$1`, [position.id]);
    const partialAccount = await pool.query(`SELECT cash_balance,equity FROM paper_accounts WHERE id='strategy-system'`);
    assert.deepEqual(
      [Number(partial.rows[0].quantity), partial.rows[0].status, Number(partial.rows[0].realized_pnl)],
      [1, 'OPEN', 50],
      'partial exit must preserve the remaining contract and realized P&L'
    );
    assert.deepEqual([Number(partialAccount.rows[0].cash_balance), Number(partialAccount.rows[0].equity)], [99950, 100100]);

    const remainingPosition = (await pool.query(`SELECT * FROM positions WHERE id=$1`, [position.id])).rows[0];
    await service.closePaperQuantity(remainingPosition, 1, 2, 'TARGET_2');
    const closed = await pool.query(`SELECT quantity,status,realized_pnl FROM positions WHERE id=$1`, [position.id]);
    const finalAccount = await pool.query(`SELECT cash_balance,equity FROM paper_accounts WHERE id='strategy-system'`);
    const baseline = await pool.query(`SELECT status,realized_pnl FROM paper_baseline_trades WHERE decision_id=$1`, [firstDecision]);
    assert.deepEqual([Number(closed.rows[0].quantity), closed.rows[0].status, Number(closed.rows[0].realized_pnl)], [0, 'CLOSED', 150]);
    assert.deepEqual([Number(finalAccount.rows[0].cash_balance), Number(finalAccount.rows[0].equity)], [100150, 100150]);
    assert.deepEqual([baseline.rows[0].status, Number(baseline.rows[0].realized_pnl)], ['CLOSED', 75], 'baseline must normalize the managed exit path to one contract');
    console.log('PaperTradingService database integration tests passed!');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
