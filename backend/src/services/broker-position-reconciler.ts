import { FastifyInstance } from 'fastify';
import { constructOSITicker, canonicalOccTicker } from '../lib/occ-ticker';
import { getNewYorkMarketState, getUSMarketCloseMinutes } from '../lib/market-calendar';
import { publishRealtime } from '../lib/realtime';
import { DiscordAlertService } from './discord-alert-service';
import { BrokerOptionHolding, BrokerOrderSummary, SnaptradeService } from './snaptrade-service';
import { TradeRedisService } from './trade-redis-service';

export type MismatchClass = 'DB_OPEN_BROKER_FLAT' | 'BROKER_OPEN_DB_FLAT' | 'QUANTITY_MISMATCH';

export type ReconcilerBrokerClient = {
  resolveTradingAccountIds(userId: number): Promise<string[]>;
  listOptionHoldings(userId: number, accountId: string): Promise<BrokerOptionHolding[]>;
  listRecentOrderSummaries(userId: number, accountId: string): Promise<BrokerOrderSummary[]>;
};

export type ReconcileUserResult = {
  userId: number;
  skipped: string | null;
  observed: number;
  acted: number;
  resolved: number;
  actions: Array<{ ticker: string; mismatch: MismatchClass; action: string; positionId?: number | null }>;
  unresolvedBlocking: number;
};

export type ReconcilerHealth = {
  status: 'IDLE' | 'UP' | 'ERROR' | 'RUNNING';
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: ReconcileUserResult[] | null;
  runs: number;
  usersWithBlockingMismatch: number[];
};

type Mismatch = {
  ticker: string;
  mismatch: MismatchClass;
  position: any | null;
  holding: BrokerOptionHolding | null;
};

/**
 * Compares Wealthsimple option holdings (via SnapTrade) with our OPEN live
 * positions and heals the differences the system can heal safely:
 *
 *  A. DB OPEN / broker flat  -> close locally (with the broker's fill if we
 *     can find it, else the last price, flagged as estimated) + critical alert.
 *     A phantom OPEN both blocks the single swing slot and makes the exit
 *     engine fire sells the broker rejects.
 *  B. broker long / no DB row -> adopt under management ONLY when it is
 *     provably ours (a recently cancelled/abandoned/reconcile-required entry
 *     for the same contract) and the swing slot is free. Otherwise alert
 *     every 30 min and block new entries for the user — never auto-sell a
 *     holding the operator may have opened by hand.
 *  C. quantity mismatch      -> DB > broker: shrink + alert; DB < broker:
 *     alert only (and block entries).
 *
 * Every mismatch must be seen on two consecutive runs at least 4 minutes
 * apart before anything happens (two-strike rule), because holdings can lag
 * fills by a minute or two. Users with order work in flight are skipped: a
 * snapshot taken mid-fill is ambiguous by construction.
 */
export class BrokerPositionReconciler {
  static readonly STRIKES_REQUIRED = 2;
  static readonly MIN_STRIKE_GAP_MS = 4 * 60 * 1000;
  static readonly MARKET_HOURS_INTERVAL_MS = 5 * 60 * 1000;
  static readonly POST_CLOSE_DELAY_MINUTES = 30;
  static readonly STALE_RUN_BLOCK_MS = 30 * 60 * 1000;
  static readonly ADOPTION_EVIDENCE_DAYS = 3;
  static readonly ADOPTION_EVIDENCE_STATUSES = [
    'CANCELED', 'CANCELLED', 'EXPIRED', 'ENTRY_STALE', 'ENTRY_RECONCILE_REQUIRED', 'REJECTED', 'ENTRY_ABANDONED', 'PARTIAL_CANCELED'
  ];
  static readonly ADOPTED_PREMIUM_STOP_PCT = 20;
  static readonly ADOPTED_TRAIL_PCT = 15;

  public now: () => Date = () => new Date();
  public broker: ReconcilerBrokerClient;
  private running = false;
  private runs = 0;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: ReconcileUserResult[] | null = null;
  private lastSuccessByUser = new Map<number, number>();
  private blockingByUser = new Map<number, string>();
  private lastPostCloseRunDate: string | null = null;

  constructor(private fastify: FastifyInstance, broker?: ReconcilerBrokerClient) {
    this.broker = broker || new SnaptradeService(fastify);
  }

  // ---------------------------------------------------------------- schedule

  /** True when a scheduled run is due: every 5 min in-session, once ~30 min after the close. */
  shouldRun(now: Date = this.now()): boolean {
    const closeMinutes = getUSMarketCloseMinutes(now);
    const market = getNewYorkMarketState(now, 9 * 60 + 30, closeMinutes);
    const lastRunMs = this.lastRunAt ? new Date(this.lastRunAt).getTime() : 0;
    if (market.isOpen) {
      return now.getTime() - lastRunMs >= BrokerPositionReconciler.MARKET_HOURS_INTERVAL_MS;
    }
    if (market.isWeekend || market.isHoliday) return false;
    const postCloseAt = closeMinutes + BrokerPositionReconciler.POST_CLOSE_DELAY_MINUTES;
    const todayKey = this.newYorkDateKey(now);
    if (market.minutes >= postCloseAt && market.minutes < postCloseAt + 60 && this.lastPostCloseRunDate !== todayKey) {
      return true;
    }
    return false;
  }

  /** Timer entry point: runs when due, never throws. */
  async tick(now: Date = this.now()): Promise<boolean> {
    if (!this.shouldRun(now)) return false;
    const market = getNewYorkMarketState(now, 9 * 60 + 30, getUSMarketCloseMinutes(now));
    if (!market.isOpen) this.lastPostCloseRunDate = this.newYorkDateKey(now);
    await this.runAll().catch(() => undefined);
    return true;
  }

  hasRunOnce(): boolean {
    return this.runs > 0;
  }

  // ------------------------------------------------------------------- gates

  /**
   * Entry gate for the adapter. Returns a reason when autonomous entries for
   * the user must stay blocked: an unresolved broker-side mismatch (classes
   * B/C) or no successful reconcile within 30 minutes of an open session.
   */
  entryBlockReason(userId: number, now: Date = this.now()): string | null {
    const blocking = this.blockingByUser.get(userId);
    if (blocking) return blocking;
    const market = getNewYorkMarketState(now, 9 * 60 + 30, getUSMarketCloseMinutes(now));
    if (!market.isOpen) return null;
    const lastSuccess = this.lastSuccessByUser.get(userId) || 0;
    if (now.getTime() - lastSuccess > BrokerPositionReconciler.STALE_RUN_BLOCK_MS) {
      return lastSuccess
        ? `broker position reconciliation is stale (last success ${Math.round((now.getTime() - lastSuccess) / 60000)} min ago)`
        : 'broker position reconciliation has not completed yet';
    }
    return null;
  }

  getHealth(): ReconcilerHealth {
    return {
      status: this.running ? 'RUNNING' : this.lastError ? 'ERROR' : this.lastRunAt ? 'UP' : 'IDLE',
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      runs: this.runs,
      usersWithBlockingMismatch: [...this.blockingByUser.keys()]
    };
  }

  // -------------------------------------------------------------------- runs

  async runAll(): Promise<ReconcileUserResult[]> {
    if (this.running) return this.lastResult || [];
    this.running = true;
    this.lastRunAt = this.now().toISOString();
    try {
      const { rows } = await (this.fastify as any).pg.query(
        `/* reconciler:users */
         SELECT DISTINCT user_id FROM (
           SELECT user_id FROM settings WHERE key = 'autonomous_live_entry_enabled' AND value = 'true' AND user_id IS NOT NULL
           UNION
           SELECT user_id FROM positions
            WHERE execution_broker = 'wealthsimple_snaptrade' AND COALESCE(is_simulated, FALSE) = FALSE AND status = 'OPEN'
         ) u WHERE user_id IS NOT NULL AND user_id > 0`
      );
      const results: ReconcileUserResult[] = [];
      for (const row of rows) {
        const userId = Number(row.user_id);
        try {
          results.push(await this.runForUser(userId));
        } catch (err: any) {
          this.fastify.log.warn(`[BrokerReconciler] user ${userId} failed: ${err?.message || String(err)}`);
          results.push({ userId, skipped: `error: ${err?.message || String(err)}`, observed: 0, acted: 0, resolved: 0, actions: [], unresolvedBlocking: 0 });
        }
      }
      this.lastResult = results;
      this.lastSuccessAt = this.now().toISOString();
      this.lastError = null;
      this.runs += 1;
      return results;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      this.fastify.log.error(`[BrokerReconciler] run failed: ${this.lastError}`);
      throw err;
    } finally {
      this.running = false;
    }
  }

  async runForUser(userId: number): Promise<ReconcileUserResult> {
    const now = this.now();
    const result: ReconcileUserResult = { userId, skipped: null, observed: 0, acted: 0, resolved: 0, actions: [], unresolvedBlocking: 0 };
    const pg = (this.fastify as any).pg;

    // Preconditions: any order work in flight makes the snapshot ambiguous.
    const { rows: inflight } = await pg.query(
      `/* reconciler:inflight */
       SELECT id, status, execution_status FROM positions
        WHERE user_id = $1
          AND execution_broker = 'wealthsimple_snaptrade'
          AND COALESCE(is_simulated, FALSE) = FALSE
          AND (
            status = 'PENDING_ORDER'
            OR (status = 'OPEN' AND (
              execution_status IN ('PARTIALLY_FILLED', 'PENDING_EXIT', 'PENDING_TRIM', 'PENDING_RECONCILE')
              OR execution_status LIKE 'EXIT_%'
            ))
          )
        LIMIT 1`,
      [userId]
    );
    if (inflight.length > 0) {
      result.skipped = `order work in flight (position ${inflight[0].id} ${inflight[0].status}/${inflight[0].execution_status || ''})`;
      return result;
    }

    const accountIds = await this.broker.resolveTradingAccountIds(userId);
    if (accountIds.length === 0) {
      result.skipped = 'no SnapTrade account configured';
      return result;
    }

    // Broker side.
    const holdingsByTicker = new Map<string, BrokerOptionHolding>();
    for (const accountId of accountIds) {
      const holdings = await this.broker.listOptionHoldings(userId, accountId);
      for (const holding of holdings) {
        if (!holding.ticker || !Number.isFinite(holding.units) || holding.units === 0) continue;
        const existing = holdingsByTicker.get(holding.ticker);
        holdingsByTicker.set(holding.ticker, existing ? { ...existing, units: existing.units + holding.units } : holding);
      }
    }

    // DB side.
    const { rows: openRows } = await pg.query(
      `/* reconciler:open */
       SELECT * FROM positions
        WHERE user_id = $1
          AND execution_broker = 'wealthsimple_snaptrade'
          AND COALESCE(is_simulated, FALSE) = FALSE
          AND status = 'OPEN'`,
      [userId]
    );
    const openByTicker = new Map<string, any>();
    for (const row of openRows) {
      const ticker = canonicalOccTicker(constructOSITicker(row.symbol, Number(row.strike_price), row.option_type, row.expiration_date));
      if (ticker) openByTicker.set(ticker, row);
    }

    // Classify.
    const mismatches: Mismatch[] = [];
    for (const [ticker, position] of openByTicker) {
      const holding = holdingsByTicker.get(ticker);
      if (!holding || holding.units <= 0) {
        mismatches.push({ ticker, mismatch: 'DB_OPEN_BROKER_FLAT', position, holding: holding || null });
      } else if (Math.abs(holding.units - Number(position.quantity || 0)) > 0.0001) {
        mismatches.push({ ticker, mismatch: 'QUANTITY_MISMATCH', position, holding });
      }
    }
    for (const [ticker, holding] of holdingsByTicker) {
      if (holding.units > 0 && !openByTicker.has(ticker)) {
        mismatches.push({ ticker, mismatch: 'BROKER_OPEN_DB_FLAT', position: null, holding });
      }
    }
    result.observed = mismatches.length;

    // Resolve table rows whose mismatch is no longer observed.
    const observedKeys = new Set(mismatches.map((m) => `${m.ticker}|${m.mismatch}`));
    const { rows: openRecords } = await pg.query(
      `/* reconciler:records */
       SELECT id, osi_ticker, mismatch_class, position_id, first_seen_at, last_seen_at, strikes
         FROM broker_position_reconciliations
        WHERE user_id = $1 AND resolved_at IS NULL`,
      [userId]
    );
    for (const record of openRecords) {
      if (!observedKeys.has(`${record.osi_ticker}|${record.mismatch_class}`)) {
        await pg.query(
          `/* reconciler:resolve */
           UPDATE broker_position_reconciliations
              SET resolved_at = $2, action = COALESCE(action, 'CLEARED'), details = COALESCE(details, '{}'::jsonb) || $3::jsonb
            WHERE id = $1`,
          [record.id, now.toISOString(), JSON.stringify({ cleared_at: now.toISOString() })]
        );
        result.resolved += 1;
      }
    }

    // Two-strike bookkeeping + actions.
    let orders: BrokerOrderSummary[] | null = null;
    const loadOrders = async () => {
      if (orders) return orders;
      orders = [];
      for (const accountId of accountIds) {
        try {
          orders.push(...await this.broker.listRecentOrderSummaries(userId, accountId));
        } catch (err: any) {
          this.fastify.log.warn(`[BrokerReconciler] recent orders unavailable for account ${accountId}: ${err?.message || String(err)}`);
        }
      }
      return orders;
    };

    let blockingReason: string | null = null;
    for (const mismatch of mismatches) {
      const record = openRecords.find((r: any) => r.osi_ticker === mismatch.ticker && r.mismatch_class === mismatch.mismatch);
      let strikes = 1;
      let firstSeenMs = now.getTime();
      if (!record) {
        await pg.query(
          `/* reconciler:insert */
           INSERT INTO broker_position_reconciliations (user_id, osi_ticker, position_id, mismatch_class, first_seen_at, last_seen_at, strikes, details)
           VALUES ($1, $2, $3, $4, $5, $5, 1, $6::jsonb)`,
          [userId, mismatch.ticker, mismatch.position?.id || null, mismatch.mismatch, now.toISOString(), JSON.stringify(this.describe(mismatch))]
        );
      } else {
        firstSeenMs = new Date(record.first_seen_at).getTime();
        strikes = Number(record.strikes || 0) + 1;
        await pg.query(
          `/* reconciler:strike */
           UPDATE broker_position_reconciliations SET last_seen_at = $2, strikes = $3, details = $4::jsonb WHERE id = $1`,
          [record.id, now.toISOString(), strikes, JSON.stringify(this.describe(mismatch))]
        );
      }
      const matured = strikes >= BrokerPositionReconciler.STRIKES_REQUIRED
        && now.getTime() - firstSeenMs >= BrokerPositionReconciler.MIN_STRIKE_GAP_MS;
      if (!matured) {
        // Classes B/C block entries from first sight: an unexplained broker
        // position is a reason to stop opening new ones even before we act.
        if (mismatch.mismatch !== 'DB_OPEN_BROKER_FLAT') {
          blockingReason = blockingReason || `broker mismatch under observation: ${mismatch.mismatch} ${mismatch.ticker}`;
        }
        continue;
      }

      const outcome = await this.act(userId, mismatch, await loadOrders(), now);
      result.actions.push({ ticker: mismatch.ticker, mismatch: mismatch.mismatch, action: outcome.action, positionId: outcome.positionId ?? mismatch.position?.id ?? null });
      if (outcome.resolved) {
        result.acted += 1;
        await pg.query(
          `/* reconciler:resolve-action */
           UPDATE broker_position_reconciliations
              SET resolved_at = $2, action = $3, position_id = COALESCE($4, position_id), details = COALESCE(details, '{}'::jsonb) || $5::jsonb
            WHERE user_id = $1 AND osi_ticker = $6 AND mismatch_class = $7 AND resolved_at IS NULL`,
          [userId, now.toISOString(), outcome.action, outcome.positionId ?? null, JSON.stringify(outcome.details || {}), mismatch.ticker, mismatch.mismatch]
        );
      } else {
        result.unresolvedBlocking += 1;
        blockingReason = blockingReason || `unresolved broker mismatch: ${mismatch.mismatch} ${mismatch.ticker} (${outcome.action})`;
        await pg.query(
          `/* reconciler:note-action */
           UPDATE broker_position_reconciliations SET action = $3, details = COALESCE(details, '{}'::jsonb) || $4::jsonb
            WHERE user_id = $1 AND osi_ticker = $2 AND mismatch_class = $5 AND resolved_at IS NULL`,
          [userId, mismatch.ticker, outcome.action, JSON.stringify(outcome.details || {}), mismatch.mismatch]
        );
      }
    }

    if (blockingReason) this.blockingByUser.set(userId, blockingReason);
    else this.blockingByUser.delete(userId);
    this.lastSuccessByUser.set(userId, now.getTime());
    if (result.acted > 0 || result.resolved > 0) {
      await TradeRedisService.invalidatePositionsCache(userId).catch(() => undefined);
    }
    return result;
  }

  // ----------------------------------------------------------------- actions

  private async act(userId: number, mismatch: Mismatch, orders: BrokerOrderSummary[], now: Date): Promise<{ action: string; resolved: boolean; positionId?: number | null; details?: any }> {
    switch (mismatch.mismatch) {
      case 'DB_OPEN_BROKER_FLAT':
        return this.closePhantomOpen(userId, mismatch, orders, now);
      case 'BROKER_OPEN_DB_FLAT':
        return this.adoptOrAlertOrphan(userId, mismatch, orders, now);
      case 'QUANTITY_MISMATCH':
        return this.reconcileQuantity(userId, mismatch, now);
      default:
        return { action: 'IGNORED', resolved: true };
    }
  }

  private async closePhantomOpen(userId: number, mismatch: Mismatch, orders: BrokerOrderSummary[], now: Date) {
    const position = mismatch.position;
    const pg = (this.fastify as any).pg;
    const closingFill = orders.find((o) => o.ticker === mismatch.ticker && o.filled && /SELL_CLOSE|SELL/.test(o.action) && (o.fillPrice || 0) > 0);
    const exitPrice = closingFill?.fillPrice || Number(position.current_price || position.entry_price || 0);
    const estimated = !closingFill;
    const exitReason = closingFill ? 'BROKER_RECONCILED_FLAT' : 'BROKER_FLAT_UNKNOWN_FILL';
    const realizedPnl = (exitPrice - Number(position.entry_price || 0)) * Number(position.quantity || 0) * 100;
    const updated = await pg.query(
      `/* reconciler:close-phantom */
       UPDATE positions
          SET status = 'CLOSED',
              exit_price = $2,
              current_price = $2,
              realized_pnl = COALESCE(realized_pnl, 0) + $3,
              execution_status = 'EXIT_FILLED_EXTERNAL',
              exit_reason = $4,
              notes = COALESCE(notes, '') || $5,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'OPEN'`,
      [
        position.id,
        exitPrice,
        realizedPnl,
        exitReason,
        ` [Reconciler: broker reports flat; closed locally at ${exitPrice.toFixed(2)}${estimated ? ' (ESTIMATED — no closing fill found at broker; realized P&L is approximate)' : ` (broker fill ${closingFill?.executedAt || ''})`}]`
      ]
    );
    if ((updated.rowCount ?? 0) === 0) return { action: 'ALREADY_CLOSED', resolved: true, positionId: position.id };
    const message = `Position #${position.id} ${position.symbol} ${position.option_type} ${Number(position.strike_price)} is OPEN locally but the broker reports no holding. Closed locally at ${exitPrice.toFixed(2)}${estimated ? ' (estimated; verify realized P&L)' : ' using the broker fill'}.`;
    await this.record(userId, position.id, 'BROKER_RECONCILE_CLOSED', message, { ticker: mismatch.ticker, exitPrice, estimated, exitReason, realizedPnl });
    publishRealtime('POSITION_UPDATE', { id: position.id, kind: 'lifecycle', status: 'CLOSED', execution_status: 'EXIT_FILLED_EXTERNAL', exit_reason: exitReason }, { userId });
    await this.alert(userId, 'critical', 'broker-reconcile', 'Phantom position closed by reconciler', message, position.id, `reconcile-closed:${position.id}`, 3600);
    return { action: 'CLOSED_LOCALLY', resolved: true, positionId: position.id, details: { exitPrice, estimated, exitReason } };
  }

  private async adoptOrAlertOrphan(userId: number, mismatch: Mismatch, orders: BrokerOrderSummary[], now: Date) {
    const holding = mismatch.holding!;
    const pg = (this.fastify as any).pg;
    const since = new Date(now.getTime() - BrokerPositionReconciler.ADOPTION_EVIDENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { rows: closedRows } = await pg.query(
      `/* reconciler:evidence */
       SELECT id, symbol, option_type, strike_price, expiration_date, execution_status, signal_id, strategy_setup_id, account_id, execution_account_id, updated_at
         FROM positions
        WHERE user_id = $1
          AND execution_broker = 'wealthsimple_snaptrade'
          AND COALESCE(is_simulated, FALSE) = FALSE
          AND status = 'CLOSED'
          AND UPPER(COALESCE(execution_status, '')) = ANY($2::text[])
          AND updated_at >= $3
        ORDER BY updated_at DESC`,
      [userId, BrokerPositionReconciler.ADOPTION_EVIDENCE_STATUSES, since]
    );
    const evidence = closedRows.find((row: any) =>
      canonicalOccTicker(constructOSITicker(row.symbol, Number(row.strike_price), row.option_type, row.expiration_date)) === mismatch.ticker);
    const description = `${holding.underlying || mismatch.ticker} ${holding.optionType} ${holding.strike} exp ${holding.expiration} x${holding.units}`;

    if (!evidence) {
      const message = `Broker holds ${description} (${mismatch.ticker}) but no local position exists and no recent entry of ours matches. Not adopting (could be a manual holding). New autonomous entries are blocked until this is resolved.`;
      await this.record(userId, null, 'BROKER_RECONCILE_ORPHAN', message, { ticker: mismatch.ticker, units: holding.units });
      await this.alert(userId, 'critical', 'broker-reconcile', 'Unknown option position at broker', message, null, `reconcile-orphan:${userId}:${mismatch.ticker}`, 30 * 60);
      return { action: 'ALERT_ONLY_UNKNOWN_ORIGIN', resolved: false, details: { units: holding.units } };
    }

    const { rows: slotRows } = await pg.query(
      `/* reconciler:slot */
       SELECT id FROM positions WHERE user_id = $1 AND strategy_managed = TRUE AND status IN ('OPEN', 'PENDING_ORDER') LIMIT 1`,
      [userId]
    );
    if (slotRows.length > 0) {
      const message = `Broker holds ${description} (${mismatch.ticker}), which looks like our cancelled/abandoned entry #${evidence.id} that actually filled, but the swing slot is already held by position #${slotRows[0].id}. Two longs at the broker — resolve manually. New entries blocked.`;
      await this.record(userId, evidence.id, 'BROKER_RECONCILE_ORPHAN', message, { ticker: mismatch.ticker, units: holding.units, evidencePositionId: evidence.id, slotPositionId: slotRows[0].id });
      await this.alert(userId, 'critical', 'broker-reconcile', 'Unmanaged fill at broker — slot occupied', message, evidence.id, `reconcile-orphan:${userId}:${mismatch.ticker}`, 30 * 60);
      return { action: 'ALERT_ONLY_SLOT_OCCUPIED', resolved: false, details: { evidencePositionId: evidence.id, slotPositionId: slotRows[0].id } };
    }

    const openingFill = orders.find((o) => o.ticker === mismatch.ticker && o.filled && /BUY_OPEN|BUY/.test(o.action) && (o.fillPrice || 0) > 0);
    const entryPrice = Number(openingFill?.fillPrice || holding.averagePurchasePrice || holding.price || 0);
    if (!(entryPrice > 0)) {
      const message = `Broker holds ${description} (${mismatch.ticker}) from our entry #${evidence.id} but no entry price could be determined; cannot adopt safely. New entries blocked.`;
      await this.alert(userId, 'critical', 'broker-reconcile', 'Cannot adopt broker position', message, evidence.id, `reconcile-orphan:${userId}:${mismatch.ticker}`, 30 * 60);
      return { action: 'ALERT_ONLY_NO_PRICE', resolved: false, details: { evidencePositionId: evidence.id } };
    }
    const quantity = Math.max(1, Math.floor(holding.units));
    const stop = Number((entryPrice * (1 - BrokerPositionReconciler.ADOPTED_PREMIUM_STOP_PCT / 100)).toFixed(2));
    const accountId = String(evidence.execution_account_id || evidence.account_id || holding.accountId);
    try {
      const inserted = await pg.query(
        `/* reconciler:adopt */
         INSERT INTO positions (
           user_id, symbol, option_type, strike_price, expiration_date,
           entry_price, quantity, stop_loss_trigger, trailing_high_price, trailing_stop_loss_pct, current_price,
           status, is_simulated, account_id, notes, execution_broker, execution_account_id, execution_status, contracts_requested,
           entry_action, exit_action, signal_id, strategy_setup_id, strategy_managed, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $6, $9, $10,
           'OPEN', FALSE, $11, $12, 'wealthsimple_snaptrade', $11, 'FILLED', $7,
           'BUY_TO_OPEN', 'SELL_TO_CLOSE', $13, $14, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         ) RETURNING id`,
        [
          userId,
          holding.underlying || evidence.symbol,
          holding.optionType,
          holding.strike,
          holding.expiration || evidence.expiration_date,
          entryPrice,
          quantity,
          stop,
          BrokerPositionReconciler.ADOPTED_TRAIL_PCT,
          Number(holding.price || entryPrice),
          accountId,
          `[ADOPTED by reconciler from broker holding ${mismatch.ticker}; original entry #${evidence.id} ${evidence.execution_status}; entry ${entryPrice.toFixed(2)} ${openingFill ? '(broker fill)' : '(broker average cost)'}; premium stop ${stop} (${BrokerPositionReconciler.ADOPTED_PREMIUM_STOP_PCT}%), trail ${BrokerPositionReconciler.ADOPTED_TRAIL_PCT}%]`,
          evidence.signal_id || null,
          evidence.strategy_setup_id || null
        ]
      );
      const positionId = Number(inserted.rows?.[0]?.id);
      const message = `Adopted ${description} (${mismatch.ticker}) under management: our entry #${evidence.id} (${evidence.execution_status}) filled at the broker unseen. Entry ${entryPrice.toFixed(2)}, premium stop ${stop}, ${BrokerPositionReconciler.ADOPTED_TRAIL_PCT}% trail.`;
      await this.record(userId, positionId, 'BROKER_RECONCILE_ADOPTED', message, { ticker: mismatch.ticker, entryPrice, quantity, stop, evidencePositionId: evidence.id });
      publishRealtime('POSITION_UPDATE', { id: positionId, kind: 'lifecycle', status: 'OPEN', execution_status: 'FILLED' }, { userId });
      await this.alert(userId, 'critical', 'broker-reconcile', 'Broker position adopted by reconciler', message, positionId, `reconcile-adopted:${positionId}`, 3600);
      const streamer = (this.fastify as any).ibkrMarketDataStreamer;
      if (streamer?.syncSubscriptions) await streamer.syncSubscriptions().catch(() => undefined);
      return { action: 'ADOPTED', resolved: true, positionId, details: { entryPrice, quantity, stop, evidencePositionId: evidence.id } };
    } catch (err: any) {
      if (String(err?.code) === '23505') {
        const message = `Broker holds ${description} (${mismatch.ticker}); adoption hit the one-position guard (another strategy position exists). Resolve manually. New entries blocked.`;
        await this.alert(userId, 'critical', 'broker-reconcile', 'Broker position adoption blocked by slot guard', message, evidence.id, `reconcile-orphan:${userId}:${mismatch.ticker}`, 30 * 60);
        return { action: 'ALERT_ONLY_SLOT_GUARD', resolved: false, details: { evidencePositionId: evidence.id } };
      }
      throw err;
    }
  }

  private async reconcileQuantity(userId: number, mismatch: Mismatch, now: Date) {
    const position = mismatch.position;
    const brokerUnits = Number(mismatch.holding!.units);
    const dbQuantity = Number(position.quantity || 0);
    const pg = (this.fastify as any).pg;
    if (dbQuantity > brokerUnits) {
      await pg.query(
        `/* reconciler:shrink */
         UPDATE positions SET quantity = $2, contracts_requested = LEAST(COALESCE(contracts_requested, $2), $2),
                notes = COALESCE(notes, '') || $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'OPEN'`,
        [position.id, brokerUnits, ` [Reconciler: quantity ${dbQuantity} -> ${brokerUnits} to match broker holding]`]
      );
      const message = `Position #${position.id} ${position.symbol} ${position.option_type} ${Number(position.strike_price)}: local quantity ${dbQuantity} exceeded the broker holding ${brokerUnits}; shrunk to match.`;
      await this.record(userId, position.id, 'BROKER_RECONCILE_QUANTITY', message, { ticker: mismatch.ticker, from: dbQuantity, to: brokerUnits });
      await this.alert(userId, 'warning', 'broker-reconcile', 'Position quantity reduced to match broker', message, position.id, `reconcile-qty:${position.id}`, 3600);
      return { action: 'SHRUNK_TO_BROKER', resolved: true, positionId: position.id, details: { from: dbQuantity, to: brokerUnits } };
    }
    const message = `Position #${position.id} ${position.symbol} ${position.option_type} ${Number(position.strike_price)}: broker holds ${brokerUnits} contracts but we manage ${dbQuantity}. Extra contracts are unmanaged — resolve manually. New entries blocked.`;
    await this.record(userId, position.id, 'BROKER_RECONCILE_QUANTITY', message, { ticker: mismatch.ticker, db: dbQuantity, broker: brokerUnits });
    await this.alert(userId, 'critical', 'broker-reconcile', 'Broker holds more contracts than managed', message, position.id, `reconcile-qty:${position.id}`, 30 * 60);
    return { action: 'ALERT_ONLY_BROKER_EXCESS', resolved: false, positionId: position.id, details: { db: dbQuantity, broker: brokerUnits } };
  }

  // ----------------------------------------------------------------- helpers

  private describe(mismatch: Mismatch) {
    return {
      position_id: mismatch.position?.id || null,
      db_quantity: mismatch.position ? Number(mismatch.position.quantity || 0) : 0,
      broker_units: mismatch.holding ? Number(mismatch.holding.units) : 0,
      broker_price: mismatch.holding?.price ?? null,
      broker_avg_cost: mismatch.holding?.averagePurchasePrice ?? null
    };
  }

  private async record(userId: number, positionId: number | null, eventType: string, message: string, metadata: any) {
    await TradeRedisService.recordEvent((this.fastify as any).pg, { userId, positionId, eventType, message, metadata: { ...metadata, source: 'broker-reconciler' } })
      .catch((err: any) => this.fastify.log.warn(`[BrokerReconciler] event ${eventType} not recorded: ${err?.message || String(err)}`));
  }

  private async alert(userId: number, severity: 'critical' | 'warning' | 'info', category: string, title: string, message: string, tradeId: number | null, dedupeKey: string, dedupeSeconds: number) {
    await new DiscordAlertService(this.fastify).send({ userId, title, message, severity, category, tradeId, dedupeKey, dedupeSeconds })
      .catch((err: any) => this.fastify.log.warn(`[BrokerReconciler] alert failed: ${err?.message || String(err)}`));
  }

  private newYorkDateKey(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
}
