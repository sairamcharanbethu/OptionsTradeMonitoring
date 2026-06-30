type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

export type ExitExecutionStatus = 'PENDING_EXIT' | 'PENDING_TRIM';
export type EntryOrderState =
  | 'LOCAL_BLOCKED'
  | 'SUBMITTED'
  | 'PENDING_RECONCILE'
  | 'ACCEPTED'
  | 'FILLED'
  | 'REJECTED'
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

  static staleEntryDecision(currentExecutionStatus?: string | null): EntryOrderDecision {
    if (currentExecutionStatus === 'PENDING_RECONCILE') {
      return {
        state: 'REVIEW_REQUIRED',
        executionStatus: 'ENTRY_RECONCILE_REQUIRED',
        message: 'Protected limit entry is still pending after watchdog timeout; broker reconciliation is required before another entry.',
        noteLabel: 'protected limit entry reconcile-required'
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
    return ['EXIT_REJECTED', 'EXIT_FAILED', 'EXIT_CANCELED', 'EXIT_CANCELLED', 'EXIT_EXPIRED', 'EXIT_STALE'].includes(String(status || ''));
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
    if (!position.broker_exit_order_id) return { allowed: false, reason: 'No previous broker exit order id is attached to this position' };
    if (!this.isRetryableExitStatus(position.execution_status)) {
      return { allowed: false, reason: `Exit retry is not allowed while status is ${position.execution_status || 'empty'}` };
    }
    const retryCount = Number(position.exit_retry_count || 0);
    if (retryCount >= this.MAX_EXIT_RETRIES) {
      return { allowed: false, reason: `Exit retry limit reached (${retryCount}/${this.MAX_EXIT_RETRIES})` };
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
           profit_trim_quantity = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN $8::integer ELSE profit_trim_quantity END,
           profit_trim_order_id = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN $1 ELSE profit_trim_order_id END,
           profit_trim_trade_id = CASE WHEN $8::integer IS NOT NULL AND $8::integer < quantity THEN $2 ELSE profit_trim_trade_id END,
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

  static async markExitSubmissionFailure(db: Queryable, positionId: number | string, message: string, notePrefix = 'Exit submission failed') {
    await db.query(
      `UPDATE positions
       SET execution_status = 'EXIT_FAILED',
           execution_error = $1,
           notes = COALESCE(notes, '') || $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
         AND status = 'OPEN'`,
      [message, ` [${notePrefix}: ${message}]`, positionId]
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
