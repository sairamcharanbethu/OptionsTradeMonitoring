import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { getGlobalSettings } from '../lib/settings-utils';

export type StrategyEngineMode = 'legacy' | 'shadow' | 'primary';

type StrategySnapshot = Record<string, any>;

const ACTIVE_STATES = new Set(['ARMED', 'ACTIVE', 'MANAGE', 'EXTENDED']);
const TERMINAL_STATES = new Set(['COMPLETED', 'INVALIDATED', 'TRACKING_ABORTED', 'FAILED']);

export class StrategyEngineAdapter {
  private readonly mode: StrategyEngineMode = 'primary';
  private readonly dataDir: string;
  private timer: NodeJS.Timeout | null = null;
  private policyTimer: NodeJS.Timeout | null = null;
  private currentSignal: StrategySnapshot | null = null;
  private currentHealth: StrategySnapshot | null = null;
  private currentSetupId: string | null = null;
  private currentPlanFingerprint: string | null = null;
  private lastEventFingerprint: string | null = null;
  private lastReceivedAt: string | null = null;
  private lastError: string | null = null;
  private lastPolicyFingerprint: string | null = null;

  constructor(private fastify: FastifyInstance) {
    this.dataDir = process.env.STRATEGY_DATA_DIR || '/strategy-data/trade';
  }

  public getMode(): StrategyEngineMode {
    return this.mode;
  }

  public async start(): Promise<void> {
    await this.restoreSetupIdentity();
    await this.publishPolicy();
    if (this.mode !== 'legacy') {
      await this.poll();
      this.timer = setInterval(() => {
        this.poll().catch((err: any) => {
          this.lastError = err.message || String(err);
          this.fastify.log.warn(`[StrategyEngineAdapter] ${this.lastError}`);
        });
      }, 250);
    }
    this.policyTimer = setInterval(() => {
      this.publishPolicy().catch((err: any) => {
        this.fastify.log.warn(`[StrategyEngineAdapter] Policy publish failed: ${err.message || String(err)}`);
      });
    }, 5000);
    this.fastify.log.info(`[StrategyEngineAdapter] Started in ${this.mode} mode.`);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.policyTimer) clearInterval(this.policyTimer);
    this.timer = null;
    this.policyTimer = null;
  }

  public getCurrentState() {
    const generatedAt = Number(this.currentSignal?.generated_at || 0);
    const ageSeconds = generatedAt > 0 ? Math.max(0, Date.now() / 1000 - generatedAt) : null;
    return {
      mode: this.mode,
      setupId: this.currentSetupId,
      receivedAt: this.lastReceivedAt,
      ageSeconds,
      error: this.lastError,
      health: this.currentHealth,
      signal: this.currentSignal
    };
  }

  public async assertSignalExecutable(signalId: number): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT strategy_setup_id, engine_version, lifecycle_status, entry_allowed,
              activated_at, strategy_snapshot
       FROM signals
       WHERE id = $1`,
      [signalId]
    );
    if (rows.length === 0 || !rows[0].strategy_setup_id) return;
    if (this.mode !== 'primary') {
      throw this.conflict('The replacement strategy is not in primary mode');
    }

    const row = rows[0];
    const live = this.currentSignal;
    if (!live || live.engine_version !== 'signal-only-v2') {
      throw this.conflict('The live signal-only-v2 snapshot is unavailable');
    }
    if (String(row.strategy_setup_id) !== this.currentSetupId) {
      throw this.conflict('The strategy setup changed after this signal was displayed');
    }
    const lifecycle = live.lifecycle || {};
    if (String(live.state) !== 'ACTIVE' || lifecycle.entry_allowed !== true) {
      throw this.conflict('The strategy is no longer accepting a new entry');
    }
    const signalAge = Date.now() / 1000 - Number(live.generated_at || 0);
    if (!Number.isFinite(signalAge) || signalAge < 0 || signalAge > 20) {
      throw this.conflict('The strategy snapshot is stale');
    }
    const gexAge = this.gexAgeSeconds(live);
    if (gexAge === null || gexAge < 0 || gexAge > 20) {
      throw this.conflict('The authoritative GEX snapshot is stale');
    }
  }

  private conflict(message: string): Error {
    const error: any = new Error(message);
    error.statusCode = 409;
    return error;
  }

  private async poll(): Promise<void> {
    const [signal, health] = await Promise.all([
      this.readJson(path.join(this.dataDir, 'signal.json')),
      this.readJson(path.join(this.dataDir, 'health.json'))
    ]);
    if (!signal) return;
    if (signal.engine_version !== 'signal-only-v2' || signal.execution_enabled !== false) {
      throw new Error('Rejected strategy snapshot with an invalid signal-only contract');
    }
    this.currentHealth = health;
    const snapshotFingerprint = this.hash(signal);
    if (snapshotFingerprint === this.hash(this.currentSignal)) return;

    this.currentSignal = signal;
    this.lastReceivedAt = new Date().toISOString();
    this.lastError = null;
    this.updateSetupIdentity(signal);

    const eventFingerprint = this.eventFingerprint(signal);
    if (eventFingerprint === this.lastEventFingerprint) return;
    await this.persistEvent(signal, eventFingerprint);
    this.lastEventFingerprint = eventFingerprint;

    if (this.mode === 'primary') {
      await this.persistPrimarySignal(signal);
    }
    this.broadcast({
      type: 'STRATEGY_STATE_CHANGED',
      data: this.getCurrentState()
    });
    if (this.isTerminal(signal)) {
      this.currentPlanFingerprint = null;
      this.currentSetupId = null;
    }
  }

  private async readJson(filePath: string): Promise<StrategySnapshot | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  private updateSetupIdentity(signal: StrategySnapshot): void {
    const planFingerprint = this.planFingerprint(signal);
    if (!planFingerprint) {
      return;
    }
    if (planFingerprint !== this.currentPlanFingerprint) {
      this.currentPlanFingerprint = planFingerprint;
      this.currentSetupId = randomUUID();
    }
  }

  private planFingerprint(signal: StrategySnapshot): string | null {
    const side = String(signal.favoring || '');
    if (!['calls', 'puts'].includes(side)) return null;
    const setup = side === 'calls' ? signal.call_setup : signal.put_setup;
    if (!setup || !setup.trigger || !ACTIVE_STATES.has(String(signal.state || ''))) return null;
    return this.hash({
      engine: signal.engine_version,
      marketDate: new Date(Number(signal.generated_at || 0) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      strategy: signal.strategy,
      side,
      trigger: setup.trigger,
      invalidation: setup.invalidation,
      targets: setup.targets,
      option: {
        symbol: setup.option?.local_symbol,
        strike: setup.option?.strike,
        expiry: setup.option?.expiry
      }
    });
  }

  private eventFingerprint(signal: StrategySnapshot): string {
    const lifecycle = signal.lifecycle || {};
    return this.hash({
      mode: this.mode,
      setupId: this.currentSetupId,
      state: signal.state,
      phase: signal.signal_phase,
      strategy: signal.strategy,
      side: signal.favoring,
      entryAllowed: lifecycle.entry_allowed === true,
      targetsHit: lifecycle.targets_hit || 0,
      premiumLockArmed: lifecycle.premium_lock_armed === true,
      protectedInvalidation: lifecycle.protected_invalidation || null,
      blockers: signal.blockers || [],
      policyFingerprint: signal.policy_fingerprint || null
    });
  }

  private async persistEvent(signal: StrategySnapshot, eventFingerprint: string): Promise<void> {
    await (this.fastify as any).pg.query(
      `INSERT INTO strategy_signal_events (
         setup_id, engine_version, mode, lifecycle_status, event_fingerprint,
         policy_fingerprint, signal_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_fingerprint) DO NOTHING`,
      [
        this.currentSetupId,
        signal.engine_version,
        this.mode,
        String(signal.state || 'WAIT'),
        eventFingerprint,
        signal.policy_fingerprint || null,
        JSON.stringify(signal)
      ]
    );
  }

  private async persistPrimarySignal(signal: StrategySnapshot): Promise<void> {
    const state = String(signal.state || 'WAIT');
    if (!this.currentSetupId) return;
    if (this.isTerminal(signal)) {
      await (this.fastify as any).pg.query(
        `UPDATE signals
         SET lifecycle_status = $2,
             entry_allowed = FALSE,
             strategy_snapshot = $3,
             status = CASE WHEN status IN ('PENDING', 'PENDING_TRIGGER') THEN 'CANCELLED' ELSE status END
         WHERE strategy_setup_id = $1`,
        [this.currentSetupId, state, JSON.stringify(signal)]
      );
      return;
    }
    if (!ACTIVE_STATES.has(state)) return;

    const side = signal.favoring === 'puts' ? 'PUT' : 'CALL';
    const setup = side === 'CALL' ? signal.call_setup || {} : signal.put_setup || {};
    const option = setup.option || {};
    const lifecycle = signal.lifecycle || {};
    const expiry = this.normalizeExpiry(option.expiry);
    const target = Array.isArray(setup.targets) ? setup.targets[0] : null;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(signal.confidence_score || 0))));
    await (this.fastify as any).pg.query(
      `INSERT INTO signals (
         symbol, signal_type, trade_bias, current_price, entry_trigger, stop_loss,
         target_price, confidence_score, setup_grade, status, indicators, gex,
         no_trade_reasons, option_expiration_date, market_date, option_details,
         engine_version, strategy_name, strategy_setup_id, lifecycle_status,
         entry_allowed, activated_at, policy_fingerprint, strategy_snapshot
       ) VALUES (
         'SPY', $1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $10, $11,
         $12, $13, $14, $15, $2, $16, $8, $17, $18, $19, $20
       )
       ON CONFLICT (strategy_setup_id) DO UPDATE
       SET current_price = EXCLUDED.current_price,
           lifecycle_status = EXCLUDED.lifecycle_status,
           entry_allowed = EXCLUDED.entry_allowed,
           activated_at = EXCLUDED.activated_at,
           indicators = EXCLUDED.indicators,
           gex = EXCLUDED.gex,
           no_trade_reasons = EXCLUDED.no_trade_reasons,
           option_details = EXCLUDED.option_details,
           policy_fingerprint = EXCLUDED.policy_fingerprint,
           strategy_snapshot = EXCLUDED.strategy_snapshot`,
      [
        side,
        String(signal.strategy || 'signal-only-v2'),
        Number(signal.spot || 0),
        setup.trigger || null,
        setup.invalidation || null,
        target || null,
        confidence,
        state,
        JSON.stringify({ strategy: signal.strategy, confirmations: signal.confirmations || [], lifecycle }),
        JSON.stringify(signal.gex || {}),
        signal.blockers || [],
        expiry,
        expiry || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        JSON.stringify({
          ticker: option.local_symbol || null,
          strike: option.strike || null,
          expiry,
          mark: option.mid || null,
          bid: option.bid || null,
          ask: option.ask || null,
          setupId: this.currentSetupId,
          lifecycle
        }),
        signal.engine_version,
        this.currentSetupId,
        lifecycle.entry_allowed === true,
        lifecycle.activated_at ? new Date(Number(lifecycle.activated_at) * 1000) : null,
        signal.policy_fingerprint || null,
        JSON.stringify(signal)
      ]
    );
  }

  private async restoreSetupIdentity(): Promise<void> {
    try {
      const { rows } = await (this.fastify as any).pg.query(
        `SELECT setup_id, signal_snapshot
         FROM strategy_signal_events
         WHERE setup_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 20`
      );
      for (const row of rows) {
        const fingerprint = this.planFingerprint(row.signal_snapshot || {});
        if (fingerprint) {
          this.currentSetupId = String(row.setup_id);
          this.currentPlanFingerprint = fingerprint;
          return;
        }
      }
    } catch (err: any) {
      this.fastify.log.warn(`[StrategyEngineAdapter] Setup restore skipped: ${err.message || String(err)}`);
    }
  }

  private async publishPolicy(): Promise<void> {
    const settings = await getGlobalSettings((this.fastify as any).pg);
    const policy = {
      strategy_max_total_debit_dollars: this.numberInRange(
        settings.strategy_max_total_debit_dollars || process.env.STRATEGY_MAX_TOTAL_DEBIT_DOLLARS,
        500,
        1,
        100000
      ),
      strategy_preferred_contracts: this.numberInRange(
        settings.strategy_preferred_contracts || process.env.STRATEGY_PREFERRED_CONTRACTS,
        1,
        1,
        5
      ),
      strategy_max_contracts: this.numberInRange(
        settings.strategy_max_contracts || process.env.STRATEGY_MAX_CONTRACTS,
        1,
        1,
        5
      )
    };
    policy.strategy_preferred_contracts = Math.min(
      policy.strategy_preferred_contracts,
      policy.strategy_max_contracts
    );
    const fingerprint = this.hash(policy);
    if (fingerprint === this.lastPolicyFingerprint) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, 'policy.json');
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(policy));
    await fs.rename(temporary, target);
    this.lastPolicyFingerprint = fingerprint;
  }

  private numberInRange(value: any, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  private gexAgeSeconds(signal: StrategySnapshot): number | null {
    const providerAge = Number(signal.gex?.provider_age_seconds);
    if (Number.isFinite(providerAge)) return providerAge;
    const zeroGexProviderAge = Number(signal.zerogex_shadow?.provider_age_seconds);
    if (Number.isFinite(zeroGexProviderAge)) return zeroGexProviderAge;
    const freshness = signal.zerogex_shadow?.data_freshness?.gex_summary;
    const age = Number(freshness?.adjusted_age_seconds ?? freshness?.age_seconds);
    if (Number.isFinite(age)) return age;
    const timestamp = Number(signal.gex?.provider_timestamp || signal.gex?.fetched_at);
    return Number.isFinite(timestamp) && timestamp > 0 ? Date.now() / 1000 - timestamp : null;
  }

  private isTerminal(signal: StrategySnapshot): boolean {
    return TERMINAL_STATES.has(String(signal.state || ''))
      || TERMINAL_STATES.has(String(signal.signal_phase || ''));
  }

  private normalizeExpiry(value: any): string | null {
    const text = String(value || '');
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    return null;
  }

  private hash(value: any): string {
    if (value === null || value === undefined) return '';
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private broadcast(message: any): void {
    const websocketServer = (this.fastify as any).websocketServer;
    if (!websocketServer) return;
    for (const client of websocketServer.clients) {
      if ((client as any).readyState === 1) {
        (client as any).send(JSON.stringify(message));
      }
    }
  }
}
