type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

export type ExitExecutionStatus = 'PENDING_EXIT' | 'PENDING_TRIM';
export type OptionEntryAction = 'BUY_TO_OPEN' | 'SELL_TO_OPEN';
export type OptionExitAction = 'SELL_TO_CLOSE' | 'BUY_TO_CLOSE';
export type EntryOrderState =
  | 'SUBMITTED'
  | 'PENDING_RECONCILE'
  | 'STALE'
  | 'REVIEW_REQUIRED';

export type EntryOrderDecision = {
  state: EntryOrderState;
  executionStatus: string;
  message: string;
  noteLabel: string;
};

export type ExitRetryDecision = {
  allowed: boolean;
  reason?: string;
};

export class TradeLifecycleService {
  static readonly MAX_EXIT_RETRIES = Number(process.env.MAX_EXIT_RETRIES || 2);
  static readonly AUTO_EXIT_RETRY_EVIDENCE_MAX_AGE_MS = 120_000;
  static readonly FINAL_ENTRY_EXECUTION_STATUSES = ['EXECUTED', 'FILLED', 'FILLED_FULLY', 'ENTRY_STALE', 'ENTRY_RECONCILE_REQUIRED'];

  static entrySubmittedStatus(orderType: 'MARKET' | 'LIMIT'): EntryOrderDecision {
    if (orderType === 'LIMIT') {
      return {
        state: 'PENDING_RECONCILE',
        executionStatus: 'PENDING_RECONCILE',
        message: 'Protected limit entry submitted; broker reconciliation is required before treating it as filled.',
        noteLabel: 'protected limit entry pending reconciliation'
      };
    }
    return {
      state: 'SUBMITTED',
      executionStatus: 'PENDING',
      message: 'Market entry submitted; broker reconciliation is required before treating it as filled.',
      noteLabel: 'market entry pending reconciliation'
    };
  }

  static exitActionForEntryAction(action?: string | null): OptionExitAction {
    return String(action || '').toUpperCase() === 'SELL_TO_OPEN' ? 'BUY_TO_CLOSE' : 'SELL_TO_CLOSE';
  }

  static getEntryAction(position: any): OptionEntryAction {
    return String(position?.entry_action || '').toUpperCase() === 'SELL_TO_OPEN' ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN';
  }

  static getExitAction(position: any): OptionExitAction {
    const configured = String(position?.exit_action || '').toUpperCase();
    if (configured === 'BUY_TO_CLOSE') return 'BUY_TO_CLOSE';
    if (configured === 'SELL_TO_CLOSE') return 'SELL_TO_CLOSE';
    return this.exitActionForEntryAction(position?.entry_action);
  }

  static isShortPremiumPosition(position: any): boolean {
    return this.getEntryAction(position) === 'SELL_TO_OPEN';
  }

  static calculateRealizedPnl(position: any, exitPrice: number, quantity: number): number {
    const entryPrice = Number(position?.entry_price || 0);
    const multiplier = this.isShortPremiumPosition(position) ? -1 : 1;
    return (Number(exitPrice || 0) - entryPrice) * Number(quantity || 0) * 100 * multiplier;
  }

  // Running max-favorable / max-adverse excursion (in premium terms) as a new
  // mark arrives. `changed` is true when either extreme moved, so callers can
  // persist only on change. Shared by the live (market-poller) and paper
  // (paper-trading-service) monitor loops so both record MFE/MAE identically.
  static calculateTradeExcursion(position: any, price: number): {
    maxFavorablePrice: number; maxAdversePrice: number; mfePct: number; maePct: number; changed: boolean;
  } {
    const entryPrice = Number(position?.entry_price || 0);
    const observedPrice = Number(price);
    const shortPremium = this.isShortPremiumPosition(position);
    const priorFavorable = Number(position?.max_favorable_price || entryPrice);
    const priorAdverse = Number(position?.max_adverse_price || entryPrice);
    const maxFavorablePrice = shortPremium ? Math.min(priorFavorable, observedPrice) : Math.max(priorFavorable, observedPrice);
    const maxAdversePrice = shortPremium ? Math.max(priorAdverse, observedPrice) : Math.min(priorAdverse, observedPrice);
    const mfePct = entryPrice > 0
      ? Number(((shortPremium ? (entryPrice - maxFavorablePrice) : (maxFavorablePrice - entryPrice)) / entryPrice * 100).toFixed(4))
      : 0;
    const maePct = entryPrice > 0
      ? Number(((shortPremium ? (maxAdversePrice - entryPrice) : (entryPrice - maxAdversePrice)) / entryPrice * 100).toFixed(4))
      : 0;
    return {
      maxFavorablePrice, maxAdversePrice, mfePct, maePct,
      changed: maxFavorablePrice !== priorFavorable || maxAdversePrice !== priorAdverse
    };
  }

  static isUnderlyingStopBroken(position: any, underlyingPrice: number | null | undefined, underlyingStop: number | null | undefined): boolean {
    if (!underlyingPrice || !underlyingStop) return false;
    const optionType = String(position?.option_type || '').toUpperCase();
    const shortPremium = this.isShortPremiumPosition(position);
    if (optionType === 'CALL') return shortPremium ? underlyingPrice >= underlyingStop : underlyingPrice <= underlyingStop;
    if (optionType === 'PUT') return shortPremium ? underlyingPrice <= underlyingStop : underlyingPrice >= underlyingStop;
    return false;
  }

  static staleEntryDecision(currentExecutionStatus?: string | null): EntryOrderDecision {
    if (currentExecutionStatus === 'PENDING_RECONCILE' || ['FILLED', 'FILLED_FULLY'].includes(String(currentExecutionStatus || '').toUpperCase())) {
      return {
        state: 'REVIEW_REQUIRED',
        executionStatus: 'ENTRY_RECONCILE_REQUIRED',
        message: currentExecutionStatus === 'PENDING_RECONCILE'
          ? 'Protected limit entry is still pending after watchdog timeout; broker reconciliation is required before another entry.'
          : 'Broker reports this entry as filled, but the local position is still pending; reconciliation is required before another entry.',
        noteLabel: currentExecutionStatus === 'PENDING_RECONCILE'
          ? 'protected limit entry reconcile-required'
          : 'broker-reported fill reconcile-required'
      };
    }
    return {
      state: 'STALE',
      executionStatus: 'ENTRY_STALE',
      message: 'Entry order is still pending after watchdog timeout; broker reconciliation is required before another entry.',
      noteLabel: 'entry stale'
    };
  }

  static isFinalEntryExecutionStatus(status?: string | null): boolean {
    return this.FINAL_ENTRY_EXECUTION_STATUSES.includes(String(status || ''));
  }

  static isPendingExitStatus(status?: string | null): boolean {
    return ['PENDING_EXIT', 'PENDING_TRIM'].includes(String(status || ''));
  }

  static isBrokerExitReviewStatus(status?: string | null): boolean {
    return String(status || '').startsWith('EXIT_');
  }

  static isRetryableExitStatus(status?: string | null): boolean {
    return ['EXIT_RETRYABLE', 'EXIT_REJECTED', 'EXIT_FAILED', 'EXIT_CANCELED', 'EXIT_CANCELLED', 'EXIT_EXPIRED', 'EXIT_STALE'].includes(String(status || ''));
  }

  static assertCanRequestExit(position: any) {
    if (!position) throw new Error('Position not found');
    if (position.status !== 'OPEN') throw new Error('Only open positions can request an exit');
    if (this.isPendingExitStatus(position.execution_status)) {
      throw new Error('An exit or trim order is already pending for this position');
    }
    if (this.isBrokerExitReviewStatus(position.execution_status)) {
      throw new Error(`Previous exit order is ${position.execution_status}. Verify broker status before submitting another close.`);
    }
  }

  static canRetryExit(position: any): ExitRetryDecision {
    if (!position) return { allowed: false, reason: 'Position not found' };
    if (position.status !== 'OPEN') return { allowed: false, reason: 'Only open positions can retry an exit' };
    if (!this.isRetryableExitStatus(position.execution_status)) {
      return { allowed: false, reason: `Exit retry is not allowed while status is ${position.execution_status || 'empty'}` };
    }
    if (!position.broker_exit_order_id && position.execution_status !== 'EXIT_RETRYABLE') {
      return { allowed: false, reason: 'No previous broker exit order id is attached to this position' };
    }
    const retryCount = Number(position.exit_retry_count || 0);
    if (retryCount >= this.MAX_EXIT_RETRIES) {
      return { allowed: false, reason: `Exit retry limit reached (${retryCount}/${this.MAX_EXIT_RETRIES})` };
    }
    return { allowed: true };
  }

  static canAutoRetryExit(position: any): ExitRetryDecision {
    const retryDecision = this.canRetryExit(position);
    if (!retryDecision.allowed) return retryDecision;

    const executionStatus = String(position.execution_status || '').toUpperCase();
    if (executionStatus === 'EXIT_RETRYABLE') {
      if (position.broker_exit_order_id || position.broker_exit_trade_id) {
        return { allowed: false, reason: 'A broker order id exists, so the failed submission must be reconciled before autonomous retry' };
      }
      return { allowed: true };
    }

    const terminalBrokerStatuses: Record<string, string[]> = {
      EXIT_REJECTED: ['REJECTED'],
      EXIT_FAILED: ['FAILED'],
      EXIT_CANCELED: ['CANCELED', 'CANCELLED'],
      EXIT_CANCELLED: ['CANCELED', 'CANCELLED'],
      EXIT_EXPIRED: ['EXPIRED'],
      // A stale-marked limit exit whose broker order is since CONFIRMED dead
      // (canceled/expired/rejected by broker sync) is safe to retry — without
      // this, EXIT_STALE was a permanent human dead-end even after the broker
      // confirmed nothing was working anymore.
      EXIT_STALE: ['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED']
    };
    const allowedBrokerStatuses = terminalBrokerStatuses[executionStatus];
    if (!allowedBrokerStatuses) {
      return { allowed: false, reason: `${executionStatus || 'Unknown exit state'} is not safe for autonomous retry` };
    }

    const brokerStatus = String(position.last_broker_order_status || '').toUpperCase();
    if (!allowedBrokerStatuses.includes(brokerStatus)) {
      return { allowed: false, reason: `Latest broker status is ${brokerStatus || 'missing'}, not a confirmed terminal ${executionStatus}` };
    }
    const brokerSyncAtMs = position.last_broker_sync_at ? new Date(position.last_broker_sync_at).getTime() : NaN;
    if (!Number.isFinite(brokerSyncAtMs) || Date.now() - brokerSyncAtMs > this.AUTO_EXIT_RETRY_EVIDENCE_MAX_AGE_MS) {
      return { allowed: false, reason: 'Terminal broker status is stale; refresh Wealthsimple before autonomous retry' };
    }
    return { allowed: true };
  }

  static async markBrokerSynced(db: Queryable, positionId: number | string, brokerStatus?: string | null) {
    await db.query(
      `UPDATE positions
       SET last_broker_sync_at = CURRENT_TIMESTAMP,
           last_broker_order_status = COALESCE($1, last_broker_order_status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [brokerStatus || null, positionId]
    );
  }

  static async markExitSubmitted(db: Queryable, positionId: number | string, order: { orderId?: string | null; tradeId?: string | null }, options: {
    reason: string;
    orderType: 'MARKET' | 'LIMIT';
    note: string;
    incrementRetry?: boolean;
    trimQuantity?: number | null;
  }) {
    const trimQuantity = Number(options.trimQuantity || 0);
    const hasTrimQuantity = Number.isFinite(trimQuantity) && trimQuantity > 0;
    const { rows } = await db.query(
      `UPDATE positions
       SET execution_status = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN 'PENDING_TRIM' ELSE 'PENDING_EXIT' END,
           execution_error = NULL,
           broker_exit_order_id = $1,
           broker_exit_trade_id = $2,
           exit_reason = $3,
           exit_order_type = $4,
           exit_requested_at = CURRENT_TIMESTAMP,
           exit_retry_count = COALESCE(exit_retry_count, 0) + $5,
           profit_trim_status = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN 'PENDING' ELSE profit_trim_status END,
           profit_trim_quantity = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN $8::integer ELSE NULL END,
           profit_trim_order_id = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN $1 ELSE NULL END,
           profit_trim_trade_id = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN $2 ELSE NULL END,
           notes = COALESCE(notes, '') || $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
         AND status = 'OPEN'
         AND COALESCE(execution_status, '') NOT IN ('PENDING_EXIT', 'PENDING_TRIM')
       RETURNING *`,
      [
        order.orderId || null,
        order.tradeId || null,
        options.reason,
        options.orderType,
        options.incrementRetry ? 1 : 0,
        options.note,
        positionId,
        hasTrimQuantity ? Math.floor(trimQuantity) : null
      ]
    );
    if (!rows[0]) throw new Error('Position state changed before the exit order could be recorded');
    return rows[0];
  }

  static async markExitSubmissionFailure(
    db: Queryable,
    positionId: number | string,
    message: string,
    notePrefix = 'Exit submission failed',
    options: { ambiguous?: boolean; orderId?: string | null; tradeId?: string | null; requestedQuantity?: number | null } = {}
  ) {
    const executionStatus = options.ambiguous ? 'EXIT_RECONCILE_REQUIRED' : 'EXIT_RETRYABLE';
    const requestedQuantity = Number(options.requestedQuantity);
    const persistedQuantity = Number.isFinite(requestedQuantity) && requestedQuantity > 0
      ? Math.floor(requestedQuantity)
      : null;
    await db.query(
      `UPDATE positions
       SET execution_status = $1,
           execution_error = $2,
           broker_exit_order_id = COALESCE($3, broker_exit_order_id),
           broker_exit_trade_id = COALESCE($4, broker_exit_trade_id),
           profit_trim_quantity = COALESCE($5, profit_trim_quantity),
           notes = COALESCE(notes, '') || $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
         AND status = 'OPEN'`,
      [executionStatus, message, options.orderId || null, options.tradeId || null, persistedQuantity, ` [${notePrefix}: ${message}]`, positionId]
    );
  }

  static async markLimitExitStale(db: Queryable, positionId: number | string, message: string) {
    await db.query(
      `UPDATE positions
       SET execution_status = 'EXIT_STALE',
           execution_error = $1,
           notes = COALESCE(notes, '') || $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
         AND status = 'OPEN'
         AND execution_status IN ('PENDING_EXIT', 'PENDING_TRIM')`,
      [message, ` [Limit exit marked stale: ${message}]`, positionId]
    );
  }
}
