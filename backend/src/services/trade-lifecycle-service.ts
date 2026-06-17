type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

export type ExitExecutionStatus = 'PENDING_EXIT' | 'PENDING_TRIM';

export class TradeLifecycleService {
  static isPendingExitStatus(status?: string | null): boolean {
    return ['PENDING_EXIT', 'PENDING_TRIM'].includes(String(status || ''));
  }

  static isBrokerExitReviewStatus(status?: string | null): boolean {
    return String(status || '').startsWith('EXIT_');
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
