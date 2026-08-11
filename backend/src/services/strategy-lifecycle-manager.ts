import { FastifyInstance } from 'fastify';

type StrategySnapshot = Record<string, any>;

export class StrategyLifecycleManager {
  constructor(private fastify: FastifyInstance) {}

  async retireSupersededSetup(setupId: string, signal: StrategySnapshot): Promise<void> {
    await (this.fastify as any).pg.query(
      `UPDATE signals
       SET lifecycle_status = 'SUPERSEDED',
           entry_allowed = FALSE,
           status = CASE WHEN status IN ('PENDING', 'PENDING_TRIGGER') THEN 'CANCELLED' ELSE status END
       WHERE strategy_setup_id = $1`,
      [setupId]
    );
    await this.requestManagedExit(setupId, 'SUPERSEDED', signal, ' [Strategy setup superseded by a new frozen plan]');
  }

  async requestTerminalExit(setupId: string, lifecycleStatus: string, signal: StrategySnapshot): Promise<void> {
    await this.requestManagedExit(setupId, lifecycleStatus, signal);
  }

  async submitAutonomousEntry(input: {
    userId: number;
    signalId: number;
    settings: Record<string, string>;
    assertExecutable: (signalId: number) => Promise<void>;
  }): Promise<any> {
    const scanner = (this.fastify as any).scanner;
    if (!scanner?.executeSignalForUser) {
      throw new Error('scanner execution service unavailable');
    }
    await input.assertExecutable(input.signalId);
    return scanner.executeSignalForUser(input.userId, input.signalId, {
      ...input.settings,
      contracts_per_trade: '1'
    });
  }

  private async requestManagedExit(
    setupId: string,
    lifecycleStatus: string,
    signal: StrategySnapshot,
    note = ''
  ): Promise<void> {
    await (this.fastify as any).pg.query(
      `UPDATE positions
       SET strategy_lifecycle_status = $2,
           strategy_snapshot = $3,
           strategy_exit_requested_at = COALESCE(strategy_exit_requested_at, CURRENT_TIMESTAMP),
           strategy_exit_reason = $2,
           notes = COALESCE(notes, '') || $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE strategy_setup_id = $1
         AND strategy_managed = TRUE
         AND status = 'OPEN'`,
      [setupId, lifecycleStatus, JSON.stringify(signal), note]
    );
  }
}
