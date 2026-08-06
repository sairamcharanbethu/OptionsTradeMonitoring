import { FastifyInstance } from 'fastify';
import { AIService } from './ai-service';
import { DiscordAlertService } from './discord-alert-service';
import { getGlobalSettings } from '../lib/settings-utils';
import { redis as defaultRedis } from '../lib/redis';
import { getNewYorkMarketState, getUSMarketCloseMinutes } from '../lib/market-calendar';

const ACCOUNT_ID = 'strategy-system';
const PROMPT_VERSION = 'paper-risk-v2';
export const PAPER_POLICY_VERSION = 'paper-exit-v2';
const MAX_DAILY_AI_CALLS = 3;
const DEFAULT_PAPER_TRAILING_STOP_PCT = 15;
const MAX_MANUAL_EXIT_QUOTE_AGE_MS = 15_000;
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
  source: 'AI' | 'RULES' | 'FALLBACK';
  rationale: string;
  riskFlags: string[];
};

export class PaperTradingService {
  private queuedSnapshots = new Map<string, { signal: Record<string, any>; setupId: string }>();
  private snapshotProcessing: Promise<void> | null = null;
  private monthlyTimer: NodeJS.Timeout | null = null;
  private exitRecoveryTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private lastProcessedAt: string | null = null;

  constructor(private fastify: FastifyInstance, private redisClient: any = defaultRedis) {}

  public start(): void {
    if (this.monthlyTimer) return;
    this.monthlyTimer = setInterval(() => {
      this.ensurePriorMonthReport().catch((error: any) => {
        this.lastError = error.message || String(error);
        this.fastify.log.warn(`[PaperTrading] Monthly report check failed: ${this.lastError}`);
      });
    }, 60 * 60 * 1000);
    this.exitRecoveryTimer = setInterval(() => {
      this.recoverOverdueOpenPositions().catch((error: any) => {
        this.lastError = error.message || String(error);
        this.fastify.log.warn(`[PaperTrading] Scheduled exit recovery failed: ${this.lastError}`);
      });
    }, 60 * 1000);
    this.ensurePriorMonthReport().catch((error: any) => {
      this.fastify.log.warn(`[PaperTrading] Initial monthly report check failed: ${error.message || String(error)}`);
    });
    this.recover().catch((error: any) => {
      this.lastError = error.message || String(error);
      this.fastify.log.warn(`[PaperTrading] Recovery failed: ${this.lastError}`);
    });
  }

  public stop(): void {
    if (this.monthlyTimer) clearInterval(this.monthlyTimer);
    if (this.exitRecoveryTimer) clearInterval(this.exitRecoveryTimer);
    this.monthlyTimer = null;
    this.exitRecoveryTimer = null;
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
    const settings = await getGlobalSettings((this.fastify as any).pg);
    const [positions, recentPositions, decisions, orders, reports, today, aiUsage, journal, baseline] = await Promise.all([
      (this.fastify as any).pg.query(
        `SELECT p.*, ptd.risk_tier, ptd.exit_profile, ptd.source AS decision_source,
                ptd.policy_version, ptd.trailing_stop_pct AS decision_trailing_stop_pct
         FROM positions p
         LEFT JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
         WHERE p.paper_account_id=$1 AND p.status='OPEN'
         ORDER BY p.created_at DESC`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT p.*,
                ptd.decision AS paper_decision, ptd.risk_tier, ptd.exit_profile,
                ptd.source AS decision_source, ptd.policy_version,
                ptd.trailing_stop_pct AS decision_trailing_stop_pct,
                ptd.rationale AS decision_rationale, ptd.risk_flags AS decision_risk_flags,
                ptd.evidence AS decision_evidence, ptd.ai_requested,
                pbt.realized_pnl AS baseline_realized_pnl,
                pbt.exit_reason AS baseline_exit_reason
         FROM positions p
         LEFT JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
         LEFT JOIN paper_baseline_trades pbt
           ON pbt.account_id=$1 AND pbt.position_id=p.id
         WHERE p.paper_account_id=$1
         ORDER BY p.updated_at DESC, p.id DESC
         LIMIT 50`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_trade_decisions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 10`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_monthly_reports WHERE account_id=$1 ORDER BY month DESC LIMIT 12`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT COUNT(*) FILTER (WHERE intent='ENTRY' AND status='FILLED')::int AS entries
         FROM paper_orders
         WHERE account_id=$1 AND (created_at AT TIME ZONE 'America/New_York')::date=$2::date`,
        [ACCOUNT_ID, ET_DATE.format(new Date())]
      ),
      (this.fastify as any).pg.query(
        `SELECT
           COUNT(*) FILTER (WHERE ai_requested AND (created_at AT TIME ZONE 'America/New_York')::date=$2::date)::int AS daily_calls,
           COALESCE(SUM(total_tokens) FILTER (WHERE (created_at AT TIME ZONE 'America/New_York')::date=$2::date),0)::int AS daily_tokens,
           COUNT(*) FILTER (WHERE ai_requested AND date_trunc('month', created_at AT TIME ZONE 'America/New_York')=date_trunc('month', NOW() AT TIME ZONE 'America/New_York'))::int AS monthly_calls,
           COALESCE(SUM(total_tokens) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'America/New_York')=date_trunc('month', NOW() AT TIME ZONE 'America/New_York')),0)::int AS monthly_tokens
         FROM paper_trade_decisions WHERE account_id=$1`,
        [ACCOUNT_ID, ET_DATE.format(new Date())]
      ),
      (this.fastify as any).pg.query(
        `SELECT * FROM paper_trade_journal WHERE account_id=$1 ORDER BY created_at DESC LIMIT 250`, [ACCOUNT_ID]
      ),
      (this.fastify as any).pg.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='CLOSED')::int AS closed_trades,
           COUNT(*) FILTER (WHERE status='CLOSED' AND realized_pnl > 0)::int AS wins,
           COUNT(*) FILTER (WHERE status='OPEN')::int AS open_trades,
           COALESCE(SUM(realized_pnl) FILTER (WHERE status='CLOSED'),0) AS realized_pnl,
           (SELECT COALESCE(SUM(p.realized_pnl),0)
              FROM positions p JOIN paper_baseline_trades paired ON paired.position_id=p.id
             WHERE paired.account_id=$1 AND paired.status='CLOSED') AS managed_realized_pnl
         FROM paper_baseline_trades WHERE account_id=$1`, [ACCOUNT_ID]
      )
    ]);
    const openPositions = await this.applyLivePositions(positions.rows);
    const openById = new Map(openPositions.map((position: any) => [Number(position.id), position]));
    const recentTradePositions = recentPositions.rows.map((position: any) => ({
      ...position,
      ...(openById.get(Number(position.id)) || {})
    }));
    const equity = this.calculateEquity(account, openPositions);
    const startOfDayEquity = Number(account.start_of_day_equity);
    return {
      account: {
        ...account,
        equity,
        high_water_mark: Math.max(Number(account.high_water_mark || 0), equity)
      },
      openPositions,
      recentPositions: recentTradePositions,
      recentDecisions: decisions.rows,
      recentOrders: orders.rows,
      monthlyReports: reports.rows,
      journal: journal.rows,
      limits: {
        maxDebitPct: null,
        dailyLossPct: null,
        maxTradesPerDay: null,
        maxOpenPositions: null,
        maxContracts: null,
        trailingStopPct: this.trailingStopPct(settings),
        policyVersion: PAPER_POLICY_VERSION
      },
      session: {
        entries: Number(today.rows[0]?.entries || 0),
        entriesRemaining: null,
        pnl: Number((equity - startOfDayEquity).toFixed(2)),
        pnlPct: startOfDayEquity > 0 ? Number((((equity - startOfDayEquity) / startOfDayEquity) * 100).toFixed(2)) : 0
      },
      aiUsage: {
        dailyCalls: Number(aiUsage.rows[0]?.daily_calls || 0),
        dailyCallLimit: MAX_DAILY_AI_CALLS,
        dailyCallsRemaining: Math.max(0, MAX_DAILY_AI_CALLS - Number(aiUsage.rows[0]?.daily_calls || 0)),
        dailyTokens: Number(aiUsage.rows[0]?.daily_tokens || 0),
        monthlyCalls: Number(aiUsage.rows[0]?.monthly_calls || 0),
        monthlyTokens: Number(aiUsage.rows[0]?.monthly_tokens || 0)
      },
      baseline: {
        name: 'One contract · no AI sizing',
        closedTrades: Number(baseline.rows[0]?.closed_trades || 0),
        openTrades: Number(baseline.rows[0]?.open_trades || 0),
        wins: Number(baseline.rows[0]?.wins || 0),
        winRate: Number(baseline.rows[0]?.closed_trades || 0) > 0
          ? Number((Number(baseline.rows[0].wins) / Number(baseline.rows[0].closed_trades) * 100).toFixed(2)) : 0,
        realizedPnl: Number(baseline.rows[0]?.realized_pnl || 0),
        managedRealizedPnl: Number(baseline.rows[0]?.managed_realized_pnl || 0),
        valueAdded: Number((Number(baseline.rows[0]?.managed_realized_pnl || 0) - Number(baseline.rows[0]?.realized_pnl || 0)).toFixed(2))
      },
      health: this.getHealth()
    };
  }

  private async applyLivePositions(positions: any[]): Promise<any[]> {
    return Promise.all(positions.map(async (position: any) => {
      const live = await this.getLivePosition(position.id);
      if (!live) return position;
      return {
        ...position,
        current_price: live.currentPrice,
        underlying_price: live.underlyingPrice,
        trailing_high_price: live.trailingHighPrice,
        trailing_stop_loss_pct: live.trailingStopPct,
        suggested_stop_loss: live.suggestedStopLoss,
        analysis_data: live.analysis,
        updated_at: live.updatedAt
      };
    }));
  }

  private calculateEquity(account: any, openPositions: any[]): number {
    return Number((Number(account.cash_balance) + openPositions.reduce(
      (total: number, position: any) => total + Number(position.current_price || 0) * Number(position.quantity || 0) * 100,
      0
    )).toFixed(2));
  }

  public async getJournal(limit = 100, offset = 0): Promise<any[]> {
    const boundedLimit = Number.isFinite(limit) ? Math.min(250, Math.max(1, Math.floor(limit))) : 100;
    const boundedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT * FROM paper_trade_journal WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [ACCOUNT_ID, boundedLimit, boundedOffset]
    );
    return rows;
  }

  public async closeOpenPosition(
    positionId: number,
    requestedByUserId: number | null,
    force = false
  ): Promise<Record<string, any>> {
    if (!Number.isSafeInteger(positionId) || positionId <= 0) {
      const error: any = new Error('A valid paper position id is required');
      error.statusCode = 400;
      throw error;
    }
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT p.*, ptd.id AS resolved_paper_decision_id,
              ptd.setup_id AS resolved_strategy_setup_id,
              ptd.exit_profile, ptd.policy_version,
              ptd.trailing_stop_pct AS decision_trailing_stop_pct
       FROM positions p
       LEFT JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
       WHERE p.id=$1 AND p.paper_account_id=$2 AND p.status='OPEN'`,
      [positionId, ACCOUNT_ID]
    );
    const selectedPosition = rows[0];
    if (!selectedPosition) {
      const error: any = new Error('Open paper position not found');
      error.statusCode = 404;
      throw error;
    }
    const position = {
      ...selectedPosition,
      paper_decision_id: selectedPosition.resolved_paper_decision_id ?? null,
      strategy_setup_id: selectedPosition.resolved_strategy_setup_id ?? selectedPosition.strategy_setup_id
    };
    let live: any = null;
    try {
      live = await this.getLivePosition(position.id);
    } catch (error: any) {
      this.fastify.log.warn(`[PaperTrading] Redis mark unavailable for manual position ${positionId}: ${error.message || String(error)}`);
    }
    let quote: any = null;
    let quoteFailure: Error | null = null;
    try {
      quote = await (this.fastify as any).ibkrMarketData.getOptionQuoteForOsi(null, this.osiTicker(position));
    } catch (cause: any) {
      quoteFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
    const bid = Number(quote?.bid || 0);
    const quoteAgeMs = quote?.quoteAgeMs == null ? Number.NaN : Number(quote.quoteAgeMs);
    const hasFreshBid = bid > 0
      && Number.isFinite(quoteAgeMs)
      && quoteAgeMs >= 0
      && quoteAgeMs <= MAX_MANUAL_EXIT_QUOTE_AGE_MS;
    if (!hasFreshBid && !force) {
      if (quoteFailure) {
        const error: any = new Error(`Fresh IBKR exit quote is unavailable: ${quoteFailure.message}`);
        error.statusCode = 503;
        error.code = 'PAPER_FRESH_QUOTE_REQUIRED';
        throw error;
      }
      const error: any = new Error('Manual paper close requires an IBKR bid no older than 15 seconds');
      error.statusCode = 409;
      error.code = 'PAPER_FRESH_QUOTE_REQUIRED';
      throw error;
    }
    const redisMark = Number(live?.currentPrice);
    const storedMark = Number(position.current_price);
    const hasRedisMark = live?.currentPrice != null && live.currentPrice !== ''
      && Number.isFinite(redisMark) && redisMark >= 0;
    const hasStoredMark = position.current_price != null && position.current_price !== ''
      && Number.isFinite(storedMark) && storedMark >= 0;
    const fallbackPrice = hasRedisMark
      ? redisMark
      : hasStoredMark
        ? storedMark
        : Number.NaN;
    if (!hasFreshBid && !Number.isFinite(fallbackPrice)) {
      const error: any = new Error('Force close requires a valid last paper mark');
      error.statusCode = 409;
      throw error;
    }
    const intent = hasFreshBid ? 'MANUAL_EXIT' : 'MANUAL_FORCE_EXIT';
    const exitPrice = hasFreshBid ? bid : fallbackPrice;
    const priceSource = hasFreshBid
      ? 'IBKR_BID'
      : hasRedisMark
        ? 'REDIS_LAST_MARK'
        : 'DATABASE_LAST_MARK';
    const liveUpdatedAtMs = live?.updatedAt ? Date.parse(live.updatedAt) : Number.NaN;
    const effectiveQuoteAgeMs = hasFreshBid
      ? quoteAgeMs
      : Number.isFinite(liveUpdatedAtMs)
        ? Math.max(0, Date.now() - liveUpdatedAtMs)
        : null;
    const managedPosition = {
      ...position,
      current_price: exitPrice,
      underlying_price: live?.underlyingPrice ?? position.underlying_price,
      trailing_high_price: live?.trailingHighPrice ?? position.trailing_high_price,
      trailing_stop_loss_pct: live?.trailingStopPct ?? position.trailing_stop_loss_pct,
      suggested_stop_loss: live?.suggestedStopLoss ?? position.suggested_stop_loss,
      analysis_data: live?.analysis || position.analysis_data
    };
    let closeError: Error | null = null;
    try {
      await this.closePaperQuantity(managedPosition, Number(position.quantity), exitPrice, intent, {
        requestedByUserId,
        forced: !hasFreshBid,
        priceSource,
        quoteSource: hasFreshBid ? quote.source || 'ibkr' : null,
        quoteAgeMs: effectiveQuoteAgeMs,
        quoteTimestamp: hasFreshBid ? quote.timestamp || null : live?.updatedAt || null,
        freshQuoteFailure: !hasFreshBid ? (quoteFailure ? 'IBKR_UNAVAILABLE' : 'IBKR_BID_STALE_OR_MISSING') : null
      });
    } catch (error: any) {
      closeError = error instanceof Error ? error : new Error(String(error));
    }
    const closedResult = await (this.fastify as any).pg.query(
      `SELECT status, exit_reason, exit_price, realized_pnl
       FROM positions WHERE id=$1 AND paper_account_id=$2`,
      [positionId, ACCOUNT_ID]
    );
    const closed = closedResult.rows[0];
    if (closed?.status !== 'CLOSED' || closed?.exit_reason !== intent) {
      if (closeError) throw closeError;
      const error: any = new Error(
        closed?.status === 'CLOSED'
          ? `Paper position closed concurrently as ${closed.exit_reason || 'another exit'}`
          : 'Paper position did not close'
      );
      error.statusCode = 409;
      throw error;
    }
    if (closeError) {
      this.fastify.log.warn(`[PaperTrading] Manual position ${positionId} closed durably but runtime cleanup failed: ${closeError.message}`);
    }
    return {
      positionId,
      status: 'CLOSED',
      intent,
      quantity: Number(position.quantity),
      fillPrice: Number(closed.exit_price),
      realizedPnl: Number(closed.realized_pnl),
      quoteAgeMs: effectiveQuoteAgeMs,
      forced: !hasFreshBid,
      priceSource,
      warning: closeError ? 'Paper ledger closed, but live cache cleanup needs attention.' : null
    };
  }

  private livePositionKey(positionId: number | string): string {
    return `paper:position:${positionId}:live`;
  }

  private async getLivePosition(positionId: number | string): Promise<any | null> {
    if (!this.redisClient.isReady?.()) return null;
    const raw = await this.redisClient.hgetall(this.livePositionKey(positionId));
    if (!raw?.currentPrice) return null;
    try {
      return {
        currentPrice: Number(raw.currentPrice),
        underlyingPrice: raw.underlyingPrice ? Number(raw.underlyingPrice) : null,
        trailingHighPrice: raw.trailingHighPrice ? Number(raw.trailingHighPrice) : null,
        trailingStopPct: raw.trailingStopPct ? Number(raw.trailingStopPct) : null,
        suggestedStopLoss: raw.suggestedStopLoss ? Number(raw.suggestedStopLoss) : null,
        analysis: raw.analysis ? JSON.parse(raw.analysis) : {},
        updatedAt: raw.updatedAt || null
      };
    } catch {
      return null;
    }
  }

  private async setLivePosition(positionId: number | string, state: {
    currentPrice: number;
    underlyingPrice: number | null;
    trailingHighPrice: number;
    trailingStopPct: number;
    suggestedStopLoss: number | null;
    analysis: Record<string, any>;
  }, shouldBroadcast = true): Promise<string> {
    const updatedAt = new Date().toISOString();
    await this.redisClient.hset(this.livePositionKey(positionId), {
      currentPrice: state.currentPrice,
      underlyingPrice: state.underlyingPrice,
      trailingHighPrice: state.trailingHighPrice,
      trailingStopPct: state.trailingStopPct,
      suggestedStopLoss: state.suggestedStopLoss,
      analysis: JSON.stringify(state.analysis),
      updatedAt
    });
    const persisted = await this.redisClient.hgetall(this.livePositionKey(positionId));
    if (persisted?.updatedAt !== updatedAt) {
      throw new Error(`Redis did not persist live paper state for position ${positionId}`);
    }
    if (shouldBroadcast) this.broadcastLivePosition(positionId, state, updatedAt);
    return updatedAt;
  }

  private broadcastLivePosition(positionId: number | string, state: Record<string, any>, updatedAt: string): void {
    this.broadcast({ type: 'PAPER_POSITION_UPDATED', data: { positionId: Number(positionId), ...state, updatedAt } });
  }

  private broadcast(message: Record<string, any>): void {
    const websocketServer = (this.fastify as any).websocketServer;
    if (!websocketServer) return;
    for (const client of websocketServer.clients) {
      if ((client as any).readyState === 1) (client as any).send(JSON.stringify(message));
    }
  }

  public async recover(): Promise<void> {
    const client = await (this.fastify as any).pg.connect();
    let expired: any[] = [];
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE`, [ACCOUNT_ID]);
      const result = await client.query(
        `UPDATE paper_orders SET status='EXPIRED', failure_reason='Recovered expired entry after service restart', updated_at=NOW()
         WHERE account_id=$1 AND intent='ENTRY' AND status='PENDING' AND expires_at <= NOW()
         RETURNING id, decision_id, setup_id, reserved_debit`, [ACCOUNT_ID]
      );
      expired = result.rows;
      await client.query(
        `UPDATE paper_accounts SET reserved_cash=COALESCE((
           SELECT SUM(reserved_debit) FROM paper_orders
           WHERE account_id=$1 AND intent='ENTRY' AND status='PENDING'
         ),0), updated_at=NOW() WHERE id=$1`, [ACCOUNT_ID]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const order of expired) {
      await this.journal('ENTRY_EXPIRED', 'Pending entry expired during restart recovery.', order, null, null, { orderId: order.id });
    }
    await this.recoverOverdueOpenPositions();
    await this.refreshAccountEquity();
  }

  private async recoverOverdueOpenPositions(date: Date = new Date()): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT p.*, ptd.exit_profile, ptd.policy_version,
              ptd.trailing_stop_pct AS decision_trailing_stop_pct
       FROM positions p
       LEFT JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
       WHERE p.paper_account_id=$1 AND p.status='OPEN'`,
      [ACCOUNT_ID]
    );
    for (const position of rows) {
      const expirationIntent = this.expirationExitIntent(position, date);
      if (!expirationIntent) continue;
      const live = await this.getLivePosition(position.id);
      let bid = 0;
      let quoteBid = 0;
      try {
        const quote = await (this.fastify as any).ibkrMarketData?.getOptionQuoteForOsi(null, this.osiTicker(position));
        quoteBid = Number(quote?.bid || 0);
        bid = quoteBid;
      } catch (error: any) {
        this.fastify.log.warn(`[PaperTrading] Recovery quote failed for position ${position.id}: ${error.message || String(error)}`);
      }
      const fallbackMark = Number(live?.currentPrice ?? position.current_price ?? 0);
      if (!(bid > 0)) bid = Number.isFinite(fallbackMark) && fallbackMark >= 0 ? fallbackMark : 0;
      await this.closePaperQuantity({
        ...position,
        current_price: bid,
        underlying_price: live?.underlyingPrice ?? position.underlying_price,
        trailing_high_price: live?.trailingHighPrice ?? position.trailing_high_price,
        trailing_stop_loss_pct: live?.trailingStopPct ?? position.trailing_stop_loss_pct,
        suggested_stop_loss: live?.suggestedStopLoss ?? position.suggested_stop_loss,
        analysis_data: {
          ...(live?.analysis || (typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data || {})),
          recoveryExitQuoteSource: quoteBid > 0 ? 'IBKR_BID' : 'LAST_KNOWN_MARK'
        }
      }, Number(position.quantity), bid, expirationIntent);
    }
  }

  public async setAutomationStatus(status: 'ACTIVE' | 'PAUSED'): Promise<Record<string, any>> {
    const client = await (this.fastify as any).pg.connect();
    let result: Record<string, any> | null = null;
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
      result = rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.journal(`AUTOMATION_${status}`, `Paper automation ${status === 'ACTIVE' ? 'resumed' : 'paused'} by an administrator.`, {}, null, null);
    return result!;
  }

  public async processSnapshot(signal: Record<string, any>, setupId: string | null): Promise<void> {
    if (!setupId) return;
    this.queuedSnapshots.set(setupId, { signal, setupId });
    if (!this.snapshotProcessing) {
      this.snapshotProcessing = this.drainSnapshots().finally(() => {
        this.snapshotProcessing = null;
      });
    }
    return this.snapshotProcessing;
  }

  private async drainSnapshots(): Promise<void> {
    let firstError: Error | null = null;
    while (this.queuedSnapshots.size > 0) {
      const nextSetupId = this.queuedSnapshots.keys().next().value as string;
      const next = this.queuedSnapshots.get(nextSetupId)!;
      this.queuedSnapshots.delete(nextSetupId);
      try {
        await this.processSnapshotOnce(next.signal, next.setupId);
      } catch (error: any) {
        firstError ||= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (firstError) {
      this.lastError = firstError.message;
      throw firstError;
    }
  }

  private async processSnapshotOnce(signal: Record<string, any>, setupId: string): Promise<void> {
    try {
      if (!this.redisClient.isReady?.()) throw new Error('Redis is required for autonomous paper position management');
      await this.rollSessionIfNeeded();
      await this.refreshOpenPositions(signal, setupId);
      await this.processPendingEntry(signal, setupId);
      await this.maybeCreateEntry(signal, setupId);
      this.lastProcessedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error: any) {
      this.lastError = error.message || String(error);
      throw error;
    }
  }

  public static quantityForTier(availableCash: number, limitPrice: number, tier: RiskTier): { quantity: number; maxAffordable: number } {
    const desired: Record<RiskTier, number> = { CAUTIOUS: 1, STANDARD: 2, FULL: 3 };
    const contractDebit = limitPrice * 100;
    const maxAffordable = contractDebit > 0 ? Math.max(0, Math.floor(Math.max(0, availableCash) / contractDebit)) : 0;
    return { quantity: Math.min(desired[tier], maxAffordable), maxAffordable };
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

  public static normalizeTokenUsage(raw: any): { promptTokens: number; completionTokens: number; totalTokens: number } {
    const promptTokens = Math.max(0, Number(raw?.prompt_tokens ?? raw?.promptTokens ?? 0) || 0);
    const completionTokens = Math.max(0, Number(raw?.completion_tokens ?? raw?.completionTokens ?? 0) || 0);
    const suppliedTotal = Math.max(0, Number(raw?.total_tokens ?? raw?.totalTokens ?? 0) || 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: suppliedTotal || promptTokens + completionTokens
    };
  }

  public static aiReviewReasons(signal: Record<string, any>, option: Record<string, any>, etMinutes: number): string[] {
    const reasons: string[] = [];
    const confidence = Number(signal.confidence_score);
    const spread = Number(option.spread_pct);
    const rvol = Number(signal.market_context?.rvol_1m);
    const zeroWarnings = signal.zerogex_decision?.gates?.[signal.favoring]?.warnings;
    if (Number.isFinite(confidence) && confidence < 80) reasons.push(`borderline confidence ${confidence}`);
    if (Number.isFinite(spread) && spread >= 8) reasons.push(`wider spread ${spread.toFixed(1)}%`);
    if (Number.isFinite(rvol) && rvol > 0 && rvol < 1.2) reasons.push(`low relative volume ${rvol.toFixed(2)}`);
    if (Array.isArray(zeroWarnings) && zeroWarnings.length > 0) reasons.push('ZeroGEX risk warnings');
    if (etMinutes >= 14 * 60 + 30) reasons.push('late-session entry');
    return reasons;
  }

  private optionFor(signal: Record<string, any>) {
    const side = signal.favoring === 'puts' ? 'PUT' : 'CALL';
    const setup = side === 'PUT' ? signal.put_setup || {} : signal.call_setup || {};
    return { side, setup, option: setup.option || {} };
  }

  private async account(queryable: any = (this.fastify as any).pg) {
    const { rows } = await queryable.query('SELECT * FROM paper_accounts WHERE id = $1', [ACCOUNT_ID]);
    if (!rows[0]) throw new Error('System paper account is unavailable');
    return rows[0];
  }

  private async maybeCreateEntry(signal: Record<string, any>, setupId: string): Promise<void> {
    if (String(signal.state).toUpperCase() !== 'ACTIVE' || signal.lifecycle?.entry_allowed !== true) return;
    const generatedAt = Number(signal.generated_at || 0);
    const signalAgeSeconds = Date.now() / 1000 - generatedAt;
    if (!Number.isFinite(signalAgeSeconds) || signalAgeSeconds < 0 || signalAgeSeconds > 20) return;
    const { side, setup, option } = this.optionFor(signal);
    const expiry = this.normalizeExpiry(option.expiry);
    const bid = Number(option.bid);
    const ask = Number(option.ask);
    const quoteAgeSeconds = option.quote_age_seconds == null ? NaN : Number(option.quote_age_seconds);
    if (option.eligible !== true || !Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0 || ask < bid
      || !Number.isFinite(quoteAgeSeconds) || quoteAgeSeconds < 0 || quoteAgeSeconds > 15
      || !expiry || !option.local_symbol || !Number.isFinite(Number(option.strike)) || Number(option.strike) <= 0) return;
    const account = await this.account();
    if (account.automation_status !== 'ACTIVE') return;
    const existing = await (this.fastify as any).pg.query(
      'SELECT id FROM paper_trade_decisions WHERE account_id = $1 AND setup_id = $2', [ACCOUNT_ID, setupId]
    );
    if (existing.rows.length > 0) return;
    const today = ET_DATE.format(new Date());
    const suppliedMid = Number(option.mid);
    const mid = Number.isFinite(suppliedMid) && suppliedMid >= bid && suppliedMid <= ask
      ? suppliedMid
      : (bid + ask) / 2;
    const protectedLimit = Number(Math.min(ask, mid + (ask - mid) * 0.20).toFixed(2));
    const settings = await getGlobalSettings((this.fastify as any).pg);
    const trailingStopPct = this.trailingStopPct(settings);
    const [etHour, etMinute] = ET_TIME.format(new Date()).split(':').map(Number);
    const aiReasons = PaperTradingService.aiReviewReasons(signal, option, etHour * 60 + etMinute);
    const confidence = Number(signal.confidence_score);
    const rulesDecision: PaperDecision = {
      decision: 'TRADE',
      riskTier: Number.isFinite(confidence) && confidence >= 80 ? 'STANDARD' : 'CAUTIOUS',
      exitProfile: 'BALANCED_T2',
      source: 'RULES',
      rationale: 'Clear setup; deterministic paper sizing used without an AI call.',
      riskFlags: []
    };
    const fallback: PaperDecision = {
      decision: 'TRADE', riskTier: 'CAUTIOUS', exitProfile: 'BALANCED_T2', source: 'FALLBACK',
      rationale: 'AI review was unavailable or budget-limited; one-contract fallback applied.', riskFlags: ['AI sizing unavailable']
    };
    let bounded = rulesDecision;
    let aiRequested = false;
    let tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (aiReasons.length > 0) {
      const calls = await (this.fastify as any).pg.query(
        `SELECT COUNT(*)::int AS count FROM paper_trade_decisions
         WHERE account_id=$1 AND ai_requested=TRUE
           AND (created_at AT TIME ZONE 'America/New_York')::date=$2::date`,
        [ACCOUNT_ID, today]
      );
      const underBudget = Number(calls.rows[0]?.count || 0) < MAX_DAILY_AI_CALLS;
      if (settings.day_trading_ai_enabled !== 'false' && underBudget) {
        aiRequested = true;
        try {
          const prompt = `Resolve paper-risk ambiguity only. Never change the contract, SL, TP1, or TP2.
Allowed risk_tier: CAUTIOUS, STANDARD, FULL. Allowed exit_profile: CONSERVATIVE_T1, BALANCED_T2. You may SKIP.
${JSON.stringify({ reasons: aiReasons, strategy: signal.strategy, side, confidence: signal.confidence_score, rvol: signal.market_context?.rvol_1m, gexRegime: signal.gex?.regime || signal.gex?.gamma_regime, zeroGexState: signal.zerogex_decision?.state || signal.zerogex_decision?.regime, spreadPct: option.spread_pct, delta: option.delta })}
Respond only JSON: {"decision":"TRADE|SKIP","risk_tier":"CAUTIOUS|STANDARD|FULL","exit_profile":"CONSERVATIVE_T1|BALANCED_T2","rationale":"short","risk_flags":[]}`;
          const raw = await new AIService(this.fastify).askTradingJSON(prompt, undefined, 140, 4000);
          tokenUsage = PaperTradingService.normalizeTokenUsage(raw?.usage);
          bounded = PaperTradingService.normalizeAIDecision(raw) || fallback;
        } catch {
          bounded = fallback;
        }
      } else {
        bounded = {
          ...fallback,
          rationale: underBudget
            ? 'AI review is disabled; one-contract fallback applied.'
            : `Daily AI call budget of ${MAX_DAILY_AI_CALLS} reached; one-contract fallback applied.`,
          riskFlags: [underBudget ? 'AI review disabled' : 'Daily AI call budget reached']
        };
      }
    }
    const availableCash = Number(account.cash_balance) - Number(account.reserved_cash);
    const sizing = PaperTradingService.quantityForTier(availableCash, protectedLimit, bounded.riskTier);
    let quantity = bounded.source === 'FALLBACK' ? Math.min(1, sizing.maxAffordable) : sizing.quantity;
    if (bounded.decision === 'SKIP') quantity = 0;
    const signalRow = await (this.fastify as any).pg.query(
      `SELECT id FROM signals WHERE strategy_setup_id = $1 ORDER BY created_at DESC LIMIT 1`, [setupId]
    );
    const decisionInsert = await (this.fastify as any).pg.query(
      `INSERT INTO paper_trade_decisions (
         account_id, setup_id, signal_id, decision, risk_tier, exit_profile, source,
         quantity, max_quantity, debit_budget, protected_limit, model, prompt_version,
         policy_version, trailing_stop_pct,
         ai_requested, ai_reasons, prompt_tokens, completion_tokens, total_tokens,
         rationale, risk_flags, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (account_id, setup_id) DO NOTHING RETURNING *`,
      [ACCOUNT_ID, setupId, signalRow.rows[0]?.id || null, bounded.decision, bounded.riskTier, bounded.exitProfile,
        bounded.source, quantity, sizing.maxAffordable, 0, protectedLimit,
        settings.day_trading_ai_model || settings.ai_model || null, PROMPT_VERSION,
        PAPER_POLICY_VERSION, trailingStopPct,
        aiRequested, JSON.stringify(aiReasons), tokenUsage.promptTokens, tokenUsage.completionTokens, tokenUsage.totalTokens,
        bounded.rationale, JSON.stringify(bounded.riskFlags), JSON.stringify({ generatedAt, quoteAgeSeconds, bid, ask, mid, strategyState: signal.state })]
    );
    const decisionRow = decisionInsert.rows[0];
    if (decisionRow) {
      await this.journal(
        bounded.decision === 'SKIP' ? 'DECISION_SKIPPED' : `DECISION_${bounded.source}`,
        `${bounded.decision}: ${bounded.rationale}`,
        decisionRow, null, protectedLimit,
        { riskTier: bounded.riskTier, exitProfile: bounded.exitProfile, riskFlags: bounded.riskFlags, aiReasons }
      );
    }
    if (!decisionRow || bounded.decision === 'SKIP') return;
    if (quantity < 1) {
      await this.journal('DECISION_SKIPPED', 'TRADE skipped because available paper cash could not fund one contract.', decisionRow, null, protectedLimit, { availableCash, maxAffordable: sizing.maxAffordable });
      return;
    }
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
        const reason = lockedAccount.rows[0]?.automation_status !== 'ACTIVE'
          ? 'TRADE skipped because paper automation was paused before reservation.'
          : 'TRADE skipped because available paper cash changed before reservation.';
        await this.journal('DECISION_SKIPPED', reason, decisionRow, null, protectedLimit, { availableCash: available, requiredDebit: reservedDebit });
        return;
      }
      const order = await client.query(
        `INSERT INTO paper_orders (
           account_id, decision_id, setup_id, signal_id, intent, action, status, osi_ticker,
           option_type, strike, expiration, quantity, limit_price, reserved_debit, quote_snapshot, expires_at
         ) VALUES ($1,$2,$3,$4,'ENTRY','BUY_TO_OPEN','PENDING',$5,$6,$7,$8,$9,$10,$11,$12,NOW() + INTERVAL '60 seconds')
         ON CONFLICT (account_id, setup_id, intent) DO NOTHING RETURNING id`,
        [ACCOUNT_ID, decisionRow.id, setupId, decisionRow.signal_id, option.local_symbol, side, Number(option.strike), expiry,
          quantity, protectedLimit, reservedDebit, JSON.stringify({ bid, ask, mid, quoteAgeSeconds })]
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
      await this.journal('ENTRY_ORDER_CREATED', `Protected paper entry queued for ${quantity} contract${quantity === 1 ? '' : 's'} at $${protectedLimit.toFixed(2)}.`, decisionRow, null, protectedLimit, { quantity });
      await this.processPendingEntry(signal, setupId);
    } else {
      await this.journal('DECISION_SKIPPED', 'TRADE skipped because an entry order already exists for this setup.', decisionRow, null, protectedLimit);
    }
  }

  private async processPendingEntry(signal: Record<string, any>, setupId: string): Promise<void> {
    const { side, setup, option } = this.optionFor(signal);
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT po.*, ptd.exit_profile, ptd.policy_version, ptd.trailing_stop_pct FROM paper_orders po
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
    const generatedAt = Number(signal.generated_at || 0);
    const signalAgeSeconds = Date.now() / 1000 - generatedAt;
    const active = String(signal.state).toUpperCase() === 'ACTIVE'
      && signal.lifecycle?.entry_allowed === true
      && Number.isFinite(signalAgeSeconds)
      && signalAgeSeconds >= 0
      && signalAgeSeconds <= 20;
    if (expired || !active) {
      await this.cancelPendingOrder(order, expired ? 'Protected entry limit expired after 60 seconds' : 'Strategy entry window closed');
      return;
    }
    const ask = Number(option.ask || 0);
    const bid = Number(option.bid || 0);
    const quoteAgeSeconds = option.quote_age_seconds == null ? NaN : Number(option.quote_age_seconds);
    if (option.eligible !== true || !Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0 || ask < bid
      || !Number.isFinite(quoteAgeSeconds) || quoteAgeSeconds < 0 || quoteAgeSeconds > 15
      || ask > Number(order.limit_price) + 0.0001) return;
    const fillPrice = Number(ask.toFixed(2));
    const debit = Number((fillPrice * Number(order.quantity) * 100).toFixed(2));
    const targets = Array.isArray(setup.targets) ? setup.targets : [];
    const client = await (this.fastify as any).pg.connect();
    let filledPosition: any = null;
    let liveEntryState: Record<string, any> | null = null;
    let liveEntryUpdatedAt: string | null = null;
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
           stop_loss_trigger, current_price, trailing_high_price, trailing_stop_loss_pct,
           status, is_simulated, account_id, execution_broker,
           execution_status, contracts_requested, entry_action, exit_action, suggested_stop_loss,
           suggested_take_profit_1, suggested_take_profit_2, signal_id, strategy_setup_id,
           strategy_engine_version, strategy_lifecycle_status, strategy_snapshot, strategy_managed,
           paper_account_id, paper_decision_id, analysis_data, notes
           ) VALUES (NULL,'SPY',$1,$2,$3,$4,$5,$6,$7,$4,$8,'OPEN',TRUE,$9,'system_paper','FILLED',$5,
                   'BUY_TO_OPEN','SELL_TO_CLOSE',$10,$11,$12,$13,$14,'signal-only-v2','ACTIVE',$15,TRUE,$9,$16,$17,$18)
         RETURNING *`,
        [side, Number(order.strike), order.expiration, fillPrice, Number(order.quantity), Number((fillPrice * 0.8).toFixed(2)), Number(option.bid || fillPrice),
          Number(order.trailing_stop_pct), ACCOUNT_ID, setup.invalidation || null, targets[0] || null, targets[1] || targets[0] || null,
          order.signal_id, setupId, JSON.stringify(signal), order.decision_id,
          JSON.stringify({
            exitProfile: order.exit_profile,
            originalQuantity: Number(order.quantity),
            t1Reached: false,
            trailingActive: false,
            trailingHighPremium: fillPrice,
            trailingStopPct: Number(order.trailing_stop_pct),
            policyVersion: order.policy_version
          }),
          `[System paper entry from setup ${setupId}]`]
      );
      filledPosition = positionResult.rows[0];
      await client.query(
        `UPDATE paper_orders SET status='FILLED', fill_price=$1, position_id=$2, filled_at=NOW(), updated_at=NOW() WHERE id=$3`,
        [fillPrice, positionResult.rows[0].id, order.id]
      );
      await client.query(
        `UPDATE paper_accounts SET cash_balance = cash_balance - $1,
           reserved_cash = GREATEST(0, reserved_cash - $2), updated_at=NOW() WHERE id=$3`,
        [debit, Number(order.reserved_debit), ACCOUNT_ID]
      );
      await client.query(
        `INSERT INTO paper_baseline_trades (
           account_id, decision_id, setup_id, position_id, entry_price, current_price, policy_version, trailing_stop_pct
         ) VALUES ($1,$2,$3,$4,$5,$5,$6,$7) ON CONFLICT (account_id,decision_id) DO NOTHING`,
        [ACCOUNT_ID, order.decision_id, setupId, positionResult.rows[0].id, fillPrice, order.policy_version, Number(order.trailing_stop_pct)]
      );
      liveEntryState = {
        currentPrice: Number(filledPosition.current_price),
        underlyingPrice: Number(filledPosition.underlying_price) || null,
        trailingHighPrice: Number(filledPosition.trailing_high_price || fillPrice),
        trailingStopPct: Number(filledPosition.trailing_stop_loss_pct || order.trailing_stop_pct),
        suggestedStopLoss: Number(filledPosition.suggested_stop_loss) || null,
        analysis: typeof filledPosition.analysis_data === 'string'
          ? JSON.parse(filledPosition.analysis_data)
          : filledPosition.analysis_data || {}
      };
      liveEntryUpdatedAt = await this.setLivePosition(filledPosition.id, liveEntryState as any, false);
      await this.refreshAccountEquity(client);
      await this.captureEquity(client);
      await this.journal(
        'ENTRY_FILLED',
        `${order.option_type} paper entry filled: ${order.quantity} contract${Number(order.quantity) === 1 ? '' : 's'} at $${fillPrice.toFixed(2)}.`,
        order,
        filledPosition.id,
        fillPrice,
        { quantity: Number(order.quantity), osiTicker: order.osi_ticker },
        client
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (filledPosition?.id) await this.redisClient.del(this.livePositionKey(filledPosition.id));
      throw error;
    } finally {
      client.release();
    }
    if (filledPosition && liveEntryState && liveEntryUpdatedAt) {
      this.broadcastLivePosition(filledPosition.id, liveEntryState, liveEntryUpdatedAt);
    }
    this.broadcast({ type: 'PAPER_ACCOUNT_CHANGED', data: { reason: 'ENTRY_FILLED', positionId: filledPosition?.id || null } });
    await this.notifyPaperEvent('ENTRY', { ...order, position_id: filledPosition?.id }, `Filled ${order.quantity} ${order.option_type} contract${Number(order.quantity) === 1 ? '' : 's'} at $${fillPrice.toFixed(2)}. Follow the recorded SL, TP1, TP2, then ${Number(order.trailing_stop_pct).toFixed(1)}% premium trail.`);
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
    await this.journal('ENTRY_EXPIRED', reason, order, order.position_id || null, null, { orderId: order.id });
  }

  private async refreshOpenPositions(signal: Record<string, any>, setupId: string): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT p.*, ptd.exit_profile, ptd.policy_version, ptd.trailing_stop_pct AS decision_trailing_stop_pct FROM positions p
       LEFT JOIN paper_trade_decisions ptd ON ptd.id = p.paper_decision_id
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
      const expirationIntent = this.expirationExitIntent(position);
      const optionQuoteAgeSeconds = option.quote_age_seconds == null ? NaN : Number(option.quote_age_seconds);
      let bid = sameSetup
        && this.canonicalTicker(option.local_symbol) === this.canonicalTicker(this.osiTicker(position))
        && Number.isFinite(optionQuoteAgeSeconds)
        && optionQuoteAgeSeconds >= 0
        && optionQuoteAgeSeconds <= 15
        ? Number(option.bid || 0)
        : 0;
      if (!bid) {
        try {
          const quote = await (this.fastify as any).ibkrMarketData.getOptionQuoteForOsi(null, this.osiTicker(position));
          bid = Number(quote?.bid || 0);
        } catch (error: any) {
          this.fastify.log.warn(`[PaperTrading] Option quote failed for position ${position.id}: ${error.message || String(error)}`);
        }
      }
      const spot = Number(signal.spot || position.underlying_price || 0);
      const live = await this.getLivePosition(position.id);
      if (!bid && expirationIntent && expirationIntent !== 'END_OF_DAY') {
        const fallbackMark = Number(live?.currentPrice ?? position.current_price ?? 0);
        bid = Number.isFinite(fallbackMark) && fallbackMark >= 0 ? fallbackMark : 0;
      }
      const allowZeroRecovery = expirationIntent === 'END_OF_DAY_RECOVERY' || expirationIntent === 'EXPIRED_RECOVERY';
      if (!bid && !allowZeroRecovery) continue;
      const analysis = live?.analysis || (typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data || {});
      const trailingStopPct = Number(analysis.trailingStopPct || position.decision_trailing_stop_pct || DEFAULT_PAPER_TRAILING_STOP_PCT);
      const previousTrailingStop = Number(analysis.trailingStopPremium || 0);
      const t1 = Number(position.suggested_take_profit_1 || 0);
      const t2 = Number(position.suggested_take_profit_2 || t1 || 0);
      const stop = Number(live?.suggestedStopLoss || position.suggested_stop_loss || 0);
      const invalidated = stop > 0 && (isCall ? spot <= stop : spot >= stop);
      const premiumStop = Number(live?.stopLossTrigger || position.stop_loss_trigger || 0);
      const premiumStopped = premiumStop > 0 && bid <= premiumStop;
      const emergency = bid <= Number(position.entry_price) * 0.65;
      if (sameSetup) analysis.strategyLifecycleStatus = String(signal.lifecycle?.status || signal.state || '').toUpperCase();
      const liveTerminal = ['COMPLETED', 'FAILED', 'INVALIDATED', 'TRACKING_ABORTED'].includes(
        String(analysis.strategyLifecycleStatus || '').toUpperCase()
      );
      const terminal = currentTerminal || storedTerminal || liveTerminal;
      const hitT1 = t1 > 0 && (isCall ? spot >= t1 : spot <= t1);
      const hitT2 = t2 > 0 && (isCall ? spot >= t2 : spot <= t2);
      const trailingHighPremium = Math.max(Number(live?.trailingHighPrice || position.trailing_high_price || position.entry_price), Number(analysis.trailingHighPremium || 0), bid);
      analysis.trailingHighPremium = trailingHighPremium;
      analysis.trailingStopPct = trailingStopPct;
      analysis.policyVersion = analysis.policyVersion || position.policy_version || PAPER_POLICY_VERSION;
      analysis.trailingActive = Boolean(analysis.t1Reached);
      const trailingStopPremium = analysis.t1Reached
        ? Number(Math.max(Number(position.entry_price), trailingHighPremium * (1 - trailingStopPct / 100)).toFixed(2))
        : null;
      analysis.trailingStopPremium = trailingStopPremium;
      await this.setLivePosition(position.id, {
        currentPrice: bid,
        underlyingPrice: spot || null,
        trailingHighPrice: trailingHighPremium,
        trailingStopPct,
        suggestedStopLoss: stop || null,
        analysis
      });
      const managedPosition = {
        ...position,
        current_price: bid,
        underlying_price: spot || null,
        trailing_high_price: trailingHighPremium,
        trailing_stop_loss_pct: trailingStopPct,
        suggested_stop_loss: stop || null,
        strategy_snapshot: sameSetup ? signal : storedSnapshot,
        analysis_data: analysis
      };
      if (expirationIntent === 'END_OF_DAY_RECOVERY' || expirationIntent === 'EXPIRED_RECOVERY') {
        await this.closePaperQuantity(managedPosition, Number(position.quantity), bid, expirationIntent);
        continue;
      }
      if (trailingStopPremium && trailingStopPremium > previousTrailingStop + 0.009) {
        if (!previousTrailingStop || trailingStopPremium >= previousTrailingStop + 0.05) {
          await this.notifyPaperEvent('TRAILING_MOVE', position, `Trail moved to $${trailingStopPremium.toFixed(2)} after premium reached $${trailingHighPremium.toFixed(2)}. Hold unless the bid touches the trail.`);
        }
      }
      if (invalidated || premiumStopped || emergency || terminal) {
        await this.closePaperQuantity(
          managedPosition,
          Number(position.quantity),
          bid,
          invalidated ? 'INVALIDATION' : premiumStopped ? 'PREMIUM_STOP' : emergency ? 'EMERGENCY_PREMIUM_STOP' : 'STRATEGY_TERMINAL'
        );
        continue;
      }
      if (position.exit_profile === 'CONSERVATIVE_T1' && hitT1) {
        await this.closePaperQuantity(managedPosition, Number(position.quantity), bid, 'TARGET_1');
        continue;
      }
      if (position.exit_profile === 'BALANCED_T2') {
        if (hitT1 && !analysis.t1Reached) {
          const original = Number(analysis.originalQuantity || position.contracts_requested || position.quantity);
          const trim = original >= 2 ? Math.min(Number(position.quantity), Math.ceil(original / 2)) : 0;
          analysis.t1Reached = true;
          analysis.t1ReachedAt = new Date().toISOString();
          analysis.trailingActive = true;
          analysis.trailingStopPremium = Number(Math.max(Number(position.entry_price), trailingHighPremium * (1 - trailingStopPct / 100)).toFixed(2));
          const currentSetup = isCall ? signal.call_setup : signal.put_setup;
          const storedSetup = isCall ? storedSnapshot.call_setup : storedSnapshot.put_setup;
          const positionSetup = sameSetup ? currentSetup : storedSetup;
          managedPosition.suggested_stop_loss = Number(positionSetup?.trigger || stop);
          managedPosition.analysis_data = analysis;
          await this.setLivePosition(position.id, {
            currentPrice: bid,
            underlyingPrice: spot || null,
            trailingHighPrice: trailingHighPremium,
            trailingStopPct,
            suggestedStopLoss: Number(managedPosition.suggested_stop_loss) || null,
            analysis
          });
          await this.notifyPaperEvent('TP1', position, trim > 0 ? `TP1 reached at SPY $${spot.toFixed(2)}. Trim ${trim}; the remainder now follows the $${Number(analysis.trailingStopPremium).toFixed(2)} premium trail.` : `TP1 reached at SPY $${spot.toFixed(2)}. No trim is possible with one contract; follow the $${Number(analysis.trailingStopPremium).toFixed(2)} premium trail.`);
          if (trim > 0) await this.closePaperQuantity(managedPosition, trim, bid, 'TARGET_1_TRIM');
        }
        if (hitT2) {
          const current = await (this.fastify as any).pg.query('SELECT * FROM positions WHERE id=$1', [position.id]);
          if (current.rows[0]?.status === 'OPEN') {
            await this.closePaperQuantity({ ...current.rows[0], ...managedPosition, quantity: current.rows[0].quantity }, Number(current.rows[0].quantity), bid, 'TARGET_2');
            continue;
          }
        }
        if (analysis.t1Reached && analysis.trailingStopPremium && bid <= Number(analysis.trailingStopPremium)) {
          const current = await (this.fastify as any).pg.query('SELECT * FROM positions WHERE id=$1', [position.id]);
          if (current.rows[0]?.status === 'OPEN') {
            await this.closePaperQuantity({ ...current.rows[0], ...managedPosition, quantity: current.rows[0].quantity }, Number(current.rows[0].quantity), bid, 'TRAILING_STOP');
            continue;
          }
        }
      }
      if (expirationIntent === 'END_OF_DAY') {
        const current = await (this.fastify as any).pg.query('SELECT * FROM positions WHERE id=$1', [position.id]);
        if (current.rows[0]?.status === 'OPEN') await this.closePaperQuantity({ ...current.rows[0], ...managedPosition, quantity: current.rows[0].quantity }, Number(current.rows[0].quantity), bid, expirationIntent);
      }
    }
  }

  public async closePaperQuantity(
    position: any,
    quantity: number,
    bid: number,
    intent: string,
    exitMetadata: Record<string, any> = {}
  ): Promise<void> {
    let closeQty = 0;
    let proceeds = 0;
    let pnl = 0;
    let remaining = 0;
    let priorRealizedPnl = Number(position.realized_pnl || 0);
    const setupId = this.paperLedgerSetupId(position);
    const ledgerPosition = { ...position, strategy_setup_id: setupId };
    const analysis = this.paperAnalysis(position.analysis_data);
    const client = await (this.fastify as any).pg.connect();
    let closeStage = 'BEGIN';
    try {
      await client.query('BEGIN');
      closeStage = 'LOCK_POSITION';
      const lockedPosition = await client.query(
        `SELECT quantity, status, realized_pnl FROM positions
         WHERE id=$1 AND paper_account_id=$2 FOR UPDATE`,
        [position.id, ACCOUNT_ID]
      );
      if (lockedPosition.rows[0]?.status !== 'OPEN') {
        await client.query('ROLLBACK');
        return;
      }
      const availableQuantity = Number(lockedPosition.rows[0].quantity);
      closeQty = Math.max(1, Math.min(availableQuantity, Math.floor(quantity)));
      proceeds = Number((bid * closeQty * 100).toFixed(2));
      pnl = Number(((bid - Number(position.entry_price)) * closeQty * 100).toFixed(2));
      remaining = availableQuantity - closeQty;
      priorRealizedPnl = Number(lockedPosition.rows[0].realized_pnl || 0);
      closeStage = 'INSERT_EXIT_ORDER';
      const inserted = await client.query(
        `INSERT INTO paper_orders (
           account_id, decision_id, position_id, setup_id, signal_id, intent, action, status,
           osi_ticker, option_type, strike, expiration, quantity, fill_price, quote_snapshot, filled_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'SELL_TO_CLOSE','FILLED',$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (account_id, setup_id, intent) DO NOTHING RETURNING id`,
        [ACCOUNT_ID, position.paper_decision_id, position.id, setupId, position.signal_id, intent,
          this.osiTicker(position), position.option_type, Number(position.strike_price), this.normalizeExpiry(position.expiration_date), closeQty, bid,
          JSON.stringify({ bid, underlyingPrice: position.underlying_price, ...exitMetadata })]
      );
      if (!inserted.rows[0]) {
        await client.query('ROLLBACK');
        return;
      }
      closeStage = 'UPDATE_POSITION';
      await client.query(
        `UPDATE positions SET quantity=$1, status=$2, current_price=$3,
           realized_pnl=COALESCE(realized_pnl,0)+$4, exit_price=CASE WHEN $12::boolean THEN $3 ELSE exit_price END,
           execution_status=$13,
           exit_reason=$5, underlying_price=$6, trailing_high_price=$7, trailing_stop_loss_pct=$8,
           analysis_data=$9, suggested_stop_loss=COALESCE($10,suggested_stop_loss), updated_at=NOW() WHERE id=$11`,
        [remaining, remaining === 0 ? 'CLOSED' : 'OPEN', bid, pnl, intent,
          position.underlying_price || null, position.trailing_high_price || bid,
          position.trailing_stop_loss_pct || null, JSON.stringify(position.analysis_data || {}),
          position.suggested_stop_loss || null, position.id, remaining === 0,
          remaining === 0 ? 'EXIT_FILLED' : 'PARTIAL_EXIT_FILLED']
      );
      closeStage = 'UPDATE_ACCOUNT_CASH';
      await client.query(`UPDATE paper_accounts SET cash_balance=cash_balance+$1, updated_at=NOW() WHERE id=$2`, [proceeds, ACCOUNT_ID]);
      if (remaining === 0) {
        const originalQuantity = Math.max(1, Number(analysis.originalQuantity || position.contracts_requested || 1));
        const managedRealizedPnl = priorRealizedPnl + pnl;
        const baselinePnl = Number((managedRealizedPnl / originalQuantity).toFixed(2));
        closeStage = 'UPDATE_BASELINE';
        await client.query(
          `UPDATE paper_baseline_trades SET status='CLOSED', current_price=$1, exit_price=$1,
             realized_pnl=$2, exit_reason=$3, closed_at=NOW(), updated_at=NOW()
           WHERE account_id=$4 AND decision_id=$5 AND status='OPEN'`,
          [bid, baselinePnl, intent, ACCOUNT_ID, position.paper_decision_id]
        );
      }
      closeStage = 'INSERT_JOURNAL';
      await this.journal(
        intent,
        `${intent.replace(/_/g, ' ')} filled: ${closeQty} contract${closeQty === 1 ? '' : 's'} at $${bid.toFixed(2)} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}).`,
        ledgerPosition,
        position.id,
        bid,
        { closeQuantity: closeQty, remaining, realizedPnl: pnl, ...exitMetadata },
        client
      );
      closeStage = 'REFRESH_EQUITY';
      await this.refreshAccountEquity(client);
      closeStage = 'CAPTURE_EQUITY';
      await this.captureEquity(client);
      closeStage = 'COMMIT';
      await client.query('COMMIT');
    } catch (error: any) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError: any) {
        this.fastify.log.error({ err: rollbackError, positionId: position.id }, '[PaperTrading] Paper close rollback failed');
      }
      if (error && typeof error === 'object') error.paperCloseStage = error.paperCloseStage || closeStage;
      throw error;
    } finally {
      client.release();
    }
    let redisError: Error | null = null;
    try {
      if (remaining === 0) {
        await this.redisClient.del(this.livePositionKey(position.id));
      } else {
        await this.setLivePosition(position.id, {
          currentPrice: bid,
          underlyingPrice: Number(position.underlying_price) || null,
          trailingHighPrice: Number(position.trailing_high_price || bid),
          trailingStopPct: Number(position.trailing_stop_loss_pct || DEFAULT_PAPER_TRAILING_STOP_PCT),
          suggestedStopLoss: Number(position.suggested_stop_loss) || null,
          analysis
        });
      }
    } catch (error: any) {
      redisError = error instanceof Error ? error : new Error(String(error));
    }
    const alertType = this.exitAlertType(intent);
    this.broadcast({ type: 'PAPER_ACCOUNT_CHANGED', data: { reason: intent, positionId: position.id } });
    await this.notifyPaperEvent(alertType, position, `${intent.replace(/_/g, ' ')}: sold ${closeQty} at $${bid.toFixed(2)} for ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}. ${remaining > 0 ? `${remaining} contract${remaining === 1 ? '' : 's'} remain.` : 'Position is closed.'}`);
    if (redisError) throw redisError;
  }

  private async refreshAccountEquity(queryable: any = (this.fastify as any).pg): Promise<void> {
    const account = await this.account(queryable);
    const positions = await queryable.query(
      `SELECT * FROM positions WHERE paper_account_id=$1 AND status='OPEN'`, [ACCOUNT_ID]
    );
    const openPositions = await this.applyLivePositions(positions.rows);
    const equity = this.calculateEquity(account, openPositions);
    await queryable.query(
      `UPDATE paper_accounts pa SET
         equity = $1,
         high_water_mark = GREATEST(pa.high_water_mark, $1),
         updated_at=NOW()
       WHERE pa.id=$2`, [equity, ACCOUNT_ID]
    );
  }

  private async captureEquity(queryable: any = (this.fastify as any).pg): Promise<void> {
    const account = await this.account(queryable);
    const pnl = await queryable.query(
      `SELECT COALESCE(SUM(realized_pnl),0) AS realized
       FROM positions WHERE paper_account_id=$1`, [ACCOUNT_ID]
    );
    const positions = await queryable.query(
      `SELECT * FROM positions WHERE paper_account_id=$1 AND status='OPEN'`, [ACCOUNT_ID]
    );
    const openPositions = await this.applyLivePositions(positions.rows);
    const unrealized = Number(openPositions.reduce(
      (total: number, position: any) => total
        + (Number(position.current_price || 0) - Number(position.entry_price || 0)) * Number(position.quantity || 0) * 100,
      0
    ).toFixed(2));
    await queryable.query(
      `INSERT INTO paper_equity_snapshots (account_id,equity,cash_balance,reserved_cash,realized_pnl,unrealized_pnl)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ACCOUNT_ID, account.equity, account.cash_balance, account.reserved_cash, pnl.rows[0].realized, unrealized]
    );
  }

  private async rollSessionIfNeeded(): Promise<void> {
    const today = ET_DATE.format(new Date());
    const current = await this.account();
    if (this.normalizeExpiry(current.start_of_day_date) === today) return;
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', [ACCOUNT_ID]);
      const account = locked.rows[0];
      if (!account || this.normalizeExpiry(account.start_of_day_date) === today) {
        await client.query('ROLLBACK');
        return;
      }
      const positions = await client.query(
        `SELECT * FROM positions WHERE paper_account_id=$1 AND status='OPEN' ORDER BY created_at DESC`,
        [ACCOUNT_ID]
      );
      const openPositions = await this.applyLivePositions(positions.rows);
      const equity = this.calculateEquity(account, openPositions);
      await client.query(
        `UPDATE paper_accounts SET equity=$1, high_water_mark=GREATEST(high_water_mark,$1),
           start_of_day_date=$2::date, start_of_day_equity=$1, updated_at=NOW() WHERE id=$3`,
        [equity, today, ACCOUNT_ID]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
      `SELECT p.*, ptd.source AS ai_source, ptd.risk_tier, ptd.exit_profile,
              ptd.ai_requested, ptd.total_tokens
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
    const decisionStats = await (this.fastify as any).pg.query(
      `SELECT COUNT(*) FILTER (WHERE ai_requested)::int AS ai_calls,
              COALESCE(SUM(total_tokens),0)::int AS ai_tokens
       FROM paper_trade_decisions
       WHERE account_id=$1 AND created_at >= $2::date AND created_at < $3::date`,
      [ACCOUNT_ID, start, next]
    );
    const baselineStats = await (this.fastify as any).pg.query(
      `SELECT COUNT(*) FILTER (WHERE status='CLOSED')::int AS closed_trades,
              COUNT(*) FILTER (WHERE status='CLOSED' AND realized_pnl > 0)::int AS wins,
              COALESCE(SUM(realized_pnl) FILTER (WHERE status='CLOSED'),0) AS realized_pnl
       FROM paper_baseline_trades
       WHERE account_id=$1 AND created_at >= $2::date AND created_at < $3::date`,
      [ACCOUNT_ID, start, next]
    );
    const managedRealizedPnl = Number(closed.reduce((sum: number, trade: any) => sum + Number(trade.realized_pnl || 0), 0).toFixed(2));
    const baselineRealizedPnl = Number(baselineStats.rows[0]?.realized_pnl || 0);
    const report = {
      month, openingEquity, closingEquity,
      returnPct: openingEquity > 0 ? Number((((closingEquity - openingEquity) / openingEquity) * 100).toFixed(2)) : 0,
      realizedPnl: managedRealizedPnl,
      trades: trades.length, closedTrades: closed.length, wins: wins.length,
      winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
      profitFactor: losses > 0 ? Number((gains / losses).toFixed(2)) : gains > 0 ? 99.99 : 0,
      expectancy: closed.length ? Number(((gains - losses) / closed.length).toFixed(2)) : 0,
      maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
      fillRate: Number(orderStats.rows[0]?.attempts || 0) ? Number(((Number(orderStats.rows[0].fills) / Number(orderStats.rows[0].attempts)) * 100).toFixed(2)) : 0,
      averageEntryLimitDifference: Number(orderStats.rows[0]?.avg_slippage || 0),
      aiTrades: trades.filter((trade: any) => trade.ai_source === 'AI').length,
      rulesTrades: trades.filter((trade: any) => trade.ai_source === 'RULES').length,
      fallbackTrades: trades.filter((trade: any) => trade.ai_source === 'FALLBACK').length,
      aiCalls: Number(decisionStats.rows[0]?.ai_calls || 0),
      aiTokens: Number(decisionStats.rows[0]?.ai_tokens || 0),
      baseline: {
        name: 'One contract · no AI sizing',
        closedTrades: Number(baselineStats.rows[0]?.closed_trades || 0),
        wins: Number(baselineStats.rows[0]?.wins || 0),
        winRate: Number(baselineStats.rows[0]?.closed_trades || 0) > 0
          ? Number((Number(baselineStats.rows[0].wins) / Number(baselineStats.rows[0].closed_trades) * 100).toFixed(2)) : 0,
        realizedPnl: baselineRealizedPnl,
        sizingValueAdded: Number((managedRealizedPnl - baselineRealizedPnl).toFixed(2))
      }
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
      message: `Closing equity $${Number(report.closingEquity).toFixed(2)} · Return ${Number(report.returnPct).toFixed(2)}% · P&L $${Number(report.realizedPnl).toFixed(2)} · One-contract baseline $${Number(report.baseline?.realizedPnl || 0).toFixed(2)} · Sizing value ${Number(report.baseline?.sizingValueAdded || 0) >= 0 ? '+' : ''}$${Number(report.baseline?.sizingValueAdded || 0).toFixed(2)} · ${report.closedTrades} closed trades · Win rate ${Number(report.winRate).toFixed(1)}% · Max drawdown ${Number(report.maxDrawdownPct).toFixed(2)}%`,
      category: 'paper-monthly-report', dedupeKey: `paper-monthly:${row.month}`, dedupeSeconds: 40 * 24 * 60 * 60
    });
    if (sent) await (this.fastify as any).pg.query('UPDATE paper_monthly_reports SET discord_sent_at=NOW() WHERE id=$1', [row.id]);
  }

  private trailingStopPct(settings: Record<string, string>): number {
    const configured = Number(settings.paper_trailing_stop_pct);
    return Number.isFinite(configured) && configured >= 1 && configured <= 50
      ? Number(configured.toFixed(2))
      : DEFAULT_PAPER_TRAILING_STOP_PCT;
  }

  private exitAlertType(intent: string): string {
    if (intent === 'TARGET_1_TRIM' || intent === 'TARGET_1') return 'TP1';
    if (intent === 'TARGET_2') return 'TP2';
    if (intent === 'TRAILING_STOP') return 'TRAILING_STOP';
    if (['END_OF_DAY', 'END_OF_DAY_RECOVERY', 'EXPIRED_RECOVERY'].includes(intent)) return 'EOD';
    if (intent === 'STRATEGY_TERMINAL' || intent === 'MANUAL_EXIT' || intent === 'MANUAL_FORCE_EXIT') return 'EXIT';
    return 'SL';
  }

  private async journal(
    eventType: string,
    message: string,
    source: any,
    positionId: number | null,
    premium: number | null,
    metadata: Record<string, any> = {},
    queryable: any = (this.fastify as any).pg
  ): Promise<void> {
    const setupId = source?.setup_id || source?.strategy_setup_id || null;
    const decisionId = source?.decision_id || source?.paper_decision_id || (source?.decision ? source?.id : null);
    const policyVersion = source?.policy_version
      || (typeof source?.analysis_data === 'object' ? source.analysis_data?.policyVersion : null)
      || PAPER_POLICY_VERSION;
    await queryable.query(
      `INSERT INTO paper_trade_journal (
         account_id, setup_id, decision_id, position_id, event_type, policy_version,
         message, premium, underlying_price, quantity, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ACCOUNT_ID, setupId, decisionId, positionId, eventType, policyVersion, message, premium,
        source?.underlying_price || null, metadata.quantity ?? source?.quantity ?? null, JSON.stringify(metadata)]
    );
  }

  private async notifyPaperEvent(eventType: string, source: any, message: string): Promise<void> {
    try {
      const admin = await (this.fastify as any).pg.query(`SELECT id FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1`);
      if (!admin.rows[0]) return;
      const severity = ['SL', 'TRAILING_STOP'].includes(eventType) ? 'warning' : 'info';
      await new DiscordAlertService(this.fastify).send({
        userId: Number(admin.rows[0].id),
        title: `PAPER ${eventType.replace(/_/g, ' ')}`,
        message,
        severity,
        category: 'paper-trade',
        tradeId: source?.position_id || source?.id || undefined,
        signalId: source?.signal_id || undefined,
        dedupeKey: `paper:${eventType}:${source?.position_id || source?.id || source?.setup_id || 'system'}`,
        dedupeSeconds: 60
      });
    } catch (error: any) {
      this.fastify.log.warn(`[PaperTrading] Paper Discord alert failed: ${error.message || String(error)}`);
    }
  }

  private mandatoryFlattenDue(position: any, date: Date = new Date()): boolean {
    return this.expirationExitIntent(position, date) === 'END_OF_DAY';
  }

  private expirationExitIntent(position: any, date: Date = new Date()): 'END_OF_DAY' | 'END_OF_DAY_RECOVERY' | 'EXPIRED_RECOVERY' | null {
    const expiration = this.normalizeExpiry(position?.expiration_date);
    const today = ET_DATE.format(date);
    if (!expiration) return null;
    if (expiration < today) return 'EXPIRED_RECOVERY';
    if (expiration !== today) return null;
    const closeMinutes = getUSMarketCloseMinutes(date);
    const market = getNewYorkMarketState(date, 9 * 60 + 30, closeMinutes);
    if (market.isWeekend || market.isHoliday || market.minutes < closeMinutes - 40) return null;
    return market.minutes < closeMinutes ? 'END_OF_DAY' : 'END_OF_DAY_RECOVERY';
  }

  private normalizeExpiry(value: any): string | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    const raw = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return null;
  }

  private paperAnalysis(value: any): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private paperLedgerSetupId(position: any): string {
    const configured = String(position?.strategy_setup_id || '').trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(configured)) {
      return configured;
    }
    const positionId = Number(position?.id);
    if (!Number.isSafeInteger(positionId) || positionId <= 0 || positionId > 0xffffffffffff) {
      throw new Error('Paper position is missing a valid setup and position id');
    }
    return `00000000-0000-5000-8000-${positionId.toString(16).padStart(12, '0')}`;
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
