import { FastifyInstance } from 'fastify';
import { getNewYorkDateParts, getUSMarketCloseMinutes } from '../lib/market-calendar';
import { IbkrMarketDataService } from './ibkr-market-data-service';
import { WallReactionCandidate, WALL_REACTION_POLICY_VERSION } from './wall-reaction-service';

export const WALL_REACTION_ACCOUNT_ID = 'wall-reaction-system';
const ARM_MS = 5 * 60_000;
const ORDER_MS = 60_000;

export function isWallReturnConfirmed(candidate: WallReactionCandidate): boolean {
  if (!candidate.context || !candidate.plan) return false;
  return candidate.decision.direction === 'bearish'
    ? candidate.context.spot <= candidate.plan.wall
    : candidate.decision.direction === 'bullish' && candidate.context.spot >= candidate.plan.wall;
}

export function wallReactionExitIntent(position: any, spot: number, now = new Date()): string | null {
  const analysis = typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data || {};
  const isCall = String(position.option_type).toUpperCase() === 'CALL';
  const invalidation = Number(position.suggested_stop_loss || 0);
  const target1 = Number(position.suggested_take_profit_1 || 0);
  const target2 = Number(position.suggested_take_profit_2 || 0);
  if (invalidation > 0 && (isCall ? spot <= invalidation : spot >= invalidation)) return 'INVALIDATION';
  if (target2 > 0 && (isCall ? spot >= target2 : spot <= target2)) return 'TARGET_2';
  if (!analysis.t1Reached && target1 > 0 && (isCall ? spot >= target1 : spot <= target1)) return 'TARGET_1';
  const market = getNewYorkDateParts(now);
  if (market.minutes >= getUSMarketCloseMinutes(now) - 10) return 'END_OF_DAY';
  const expiry = String(position.expiration_date || '').slice(0, 10);
  if (expiry && expiry < market.dateKey) return 'EXPIRED_RECOVERY';
  return null;
}

export class WallReactionPaperService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly marketData: IbkrMarketDataService;
  private health = { status: 'IDLE', lastRunAt: null as string | null, lastError: null as string | null };

  constructor(private readonly fastify: FastifyInstance) {
    this.marketData = (fastify as any).ibkrMarketData || new IbkrMarketDataService(fastify);
  }

  public start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 5_000);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public getHealth() { return this.health; }

  public async arm(candidateId: string, requestedByUserId: number | null) {
    const candidate = ['SPY', 'QQQ'].map((symbol) => (this.fastify as any).wallReaction.getCandidate(symbol)).find((item: any) => item?.id === candidateId) as WallReactionCandidate | undefined;
    if (!candidate || candidate.status !== 'CANDIDATE' || !candidate.contract || !candidate.plan || !candidate.context) {
      const error: any = new Error('Candidate is no longer entry-ready'); error.statusCode = 409; throw error;
    }
    const ageSeconds = (Date.now() - Date.parse(candidate.generatedAt)) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds < -5 || ageSeconds > 20 || candidate.macro.blocked || !isWallReturnConfirmed(candidate)) {
      const error: any = new Error('Candidate freshness, macro, or wall-return gate failed'); error.statusCode = 409; throw error;
    }
    const account = await this.account();
    if (account.automation_status !== 'ACTIVE') {
      const error: any = new Error('Wall Reaction paper account is paused'); error.statusCode = 409; throw error;
    }
    const armedUntil = new Date(Date.now() + ARM_MS).toISOString();
    const { rows } = await (this.fastify as any).pg.query(
      `UPDATE wall_reaction_candidates SET status='ARMED', armed_at=NOW(), armed_until=$2, updated_at=NOW()
       WHERE id=$1 AND status='CANDIDATE' RETURNING *`, [candidateId, armedUntil]
    );
    if (!rows[0]) { const error: any = new Error('Candidate was already handled'); error.statusCode = 409; throw error; }
    candidate.status = 'ARMED';
    await this.journal('CANDIDATE_ARMED', `Manual paper entry armed for five minutes by user ${requestedByUserId || 'unknown'}.`, candidate.id, null, null, null, { symbol: candidate.symbol, fingerprint: candidate.fingerprint });
    return { candidateId, status: 'ARMED', armedUntil, paperOnly: true };
  }

  public async setAutomationStatus(status: 'ACTIVE' | 'PAUSED') {
    const { rows } = await (this.fastify as any).pg.query(
      `UPDATE paper_accounts SET automation_status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [status, WALL_REACTION_ACCOUNT_ID]
    );
    return rows[0];
  }

  public async getSummary() {
    const [account, positions, orders, decisions] = await Promise.all([
      this.account(),
      (this.fastify as any).pg.query(`SELECT * FROM positions WHERE paper_account_id=$1 ORDER BY created_at DESC LIMIT 100`, [WALL_REACTION_ACCOUNT_ID]),
      (this.fastify as any).pg.query(`SELECT * FROM paper_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100`, [WALL_REACTION_ACCOUNT_ID]),
      (this.fastify as any).pg.query(`SELECT * FROM paper_trade_decisions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100`, [WALL_REACTION_ACCOUNT_ID])
    ]);
    return { account, positions: positions.rows, orders: orders.rows, decisions: decisions.rows, health: this.health, paperOnly: true };
  }

  public async getJournal(limit = 100, offset = 0) {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT * FROM paper_trade_journal WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [WALL_REACTION_ACCOUNT_ID, Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
    );
    return rows;
  }

  public async closePosition(positionId: number) {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT * FROM positions WHERE id=$1 AND paper_account_id=$2 AND status='OPEN'`, [positionId, WALL_REACTION_ACCOUNT_ID]
    );
    const position = rows[0];
    if (!position) { const error: any = new Error('Open Wall Reaction paper position not found'); error.statusCode = 404; throw error; }
    const quote = await this.marketData.getOptionQuoteForOsi(null, this.osiTicker(position));
    if (!quote || quote.bid <= 0 || quote.quoteAgeMs === null || quote.quoteAgeMs < -5_000 || quote.quoteAgeMs > 15_000) {
      const error: any = new Error('A fresh IBKR bid is required for paper close'); error.statusCode = 409; throw error;
    }
    await this.closeQuantity(position, Number(position.quantity), quote.bid, 'MANUAL_CLOSE');
    return { positionId, status: 'CLOSED', fillPrice: quote.bid };
  }

  public async run(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const errors: string[] = [];
      for (const [name, work] of [
        ['arm expiry', () => this.expireArms()],
        ['armed entries', () => this.processArmedCandidates(now)],
        ['pending orders', () => this.processPendingOrders(now)],
        ['open positions', () => this.monitorPositions(now)]
      ] as const) {
        try { await work(); }
        catch (error: any) { errors.push(`${name}: ${error.message || String(error)}`); }
      }
      this.health = { status: errors.length ? 'DEGRADED' : 'UP', lastRunAt: now.toISOString(), lastError: errors.join('; ') || null };
      if (errors.length) this.fastify.log.warn(`[WallReactionPaper] Cycle degraded: ${this.health.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async account(queryable: any = (this.fastify as any).pg) {
    const { rows } = await queryable.query(`SELECT * FROM paper_accounts WHERE id=$1`, [WALL_REACTION_ACCOUNT_ID]);
    if (!rows[0]) throw new Error('Wall Reaction paper account is unavailable');
    return rows[0];
  }

  private async expireArms(): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `UPDATE wall_reaction_candidates SET status='EXPIRED', invalidated_at=NOW(), updated_at=NOW()
       WHERE status='ARMED' AND armed_until <= NOW() RETURNING id, symbol`
    );
    for (const row of rows) await this.journal('ARM_EXPIRED', 'Manual paper-entry arm expired without a fill.', row.id, null, null, null, { symbol: row.symbol });
  }

  private async processArmedCandidates(now: Date): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT id, symbol, fingerprint FROM wall_reaction_candidates WHERE status='ARMED' AND armed_until > NOW() ORDER BY armed_at ASC`
    );
    for (const armed of rows) {
      const current = (this.fastify as any).wallReaction.getCandidate(armed.symbol) as WallReactionCandidate | null;
      const candidateAgeSeconds = current ? (now.getTime() - Date.parse(current.generatedAt)) / 1000 : NaN;
      if (!current || current.id !== armed.id || current.fingerprint !== armed.fingerprint || !current.contract || !current.plan
        || !Number.isFinite(candidateAgeSeconds) || candidateAgeSeconds < -5 || candidateAgeSeconds > 25
        || current.macro.blocked || !isWallReturnConfirmed(current)) {
        await (this.fastify as any).pg.query(`UPDATE wall_reaction_candidates SET status='INVALIDATED', invalidated_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='ARMED'`, [armed.id]);
        await this.journal('ARM_INVALIDATED', 'Candidate changed or a required entry gate no longer passes.', armed.id, null, null, null, { symbol: armed.symbol });
        continue;
      }
      await this.createEntryOrder(current, now);
    }
  }

  private async createEntryOrder(candidate: WallReactionCandidate, now: Date): Promise<void> {
    const contract = candidate.contract!;
    const plan = candidate.plan!;
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query(`SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE`, [WALL_REACTION_ACCOUNT_ID])).rows[0];
      if (!account) throw new Error('Wall Reaction paper account is unavailable');
      const debit = contract.protectedLimit * contract.quantity * 100;
      if (account.automation_status !== 'ACTIVE' || Number(account.cash_balance) - Number(account.reserved_cash) < debit) {
        await client.query(`UPDATE wall_reaction_candidates SET status='INVALIDATED', invalidated_at=NOW(), updated_at=NOW() WHERE id=$1`, [candidate.id]);
        await client.query('COMMIT');
        await this.journal('ENTRY_SKIPPED', 'Paper account is paused or has insufficient available cash.', candidate.id, null, null, null, { requiredDebit: debit });
        return;
      }
      const decision = await client.query(
        `INSERT INTO paper_trade_decisions (
           account_id, setup_id, decision, risk_tier, exit_profile, source, quantity, max_quantity,
           debit_budget, protected_limit, prompt_version, policy_version, rationale, evidence
         ) VALUES ($1,$2,'TRADE',$3,$4,'RULES',$5,2,$6,$7,$8,$8,$9,$10)
         ON CONFLICT (account_id,setup_id) DO NOTHING RETURNING *`,
        [WALL_REACTION_ACCOUNT_ID, candidate.id, candidate.decision.riskMultiplier === 0.5 ? 'STANDARD' : 'CAUTIOUS',
          contract.quantity === 2 ? 'STRUCTURAL_T2' : 'STRUCTURAL_T1', contract.quantity, plan.debitBudget,
          contract.protectedLimit, WALL_REACTION_POLICY_VERSION, 'Manual arm passed all deterministic Wall Reaction gates.',
          JSON.stringify({ candidateFingerprint: candidate.fingerprint, symbol: candidate.symbol, plan, contract })]
      );
      const decisionRow = decision.rows[0];
      if (!decisionRow) { await client.query('ROLLBACK'); return; }
      const order = await client.query(
        `INSERT INTO paper_orders (
           account_id, decision_id, setup_id, intent, action, status, osi_ticker, option_type,
           strike, expiration, quantity, limit_price, reserved_debit, quote_snapshot, expires_at
         ) VALUES ($1,$2,$3,'ENTRY','BUY_TO_OPEN','PENDING',$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (account_id,setup_id,intent) DO NOTHING RETURNING *`,
        [WALL_REACTION_ACCOUNT_ID, decisionRow.id, candidate.id, contract.ticker, contract.right === 'call' ? 'CALL' : 'PUT',
          contract.strike, contract.expiration, contract.quantity, contract.protectedLimit, debit, JSON.stringify(contract), new Date(now.getTime() + ORDER_MS).toISOString()]
      );
      if (!order.rows[0]) { await client.query('ROLLBACK'); return; }
      await client.query(`UPDATE paper_accounts SET reserved_cash=reserved_cash+$1, updated_at=NOW() WHERE id=$2`, [debit, WALL_REACTION_ACCOUNT_ID]);
      await client.query('COMMIT');
      await this.journal('ENTRY_ORDER_CREATED', `Protected paper order queued for ${contract.quantity} contract(s).`, candidate.id, decisionRow.id, null, contract.protectedLimit, { ticker: contract.ticker });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async processPendingOrders(now: Date): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT po.*, ptd.evidence FROM paper_orders po JOIN paper_trade_decisions ptd ON ptd.id=po.decision_id
       WHERE po.account_id=$1 AND po.intent='ENTRY' AND po.status='PENDING' ORDER BY po.created_at ASC`, [WALL_REACTION_ACCOUNT_ID]
    );
    for (const order of rows) {
      if (new Date(order.expires_at).getTime() <= now.getTime()) { await this.cancelOrder(order, 'Protected paper order expired after 60 seconds'); continue; }
      const current = (this.fastify as any).wallReaction.getCandidate(String((typeof order.evidence === 'string' ? JSON.parse(order.evidence) : order.evidence)?.symbol || '').toUpperCase()) as WallReactionCandidate | null;
      const candidateAgeSeconds = current ? (now.getTime() - Date.parse(current.generatedAt)) / 1000 : NaN;
      if (!current || current.id !== String(order.setup_id) || !current.contract || !current.plan
        || !Number.isFinite(candidateAgeSeconds) || candidateAgeSeconds < -5 || candidateAgeSeconds > 25
        || current.macro.blocked || !isWallReturnConfirmed(current) || current.contract.ticker !== order.osi_ticker) {
        await this.cancelOrder(order, 'Candidate changed or an entry gate failed before fill');
        continue;
      }
      const account = await this.account();
      if (account.automation_status !== 'ACTIVE') { await this.cancelOrder(order, 'Wall Reaction paper account is paused'); continue; }
      const quote = await this.marketData.getOptionQuoteForOsi(null, order.osi_ticker);
      if (!quote || quote.ask <= 0 || quote.quoteAgeMs === null || quote.quoteAgeMs < -5_000 || quote.quoteAgeMs > 15_000) continue;
      if (quote.ask > Number(order.limit_price)) continue;
      await this.fillOrder(order, quote.ask);
    }
  }

  private async fillOrder(order: any, fillPrice: number): Promise<void> {
    const evidence = typeof order.evidence === 'string' ? JSON.parse(order.evidence) : order.evidence || {};
    const plan = evidence.plan || {};
    const client = await (this.fastify as any).pg.connect();
    let position: any = null;
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM paper_orders WHERE id=$1 FOR UPDATE`, [order.id]);
      if (locked.rows[0]?.status !== 'PENDING') { await client.query('ROLLBACK'); return; }
      const debit = fillPrice * Number(order.quantity) * 100;
      position = (await client.query(
        `INSERT INTO positions (
           user_id, symbol, option_type, strike_price, expiration_date, entry_price, quantity,
           current_price, underlying_price, status, is_simulated, account_id, execution_broker,
           execution_status, contracts_requested, entry_action, exit_action, suggested_stop_loss,
           suggested_take_profit_1, suggested_take_profit_2, strategy_setup_id, strategy_engine_version,
           strategy_lifecycle_status, strategy_snapshot, strategy_managed, paper_account_id,
           paper_decision_id, analysis_data, notes
         ) VALUES (NULL,$1,$2,$3,$4,$5,$6,$5,$7,'OPEN',TRUE,$8,'wall_reaction_paper','FILLED',$6,
           'BUY_TO_OPEN','SELL_TO_CLOSE',$9,$10,$11,$12,$13,'ACTIVE',$14,TRUE,$8,$15,$16,$17) RETURNING *`,
        [evidence.symbol, order.option_type, Number(order.strike), order.expiration, fillPrice, Number(order.quantity),
          Number(evidence.contract?.underlyingPrice || 0) || null, WALL_REACTION_ACCOUNT_ID, plan.invalidation,
          plan.target1, plan.target2, order.setup_id, WALL_REACTION_POLICY_VERSION, JSON.stringify(evidence),
          order.decision_id, JSON.stringify({ originalQuantity: Number(order.quantity), t1Reached: false, policyVersion: WALL_REACTION_POLICY_VERSION }),
          `[Wall Reaction paper entry from candidate ${order.setup_id}]`]
      )).rows[0];
      await client.query(`UPDATE paper_orders SET status='FILLED', fill_price=$1, position_id=$2, filled_at=NOW(), updated_at=NOW() WHERE id=$3`, [fillPrice, position.id, order.id]);
      await client.query(`UPDATE paper_accounts SET cash_balance=cash_balance-$1, reserved_cash=GREATEST(0,reserved_cash-$2), updated_at=NOW() WHERE id=$3`, [debit, Number(order.reserved_debit), WALL_REACTION_ACCOUNT_ID]);
      await client.query(`UPDATE wall_reaction_candidates SET status='ENTERED', entered_at=NOW(), updated_at=NOW() WHERE id=$1`, [order.setup_id]);
      await this.refreshEquity(client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await this.journal('ENTRY_FILLED', `${order.option_type} paper entry filled at $${fillPrice.toFixed(2)}.`, order.setup_id, order.decision_id, position.id, fillPrice, { quantity: Number(order.quantity), ticker: order.osi_ticker });
  }

  private async cancelOrder(order: any, reason: string): Promise<void> {
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`UPDATE paper_orders SET status='EXPIRED', failure_reason=$1, updated_at=NOW() WHERE id=$2 AND status='PENDING' RETURNING reserved_debit`, [reason, order.id]);
      if (rows[0]) await client.query(`UPDATE paper_accounts SET reserved_cash=GREATEST(0,reserved_cash-$1), updated_at=NOW() WHERE id=$2`, [Number(rows[0].reserved_debit), WALL_REACTION_ACCOUNT_ID]);
      await client.query(`UPDATE wall_reaction_candidates SET status='EXPIRED', invalidated_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='ARMED'`, [order.setup_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await this.journal('ENTRY_EXPIRED', reason, order.setup_id, order.decision_id, null, null, { orderId: order.id });
  }

  private async monitorPositions(now: Date): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(`SELECT * FROM positions WHERE paper_account_id=$1 AND status='OPEN' ORDER BY id`, [WALL_REACTION_ACCOUNT_ID]);
    const errors: string[] = [];
    for (const position of rows) {
      try {
        const [underlying, option] = await Promise.all([
          this.marketData.getUnderlyingQuote(position.symbol),
          this.marketData.getOptionQuoteForOsi(null, this.osiTicker(position))
        ]);
        if (!option || option.bid <= 0 || option.quoteAgeMs === null || option.quoteAgeMs < -5_000 || option.quoteAgeMs > 15_000) continue;
        const spot = underlying.mark;
        const analysis = typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data || {};
        await (this.fastify as any).pg.query(`UPDATE positions SET current_price=$1, underlying_price=$2, updated_at=NOW() WHERE id=$3 AND status='OPEN'`, [option.bid, spot, position.id]);
        const current = (this.fastify as any).wallReaction.getCandidate(String(position.symbol).toUpperCase());
        const migrated = position.option_type === 'PUT'
          ? current?.context?.trap?.call_wall_migrated_up === true
          : current?.context?.trap?.put_wall_migrated_down === true;
        const intent = migrated ? 'WALL_MIGRATION' : wallReactionExitIntent({ ...position, analysis_data: analysis }, spot, now);
        if (!intent) continue;
        if (intent === 'TARGET_1' && Number(position.quantity) > 1) {
          analysis.t1Reached = true; analysis.t1ReachedAt = now.toISOString();
          await (this.fastify as any).pg.query(`UPDATE positions SET analysis_data=$1, updated_at=NOW() WHERE id=$2 AND status='OPEN'`, [JSON.stringify(analysis), position.id]);
          await this.closeQuantity({ ...position, analysis_data: analysis }, 1, option.bid, 'TARGET_1');
        } else {
          await this.closeQuantity(position, Number(position.quantity), option.bid, intent);
        }
      } catch (error: any) {
        this.fastify.log.warn(`[WallReactionPaper] Position ${position.id} monitor failed: ${error.message}`);
        errors.push(`position ${position.id}: ${error.message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  private async closeQuantity(position: any, quantity: number, fillPrice: number, intent: string): Promise<void> {
    const client = await (this.fastify as any).pg.connect();
    let closeQty = 0;
    try {
      await client.query('BEGIN');
      const locked = (await client.query(`SELECT * FROM positions WHERE id=$1 AND paper_account_id=$2 AND status='OPEN' FOR UPDATE`, [position.id, WALL_REACTION_ACCOUNT_ID])).rows[0];
      if (!locked) { await client.query('ROLLBACK'); return; }
      closeQty = Math.min(Number(locked.quantity), quantity);
      const inserted = await client.query(
        `INSERT INTO paper_orders (account_id,decision_id,position_id,setup_id,intent,action,status,osi_ticker,option_type,strike,expiration,quantity,fill_price,filled_at)
         VALUES ($1,$2,$3,$4,$5,'SELL_TO_CLOSE','FILLED',$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (account_id,setup_id,intent) DO NOTHING RETURNING id`,
        [WALL_REACTION_ACCOUNT_ID, locked.paper_decision_id, locked.id, locked.strategy_setup_id, `EXIT_${intent}`, this.osiTicker(locked), locked.option_type,
          Number(locked.strike_price), locked.expiration_date, closeQty, fillPrice]
      );
      if (!inserted.rows[0]) { await client.query('ROLLBACK'); return; }
      const proceeds = fillPrice * closeQty * 100;
      const pnl = (fillPrice - Number(locked.entry_price)) * closeQty * 100;
      const remaining = Number(locked.quantity) - closeQty;
      if (remaining > 0) {
        await client.query(`UPDATE positions SET quantity=$1, realized_pnl=COALESCE(realized_pnl,0)+$2, current_price=$3, updated_at=NOW() WHERE id=$4`, [remaining, pnl, fillPrice, locked.id]);
      } else {
        await client.query(`UPDATE positions SET quantity=0, status='CLOSED', exit_price=$1, realized_pnl=COALESCE(realized_pnl,0)+$2, current_price=$1, strategy_lifecycle_status='COMPLETED', strategy_exit_reason=$3, updated_at=NOW() WHERE id=$4`, [fillPrice, pnl, intent, locked.id]);
      }
      await client.query(`UPDATE paper_accounts SET cash_balance=cash_balance+$1, updated_at=NOW() WHERE id=$2`, [proceeds, WALL_REACTION_ACCOUNT_ID]);
      await this.refreshEquity(client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await this.journal(`EXIT_${intent}`, `${closeQty} contract(s) closed at $${fillPrice.toFixed(2)}.`, position.strategy_setup_id, position.paper_decision_id, position.id, fillPrice, { quantity: closeQty });
  }

  private async refreshEquity(queryable: any): Promise<void> {
    const { rows } = await queryable.query(
      `SELECT COALESCE(SUM(current_price*quantity*100),0)::numeric AS market_value FROM positions WHERE paper_account_id=$1 AND status='OPEN'`, [WALL_REACTION_ACCOUNT_ID]
    );
    await queryable.query(
      `UPDATE paper_accounts SET equity=cash_balance+$1, high_water_mark=GREATEST(high_water_mark,cash_balance+$1), updated_at=NOW() WHERE id=$2`,
      [Number(rows[0]?.market_value || 0), WALL_REACTION_ACCOUNT_ID]
    );
  }

  private osiTicker(position: any): string {
    const expiry = String(position.expiration_date).slice(0, 10).replace(/-/g, '').slice(2);
    return `${String(position.symbol).toUpperCase()}${expiry}${position.option_type === 'CALL' ? 'C' : 'P'}${Math.round(Number(position.strike_price) * 1000).toString().padStart(8, '0')}`;
  }

  private async journal(eventType: string, message: string, setupId: string | null, decisionId: number | null, positionId: number | null, premium: number | null, metadata: Record<string, any> = {}) {
    await (this.fastify as any).pg.query(
      `INSERT INTO paper_trade_journal (account_id,setup_id,decision_id,position_id,event_type,policy_version,message,premium,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [WALL_REACTION_ACCOUNT_ID, setupId, decisionId, positionId, eventType, WALL_REACTION_POLICY_VERSION, message, premium, JSON.stringify(metadata)]
    );
  }
}
