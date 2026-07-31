import { FastifyInstance } from 'fastify';
import { AIService } from './ai-service';
import { DiscordAlertService } from './discord-alert-service';
import { getGlobalSettings } from '../lib/settings-utils';

const ACCOUNT_ID = 'strategy-system';
const PROMPT_VERSION = 'paper-risk-v1';
const ENTRY_TIMEOUT_MS = 60_000;
const MAX_CONTRACTS = 5;
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
});
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});

type RiskTier = 'CAUTIOUS' | 'STANDARD' | 'FULL';
type ExitProfile = 'CONSERVATIVE_T1' | 'BALANCED_T2';

export type PaperDecision = {
  decision: 'TRADE' | 'SKIP';
  riskTier: RiskTier;
  exitProfile: ExitProfile;
  source: 'AI' | 'FALLBACK';
  rationale: string;
  riskFlags: string[];
};

export class PaperTradingService {
  private activeSetups = new Set<string>();
  private monthlyTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private lastProcessedAt: string | null = null;

  constructor(private fastify: FastifyInstance) {}

  public start(): void {
    if (this.monthlyTimer) return;
    this.monthlyTimer = setInterval(() => {
      this.ensurePriorMonthReport().catch((error: any) => {
        this.lastError = error.message || String(error);
        this.fastify.log.warn(`[PaperTrading] Monthly report check failed: ${this.lastError}`);
      });
    }, 60 * 60 * 1000);
    this.ensurePriorMonthReport().catch((error: any) => {
      this.fastify.log.warn(`[PaperTrading] Initial monthly report check failed: ${error.message || String(error)}`);
    });
  }

  public stop(): void {
    if (this.monthlyTimer) clearInterval(this.monthlyTimer);
    this.monthlyTimer = null;
  }

  public getHealth() {
    return {
      status: this.lastError ? 'DEGRADED' : 'UP',
      accountId: ACCOUNT_ID,
      lastProcessedAt: this.lastProcessedAt,
      lastError: this.lastError
    };
  }

  public async getAccountSummary(): Promise<Record<string, any>> {
    const account = await this.account();
    const [positions, decisions, orders, reports, today] = await Promise.all([
      (this.fastify as any).pg.query(
        `SELECT p.*, ptd.risk_tier, ptd.exit_profile, ptd.source AS decision_source
         FROM positions p
         LEFT JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
         WHERE p.paper_account_id=$1 AND p.status='OPEN'
         ORDER BY p.created_at DESC`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_trade_decisions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 10`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 15`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_monthly_reports WHERE account_id=$1 ORDER BY month DESC LIMIT 12`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT COUNT(*) FILTER (WHERE intent='ENTRY' AND status='FILLED')::int AS entries,
                COALESCE(SUM(CASE WHEN action='SELL_TO_CLOSE' THEN (fill_price * quantity * 100) ELSE 0 END),0) AS exit_proceeds
         FROM paper_orders
         WHERE account_id=$1 AND (created_at AT TIME ZONE 'America/New_York')::date=$2::date`,
        [ACCOUNT_ID, ET_DATE.format(new Date())]
      )
    ]);
    const equity = Number(account.equity);
    const startOfDayEquity = Number(account.start_of_day_equity);
    return {
      account,
      openPositions: positions.rows,
      recentDecisions: decisions.rows,
      recentOrders: orders.rows,
      monthlyReports: reports.rows,
      limits: {
        maxDebitPct: 0.5,
        dailyLossPct: 1,
        maxTradesPerDay: 2,
        maxOpenPositions: 1,
        maxContracts: MAX_CONTRACTS
      },
      session: {
        entries: Number(today.rows[0]?.entries || 0),
        entriesRemaining: Math.max(0, 2 - Number(today.rows[0]?.entries || 0)),
        pnl: Number((equity - startOfDayEquity).toFixed(2)),
        pnlPct: startOfDayEquity > 0 ? Number((((equity - startOfDayEquity) / startOfDayEquity) * 100).toFixed(2)) : 0
      },
      health: this.getHealth()
    };
  }

  public async setAutomationStatus(status: 'ACTIVE' | 'PAUSED'): Promise<Record<string, any>> {
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      const lockedAccount = await client.query(`SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE`, [ACCOUNT_ID]);
      if (!lockedAccount.rows[0]) throw new Error('System paper account is unavailable');
      if (status === 'PAUSED') {
        const pending = await client.query(
          `UPDATE paper_orders SET status='EXPIRED', failure_reason='Paper automation paused by an administrator', updated_at=NOW()
           WHERE account_id=$1 AND intent='ENTRY' AND status='PENDING'
           RETURNING reserved_debit`, [ACCOUNT_ID]
        );
        const released = pending.rows.reduce((sum: number, row: any) => sum + Number(row.reserved_debit || 0), 0);
        if (released > 0) {
          await client.query(
            `UPDATE paper_accounts SET reserved_cash=GREATEST(0,reserved_cash-$1) WHERE id=$2`,
            [released, ACCOUNT_ID]
          );
        }
      }
      const { rows } = await client.query(
        `UPDATE paper_accounts SET automation_status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [status, ACCOUNT_ID]
      );
      if (!rows[0]) throw new Error('System paper account is unavailable');
      await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async processSnapshot(signal: Record<string, any>, setupId: string | null): Promise<void> {
    if (!setupId || this.activeSetups.has(setupId)) return;
    this.activeSetups.add(setupId);
    try {
      await this.rollSessionIfNeeded();
      await this.refreshOpenPositions(signal, setupId);
      await this.processPendingEntry(signal, setupId);
      await this.maybeCreateEntry(signal, setupId);
      await this.captureEquity(false);
      this.lastProcessedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error: any) {
      this.lastError = error.message || String(error);
      throw error;
    } finally {
      this.activeSetups.delete(setupId);
    }
  }

  public static quantityForBudget(equity: number, availableCash: number, limitPrice: number, tier: RiskTier): { quantity: number; maxQuantity: number; debitBudget: number } {
    const tierPct: Record<RiskTier, number> = { CAUTIOUS: 0.002, STANDARD: 0.0035, FULL: 0.005 };
    const fullBudget = Math.max(0, Math.min(equity * 0.005, availableCash));
    const debitBudget = Math.max(0, Math.min(equity * tierPct[tier], fullBudget));
    const contractDebit = limitPrice * 100;
    const maxQuantity = contractDebit > 0 ? Math.max(0, Math.min(MAX_CONTRACTS, Math.floor(fullBudget / contractDebit))) : 0;
    const quantity = contractDebit > 0 ? Math.max(0, Math.min(maxQuantity, Math.floor(debitBudget / contractDebit))) : 0;
    return { quantity, maxQuantity, debitBudget: Number(debitBudget.toFixed(2)) };
  }

  public static normalizeAIDecision(raw: any): PaperDecision | null {
    const decision = String(raw?.decision || raw?.verdict || '').toUpperCase();
    const riskTier = String(raw?.risk_tier || raw?.riskTier || '').toUpperCase();
    const exitProfile = String(raw?.exit_profile || raw?.exitProfile || '').toUpperCase();
    if (!['TRADE', 'SKIP'].includes(decision)) return null;
    if (!['CAUTIOUS', 'STANDARD', 'FULL'].includes(riskTier)) return null;
    if (!['CONSERVATIVE_T1', 'BALANCED_T2'].includes(exitProfile)) return null;
    return {
      decision: decision as 'TRADE' | 'SKIP',
      riskTier: riskTier as RiskTier,
      exitProfile: exitProfile as ExitProfile,
      source: 'AI',
      rationale: String(raw?.rationale || raw?.analysis || '').slice(0, 500),
      riskFlags: (Array.isArray(raw?.risk_flags) ? raw.risk_flags : []).slice(0, 5).map((value: any) => String(value).slice(0, 180))
    };
  }

  private optionFor(signal: Record<string, any>) {
    const side = signal.favoring === 'puts' ? 'PUT' : 'CALL';
    const setup = side === 'PUT' ? signal.put_setup || {} : signal.call_setup || {};
    return { side, setup, option: setup.option || {} };
  }

  private async account() {
    const { rows } = await (this.fastify as any).pg.query('SELECT * FROM paper_accounts WHERE id = $1', [ACCOUNT_ID]);
    if (!rows[0]) throw new Error('System paper account is unavailable');
    return rows[0];
  }

  private async maybeCreateEntry(signal: Record<string, any>, setupId: string): Promise<void> {
    if (String(signal.state).toUpperCase() !== 'ACTIVE' || signal.lifecycle?.entry_allowed !== true) return;
    const generatedAt = Number(signal.generated_at || 0);
    if (!generatedAt || Date.now() / 1000 - generatedAt > 20) return;
    const { side, setup, option } = this.optionFor(signal);
    const expiry = this.normalizeExpiry(option.expiry);
    if (option.eligible !== true || !Number(option.bid) || !Number(option.ask) || Number(option.quote_age_seconds) > 15
      || !expiry || !option.local_symbol || !Number(option.strike)) return;
    const account = await this.account();
    if (account.automation_status !== 'ACTIVE') return;
    const existing = await (this.fastify as any).pg.query(
      'SELECT id FROM paper_trade_decisions WHERE account_id = $1 AND setup_id = $2', [ACCOUNT_ID, setupId]
    );
    if (existing.rows.length > 0) return;
    const openCount = await (this.fastify as any).pg.query(
      `SELECT
         (SELECT COUNT(*) FROM positions WHERE paper_account_id=$1 AND status='OPEN')
         + (SELECT COUNT(*) FROM paper_orders WHERE account_id=$1 AND intent='ENTRY' AND status='PENDING') AS count`,
      [ACCOUNT_ID]
    );
    if (Number(openCount.rows[0]?.count || 0) >= 1) return;
    const today = ET_DATE.format(new Date());
    const tradeCount = await (this.fastify as any).pg.query(
      `SELECT COUNT(*)::int AS count FROM paper_orders
       WHERE account_id = $1 AND intent = 'ENTRY' AND status = 'FILLED'
         AND (filled_at AT TIME ZONE 'America/New_York')::date = $2::date`, [ACCOUNT_ID, today]
    );
    if (Number(tradeCount.rows[0]?.count || 0) >= 2) return;
    const dayLoss = Number(account.equity) - Number(account.start_of_day_equity);
    if (dayLoss <= -Math.abs(Number(account.start_of_day_equity) * 0.01)) return;

    const bid = Number(option.bid);
    const ask = Number(option.ask);
    const mid = Number(option.mid || (bid + ask) / 2);
    const protectedLimit = Number(Math.min(ask, mid + (ask - mid) * 0.20).toFixed(2));
    const fallback: PaperDecision = {
      decision: 'TRADE', riskTier: 'CAUTIOUS', exitProfile: 'BALANCED_T2', source: 'FALLBACK',
      rationale: 'AI was unavailable; conservative one-contract fallback applied.', riskFlags: ['AI sizing unavailable']
    };
    let bounded = fallback;
    try {
      const prompt = `Choose a bounded paper-trade risk tier and exit profile. Never invent prices, contracts, stops, or targets.
Allowed risk_tier: CAUTIOUS, STANDARD, FULL. Allowed exit_profile: CONSERVATIVE_T1, BALANCED_T2. You may SKIP.
${JSON.stringify({ strategy: signal.strategy, side, confidence: signal.confidence_score, confirmations: signal.confirmations || [], blockers: signal.blockers || [], gex: signal.gex || {}, zeroGex: signal.zerogex_decision || {}, spot: signal.spot, trigger: setup.trigger, invalidation: setup.invalidation, targets: setup.targets, option: { ticker: option.local_symbol, bid, ask, spreadPct: option.spread_pct, delta: option.delta, volume: option.volume }, account: { equity: Number(account.equity), cash: Number(account.cash_balance), reserved: Number(account.reserved_cash) } })}
Respond only JSON: {"decision":"TRADE|SKIP","risk_tier":"CAUTIOUS|STANDARD|FULL","exit_profile":"CONSERVATIVE_T1|BALANCED_T2","rationale":"short","risk_flags":[]}`;
      const raw = await Promise.race([
        new AIService(this.fastify).askTradingJSON(prompt, undefined, 250),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI decision timeout')), 4000))
      ]);
      bounded = PaperTradingService.normalizeAIDecision(raw) || fallback;
    } catch {
      bounded = fallback;
    }
    const sizing = PaperTradingService.quantityForBudget(
      Number(account.equity), Number(account.cash_balance) - Number(account.reserved_cash), protectedLimit, bounded.riskTier
    );
    let quantity = bounded.source === 'FALLBACK' ? Math.min(1, sizing.maxQuantity) : sizing.quantity;
    if (bounded.decision === 'SKIP') quantity = 0;
    const settings = await getGlobalSettings((this.fastify as any).pg);
    const signalRow = await (this.fastify as any).pg.query(
      `SELECT id FROM signals WHERE strategy_setup_id = $1 ORDER BY created_at DESC LIMIT 1`, [setupId]
    );
    const decisionInsert = await (this.fastify as any).pg.query(
      `INSERT INTO paper_trade_decisions (
         account_id, setup_id, signal_id, decision, risk_tier, exit_profile, source,
         quantity, max_quantity, debit_budget, protected_limit, model, prompt_version,
         rationale, risk_flags, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (account_id, setup_id) DO NOTHING RETURNING *`,
      [ACCOUNT_ID, setupId, signalRow.rows[0]?.id || null, bounded.decision, bounded.riskTier, bounded.exitProfile,
        bounded.source, quantity, sizing.maxQuantity, sizing.debitBudget, protectedLimit,
        settings.day_trading_ai_model || settings.ai_model || null, PROMPT_VERSION, bounded.rationale,
        JSON.stringify(bounded.riskFlags), JSON.stringify({ generatedAt, quoteAgeSeconds: option.quote_age_seconds, bid, ask, mid, strategyState: signal.state })]
    );
    const decisionRow = decisionInsert.rows[0];
    if (!decisionRow || quantity < 1 || bounded.decision === 'SKIP') return;
    const reservedDebit = Number((protectedLimit * quantity * 100).toFixed(2));
    const client = await (this.fastify as any).pg.connect();
    let orderCreated = false;
    try {
      await client.query('BEGIN');
      const lockedAccount = await client.query(
        `SELECT cash_balance, reserved_cash, automation_status FROM paper_accounts WHERE id=$1 FOR UPDATE`, [ACCOUNT_ID]
      );
      const available = Number(lockedAccount.rows[0]?.cash_balance || 0) - Number(lockedAccount.rows[0]?.reserved_cash || 0);
      if (lockedAccount.rows[0]?.automation_status !== 'ACTIVE' || available < reservedDebit) {
        await client.query('ROLLBACK');
        return;
      }
      const order = await client.query(
        `INSERT INTO paper_orders (
           account_id, decision_id, setup_id, signal_id, intent, action, status, osi_ticker,
           option_type, strike, expiration, quantity, limit_price, reserved_debit, quote_snapshot, expires_at
         ) VALUES ($1,$2,$3,$4,'ENTRY','BUY_TO_OPEN','PENDING',$5,$6,$7,$8,$9,$10,$11,$12,NOW() + INTERVAL '60 seconds')
         ON CONFLICT (account_id, setup_id, intent) DO NOTHING RETURNING id`,
        [ACCOUNT_ID, decisionRow.id, setupId, decisionRow.signal_id, option.local_symbol, side, Number(option.strike), expiry,
          quantity, protectedLimit, reservedDebit, JSON.stringify({ bid, ask, mid, quoteAgeSeconds: option.quote_age_seconds })]
      );
      orderCreated = Boolean(order.rows[0]);
      if (orderCreated) {
        await client.query(
          `UPDATE paper_accounts SET reserved_cash=reserved_cash+$1, updated_at=NOW() WHERE id=$2`,
          [reservedDebit, ACCOUNT_ID]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (orderCreated) {
      await this.processPendingEntry(signal, setupId);
    }
  }

  private async processPendingEntry(signal: Record<string, any>, setupId: string): Promise<void> {
    const { side, setup, option } = this.optionFor(signal);
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT po.*, ptd.exit_profile FROM paper_orders po
       JOIN paper_trade_decisions ptd ON ptd.id = po.decision_id
       WHERE po.account_id = $1 AND po.setup_id = $2 AND po.intent = 'ENTRY' AND po.status = 'PENDING'`, [ACCOUNT_ID, setupId]
    );
    const order = rows[0];
    if (!order) return;
    const account = await this.account();
    if (account.automation_status !== 'ACTIVE') {
      await this.cancelPendingOrder(order, 'Paper automation is paused');
      return;
    }
    if (side !== order.option_type || this.canonicalTicker(option.local_symbol) !== this.canonicalTicker(order.osi_ticker)) {
      await this.cancelPendingOrder(order, 'Planned option contract changed before fill');
      return;
    }
    const expired = new Date(order.expires_at).getTime() <= Date.now();
    const active = String(signal.state).toUpperCase() === 'ACTIVE' && signal.lifecycle?.entry_allowed === true;
    if (expired || !active) {
      await this.cancelPendingOrder(order, expired ? 'Protected entry limit expired after 60 seconds' : 'Strategy entry window closed');
      return;
    }
    const ask = Number(option.ask || 0);
    if (!ask || Number(option.quote_age_seconds) > 15 || ask > Number(order.limit_price) + 0.0001) return;
    const fillPrice = Number(ask.toFixed(2));
    const debit = Number((fillPrice * Number(order.quantity) * 100).toFixed(2));
    const targets = Array.isArray(setup.targets) ? setup.targets : [];
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      const lockedAccount = await client.query(
        `SELECT automation_status FROM paper_accounts WHERE id=$1 FOR UPDATE`, [ACCOUNT_ID]
      );
      if (lockedAccount.rows[0]?.automation_status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        await this.cancelPendingOrder(order, 'Paper automation is paused');
        return;
      }
      const lockedOrder = await client.query(
        `SELECT status FROM paper_orders WHERE id=$1 FOR UPDATE`, [order.id]
      );
      if (lockedOrder.rows[0]?.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return;
      }
      const positionResult = await client.query(
        `INSERT INTO positions (
           user_id, symbol, option_type, strike_price, expiration_date, entry_price, quantity,
           stop_loss_trigger, current_price, status, is_simulated, account_id, execution_broker,
           execution_status, contracts_requested, entry_action, exit_action, suggested_stop_loss,
           suggested_take_profit_1, suggested_take_profit_2, signal_id, strategy_setup_id,
           strategy_engine_version, strategy_lifecycle_status, strategy_snapshot, strategy_managed,
           paper_account_id, paper_decision_id, analysis_data, notes
         ) VALUES (NULL,'SPY',$1,$2,$3,$4,$5,$6,$7,'OPEN',TRUE,$8,'system_paper','FILLED',$5,
                   'BUY_TO_OPEN','SELL_TO_CLOSE',$9,$10,$11,$12,$13,'signal-only-v2','ACTIVE',$14,TRUE,$8,$15,$16,$17)
         RETURNING *`,
        [side, Number(order.strike), order.expiration, fillPrice, Number(order.quantity), Number((fillPrice * 0.8).toFixed(2)), Number(option.bid || fillPrice),
          ACCOUNT_ID, setup.invalidation || null, targets[0] || null, targets[1] || targets[0] || null,
          order.signal_id, setupId, JSON.stringify(signal), order.decision_id,
          JSON.stringify({ exitProfile: order.exit_profile, originalQuantity: Number(order.quantity), t1Reached: false }),
          `[System paper entry from setup ${setupId}]`]
      );
      await client.query(
        `UPDATE paper_orders SET status='FILLED', fill_price=$1, position_id=$2, filled_at=NOW(), updated_at=NOW() WHERE id=$3`,
        [fillPrice, positionResult.rows[0].id, order.id]
      );
      await client.query(
        `UPDATE paper_accounts SET cash_balance = cash_balance - $1,
           reserved_cash = GREATEST(0, reserved_cash - $2), updated_at=NOW() WHERE id=$3`,
        [debit, Number(order.reserved_debit), ACCOUNT_ID]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.refreshAccountEquity();
    await this.captureEquity(true);
  }

  private async cancelPendingOrder(order: any, reason: string): Promise<void> {
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE`, [ACCOUNT_ID]);
      const cancelled = await client.query(
        `UPDATE paper_orders SET status='EXPIRED', failure_reason=$1, updated_at=NOW()
         WHERE id=$2 AND status='PENDING' RETURNING reserved_debit`,
        [reason, order.id]
      );
      if (cancelled.rows[0]) {
        await client.query(
          `UPDATE paper_accounts SET reserved_cash=GREATEST(0,reserved_cash-$1), updated_at=NOW() WHERE id=$2`,
          [Number(cancelled.rows[0].reserved_debit), ACCOUNT_ID]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshOpenPositions(signal: Record<string, any>, setupId: string): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT p.*, ptd.exit_profile FROM positions p
       JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
       WHERE p.paper_account_id=$1 AND p.status='OPEN'`, [ACCOUNT_ID]
    );
    for (const position of rows) {
      const isCall = position.option_type === 'CALL';
      const setup = isCall ? signal.call_setup || {} : signal.put_setup || {};
      const option = setup.option || {};
      const sameSetup = String(position.strategy_setup_id) === setupId;
      const storedSnapshot = typeof position.strategy_snapshot === 'string'
        ? JSON.parse(position.strategy_snapshot)
        : position.strategy_snapshot || {};
      const currentTerminal = sameSetup
        && ['COMPLETED', 'FAILED', 'INVALIDATED', 'TRACKING_ABORTED'].includes(String(signal.lifecycle?.status || signal.state).toUpperCase());
      const storedTerminal = ['COMPLETED', 'FAILED', 'INVALIDATED', 'TRACKING_ABORTED'].includes(
        String(storedSnapshot.lifecycle?.status || storedSnapshot.state).toUpperCase()
      );
      const flattenDue = this.mandatoryFlattenDue();
      if (!sameSetup && !storedTerminal && !flattenDue) continue;
      let bid = sameSetup
        && this.canonicalTicker(option.local_symbol) === this.canonicalTicker(this.osiTicker(position))
        && Number(option.quote_age_seconds) <= 15
        ? Number(option.bid || 0)
        : 0;
      if (!bid && (currentTerminal || storedTerminal || flattenDue)) {
        const quote = await (this.fastify as any).ibkrMarketData.getOptionQuoteForOsi(null, this.osiTicker(position));
        bid = Number(quote?.bid || 0);
      }
      const spot = sameSetup ? Number(signal.spot || 0) : Number(position.underlying_price || 0);
      if (!bid) continue;
      const analysis = typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data || {};
      const t1 = Number(position.suggested_take_profit_1 || 0);
      const t2 = Number(position.suggested_take_profit_2 || t1 || 0);
      const stop = Number(position.suggested_stop_loss || 0);
      const invalidated = stop > 0 && (isCall ? spot <= stop : spot >= stop);
      const emergency = bid <= Number(position.entry_price) * 0.65;
      const terminal = currentTerminal || storedTerminal;
      const hitT1 = sameSetup && t1 > 0 && (isCall ? spot >= t1 : spot <= t1);
      const hitT2 = sameSetup && t2 > 0 && (isCall ? spot >= t2 : spot <= t2);
      await (this.fastify as any).pg.query(
        `UPDATE positions SET current_price=$1, underlying_price=$2, strategy_snapshot=$3, updated_at=NOW() WHERE id=$4`,
        [bid, spot || null, JSON.stringify(signal), position.id]
      );
      if (invalidated || emergency || terminal) {
        await this.closePaperQuantity(position, Number(position.quantity), bid, invalidated ? 'INVALIDATION' : emergency ? 'EMERGENCY_PREMIUM_STOP' : 'STRATEGY_TERMINAL');
        continue;
      }
      if (position.exit_profile === 'CONSERVATIVE_T1' && hitT1) {
        await this.closePaperQuantity(position, Number(position.quantity), bid, 'TARGET_1');
        continue;
      }
      if (position.exit_profile === 'BALANCED_T2') {
        if (hitT1 && !analysis.t1Reached) {
          const original = Number(analysis.originalQuantity || position.contracts_requested || position.quantity);
          const trim = original >= 2 ? Math.min(Number(position.quantity), Math.ceil(original / 2)) : 0;
          analysis.t1Reached = true;
          analysis.t1ReachedAt = new Date().toISOString();
          const currentSetup = isCall ? signal.call_setup : signal.put_setup;
          const storedSetup = isCall ? storedSnapshot.call_setup : storedSnapshot.put_setup;
          await (this.fastify as any).pg.query(
            `UPDATE positions SET suggested_stop_loss=$1, analysis_data=$2, updated_at=NOW() WHERE id=$3`,
            [Number(currentSetup?.trigger || storedSetup?.trigger || stop), JSON.stringify(analysis), position.id]
          );
          if (trim > 0) await this.closePaperQuantity(position, trim, bid, 'TARGET_1_TRIM');
        }
        if (hitT2) {
          const current = await (this.fastify as any).pg.query('SELECT * FROM positions WHERE id=$1', [position.id]);
          if (current.rows[0]?.status === 'OPEN') await this.closePaperQuantity(current.rows[0], Number(current.rows[0].quantity), bid, 'TARGET_2');
        }
      }
      if (flattenDue) {
        const current = await (this.fastify as any).pg.query('SELECT * FROM positions WHERE id=$1', [position.id]);
        if (current.rows[0]?.status === 'OPEN') await this.closePaperQuantity(current.rows[0], Number(current.rows[0].quantity), bid, 'END_OF_DAY');
      }
    }
  }

  private async closePaperQuantity(position: any, quantity: number, bid: number, intent: string): Promise<void> {
    const closeQty = Math.max(1, Math.min(Number(position.quantity), Math.floor(quantity)));
    const proceeds = Number((bid * closeQty * 100).toFixed(2));
    const pnl = Number(((bid - Number(position.entry_price)) * closeQty * 100).toFixed(2));
    const remaining = Number(position.quantity) - closeQty;
    const setupId = String(position.strategy_setup_id);
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO paper_orders (
           account_id, decision_id, position_id, setup_id, signal_id, intent, action, status,
           osi_ticker, option_type, strike, expiration, quantity, fill_price, quote_snapshot, filled_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'SELL_TO_CLOSE','FILLED',$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (account_id, setup_id, intent) DO NOTHING RETURNING id`,
        [ACCOUNT_ID, position.paper_decision_id, position.id, setupId, position.signal_id, intent,
          this.osiTicker(position), position.option_type, Number(position.strike_price), this.normalizeExpiry(position.expiration_date), closeQty, bid,
          JSON.stringify({ bid, underlyingPrice: position.underlying_price })]
      );
      if (!inserted.rows[0]) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `UPDATE positions SET quantity=$1, status=$2, current_price=$3,
           realized_pnl=COALESCE(realized_pnl,0)+$4, exit_price=CASE WHEN $2='CLOSED' THEN $3 ELSE exit_price END,
           execution_status=CASE WHEN $2='CLOSED' THEN 'EXIT_FILLED' ELSE 'PARTIAL_EXIT_FILLED' END,
           exit_reason=$5, updated_at=NOW() WHERE id=$6`,
        [remaining, remaining === 0 ? 'CLOSED' : 'OPEN', bid, pnl, intent, position.id]
      );
      await client.query(`UPDATE paper_accounts SET cash_balance=cash_balance+$1, updated_at=NOW() WHERE id=$2`, [proceeds, ACCOUNT_ID]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.refreshAccountEquity();
    await this.captureEquity(true);
  }

  private async refreshAccountEquity(): Promise<void> {
    await (this.fastify as any).pg.query(
      `UPDATE paper_accounts pa SET
         equity = pa.cash_balance + COALESCE((SELECT SUM(current_price * quantity * 100) FROM positions WHERE paper_account_id=pa.id AND status='OPEN'),0),
         high_water_mark = GREATEST(pa.high_water_mark, pa.cash_balance + COALESCE((SELECT SUM(current_price * quantity * 100) FROM positions WHERE paper_account_id=pa.id AND status='OPEN'),0)),
         updated_at=NOW()
       WHERE pa.id=$1`, [ACCOUNT_ID]
    );
  }

  private async captureEquity(force: boolean): Promise<void> {
    const last = await (this.fastify as any).pg.query(
      `SELECT captured_at FROM paper_equity_snapshots WHERE account_id=$1 ORDER BY captured_at DESC LIMIT 1`, [ACCOUNT_ID]
    );
    if (!force && last.rows[0] && Date.now() - new Date(last.rows[0].captured_at).getTime() < 60_000) return;
    const account = await this.account();
    const pnl = await (this.fastify as any).pg.query(
      `SELECT COALESCE(SUM(realized_pnl),0) AS realized,
              COALESCE(SUM(CASE WHEN status='OPEN' THEN (current_price-entry_price)*quantity*100 ELSE 0 END),0) AS unrealized
       FROM positions WHERE paper_account_id=$1`, [ACCOUNT_ID]
    );
    await (this.fastify as any).pg.query(
      `INSERT INTO paper_equity_snapshots (account_id,equity,cash_balance,reserved_cash,realized_pnl,unrealized_pnl)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ACCOUNT_ID, account.equity, account.cash_balance, account.reserved_cash, pnl.rows[0].realized, pnl.rows[0].unrealized]
    );
  }

  private async rollSessionIfNeeded(): Promise<void> {
    const today = ET_DATE.format(new Date());
    await this.refreshAccountEquity();
    await (this.fastify as any).pg.query(
      `UPDATE paper_accounts SET start_of_day_date=$1::date, start_of_day_equity=equity, updated_at=NOW()
       WHERE id=$2 AND start_of_day_date<>$1::date`, [today, ACCOUNT_ID]
    );
  }

  public async ensurePriorMonthReport(): Promise<void> {
    const now = new Date();
    const etDate = ET_DATE.format(now);
    const [year, month] = etDate.split('-').map(Number);
    const previous = new Date(Date.UTC(year, month - 2, 1));
    const reportMonth = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
    const account = await this.account();
    const createdMonth = ET_DATE.format(new Date(account.created_at)).slice(0, 7);
    if (reportMonth < createdMonth) return;
    await this.generateMonthlyReport(reportMonth);
  }

  public async generateMonthlyReport(month: string): Promise<any> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must use YYYY-MM');
    if (month >= ET_DATE.format(new Date()).slice(0, 7)) {
      const error: any = new Error('Monthly reports are available only after a month closes');
      error.statusCode = 400;
      throw error;
    }
    const existing = await (this.fastify as any).pg.query(
      `SELECT * FROM paper_monthly_reports WHERE account_id=$1 AND month=$2`, [ACCOUNT_ID, month]
    );
    if (existing.rows[0]) return existing.rows[0];
    const start = `${month}-01`;
    const [year, monthNumber] = month.split('-').map(Number);
    const next = `${monthNumber === 12 ? year + 1 : year}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, '0')}-01`;
    const { rows: trades } = await (this.fastify as any).pg.query(
      `SELECT p.*, ptd.source AS ai_source, ptd.risk_tier, ptd.exit_profile
       FROM positions p JOIN paper_trade_decisions ptd ON ptd.id=p.paper_decision_id
       WHERE p.paper_account_id=$1 AND p.created_at >= $2::date AND p.created_at < $3::date`, [ACCOUNT_ID, start, next]
    );
    const closed = trades.filter((trade: any) => trade.status === 'CLOSED');
    const wins = closed.filter((trade: any) => Number(trade.realized_pnl) > 0);
    const gains = wins.reduce((sum: number, trade: any) => sum + Number(trade.realized_pnl || 0), 0);
    const losses = Math.abs(closed.filter((trade: any) => Number(trade.realized_pnl) <= 0).reduce((sum: number, trade: any) => sum + Number(trade.realized_pnl || 0), 0));
    const snapshots = await (this.fastify as any).pg.query(
      `SELECT equity, captured_at FROM paper_equity_snapshots WHERE account_id=$1 AND captured_at >= $2::date AND captured_at < $3::date ORDER BY captured_at`, [ACCOUNT_ID, start, next]
    );
    const priorSnapshot = await (this.fastify as any).pg.query(
      `SELECT equity FROM paper_equity_snapshots WHERE account_id=$1 AND captured_at < $2::date ORDER BY captured_at DESC LIMIT 1`,
      [ACCOUNT_ID, start]
    );
    const account = await this.account();
    const openingEquity = Number(priorSnapshot.rows[0]?.equity || snapshots.rows[0]?.equity || account.initial_equity);
    const closingEquity = Number(snapshots.rows.at(-1)?.equity || openingEquity);
    let peak = openingEquity;
    let maxDrawdown = 0;
    for (const row of snapshots.rows) {
      const equity = Number(row.equity);
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
    }
    const orderStats = await (this.fastify as any).pg.query(
      `SELECT COUNT(*) FILTER (WHERE intent='ENTRY')::int AS attempts,
              COUNT(*) FILTER (WHERE intent='ENTRY' AND status='FILLED')::int AS fills,
              COALESCE(AVG(CASE WHEN intent='ENTRY' AND status='FILLED' THEN fill_price-limit_price END),0) AS avg_slippage
       FROM paper_orders WHERE account_id=$1 AND created_at >= $2::date AND created_at < $3::date`, [ACCOUNT_ID, start, next]
    );
    const report = {
      month, openingEquity, closingEquity,
      returnPct: openingEquity > 0 ? Number((((closingEquity - openingEquity) / openingEquity) * 100).toFixed(2)) : 0,
      realizedPnl: Number(closed.reduce((sum: number, trade: any) => sum + Number(trade.realized_pnl || 0), 0).toFixed(2)),
      trades: trades.length, closedTrades: closed.length, wins: wins.length,
      winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
      profitFactor: losses > 0 ? Number((gains / losses).toFixed(2)) : gains > 0 ? 99.99 : 0,
      expectancy: closed.length ? Number(((gains - losses) / closed.length).toFixed(2)) : 0,
      maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
      fillRate: Number(orderStats.rows[0]?.attempts || 0) ? Number(((Number(orderStats.rows[0].fills) / Number(orderStats.rows[0].attempts)) * 100).toFixed(2)) : 0,
      averageEntryLimitDifference: Number(orderStats.rows[0]?.avg_slippage || 0),
      aiTrades: trades.filter((trade: any) => trade.ai_source === 'AI').length,
      fallbackTrades: trades.filter((trade: any) => trade.ai_source === 'FALLBACK').length
    };
    const inserted = await (this.fastify as any).pg.query(
      `INSERT INTO paper_monthly_reports (account_id,month,report) VALUES ($1,$2,$3)
       ON CONFLICT (account_id,month) DO NOTHING RETURNING *`, [ACCOUNT_ID, month, JSON.stringify(report)]
    );
    if (inserted.rows[0]) await this.sendMonthlyDiscord(inserted.rows[0]);
    return inserted.rows[0] || (await (this.fastify as any).pg.query('SELECT * FROM paper_monthly_reports WHERE account_id=$1 AND month=$2', [ACCOUNT_ID, month])).rows[0];
  }

  private async sendMonthlyDiscord(row: any): Promise<void> {
    const admin = await (this.fastify as any).pg.query(`SELECT id FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1`);
    if (!admin.rows[0]) return;
    const report = row.report;
    const sent = await new DiscordAlertService(this.fastify).send({
      userId: Number(admin.rows[0].id), title: `Paper account month-end — ${row.month}`,
      message: `Closing equity $${Number(report.closingEquity).toFixed(2)} · Return ${Number(report.returnPct).toFixed(2)}% · P&L $${Number(report.realizedPnl).toFixed(2)} · ${report.closedTrades} closed trades · Win rate ${Number(report.winRate).toFixed(1)}% · Max drawdown ${Number(report.maxDrawdownPct).toFixed(2)}%`,
      category: 'paper-monthly-report', dedupeKey: `paper-monthly:${row.month}`, dedupeSeconds: 40 * 24 * 60 * 60
    });
    if (sent) await (this.fastify as any).pg.query('UPDATE paper_monthly_reports SET discord_sent_at=NOW() WHERE id=$1', [row.id]);
  }

  private mandatoryFlattenDue(): boolean {
    const [hour, minute] = ET_TIME.format(new Date()).split(':').map(Number);
    return hour * 60 + minute >= 15 * 60 + 55;
  }

  private normalizeExpiry(value: any): string | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    const raw = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return null;
  }

  private osiTicker(position: any): string {
    const expiry = this.normalizeExpiry(position.expiration_date) || '1970-01-01';
    const [year, month, day] = expiry.split('-');
    return `SPY${year.slice(-2)}${month}${day}${position.option_type === 'PUT' ? 'P' : 'C'}${Math.round(Number(position.strike_price) * 1000).toString().padStart(8, '0')}`;
  }

  private canonicalTicker(value: any): string {
    return String(value || '').replace(/\s+/g, '').toUpperCase();
  }
}
