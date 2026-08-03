import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { getGlobalSettings } from '../lib/settings-utils';
import { getIbkrGatewayConfig } from '../lib/ibkr-config';
import { DiscordAlertService } from './discord-alert-service';

export type StrategyEngineMode = 'legacy' | 'shadow' | 'primary';

type StrategySnapshot = Record<string, any>;

const ACTIVE_STATES = new Set(['ARMED', 'ACTIVE', 'MANAGE', 'EXTENDED']);
const TERMINAL_STATES = new Set(['COMPLETED', 'INVALIDATED', 'TRACKING_ABORTED', 'FAILED']);
const MAX_GEX_PROVIDER_AGE_SECONDS = 120;

export class StrategyEngineAdapter {
  private readonly mode: StrategyEngineMode = 'primary';
  private readonly dataDir: string;
  private timer: NodeJS.Timeout | null = null;
  private policyTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private redisSubscriber: Redis | null = null;
  private redisStatus: 'DISABLED' | 'CONNECTING' | 'UP' | 'DEGRADED' = 'DISABLED';
  private lastRedisEventAt: string | null = null;
  private lastRedisErrorLogAt = 0;
  private lastFallbackPollAt = 0;
  private currentSignal: StrategySnapshot | null = null;
  private currentHealth: StrategySnapshot | null = null;
  private currentSetupId: string | null = null;
  private currentPlanFingerprint: string | null = null;
  private lastEventFingerprint: string | null = null;
  private lastReceivedAt: string | null = null;
  private lastError: string | null = null;
  private lastPolicyFingerprint: string | null = null;
  private lastZeroGexKeyFingerprint: string | null = null;

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
      await this.requestRefresh();
      this.startRedisSubscription();
      const fallbackIntervalMs = Math.max(500, Number(process.env.STRATEGY_FILE_POLL_INTERVAL_MS || 2000));
      this.timer = setInterval(() => {
        const now = Date.now();
        const fallbackWatchdogMs = Math.max(
          fallbackIntervalMs,
          Number(process.env.STRATEGY_REDIS_WATCHDOG_INTERVAL_MS || 30000)
        );
        if (this.redisStatus === 'UP' && now - this.lastFallbackPollAt < fallbackWatchdogMs) return;
        this.lastFallbackPollAt = now;
        this.requestRefresh().catch((err: any) => {
          this.lastError = err.message || String(err);
          this.fastify.log.warn(`[StrategyEngineAdapter] ${this.lastError}`);
        });
      }, fallbackIntervalMs);
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
    if (this.redisSubscriber) {
      this.redisSubscriber.disconnect();
      this.redisSubscriber = null;
    }
  }

  public getCurrentState() {
    const generatedAt = Number(this.currentSignal?.generated_at || 0);
    const ageSeconds = generatedAt > 0 ? Date.now() / 1000 - generatedAt : null;
    return {
      mode: this.mode,
      setupId: this.currentSetupId,
      receivedAt: this.lastReceivedAt,
      ageSeconds,
      error: this.lastError,
      health: this.currentHealth,
      signal: this.currentSignal,
      transport: {
        redis: this.redisStatus,
        lastRedisEventAt: this.lastRedisEventAt,
        filePollFallback: true,
        filePollIntervalMs: Number(process.env.STRATEGY_FILE_POLL_INTERVAL_MS || 2000),
        redisWatchdogIntervalMs: Number(process.env.STRATEGY_REDIS_WATCHDOG_INTERVAL_MS || 30000)
      }
    };
  }

  private startRedisSubscription(): void {
    if (process.env.NODE_ENV === 'test') return;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return;
    const channel = process.env.STRATEGY_REDIS_CHANNEL || 'strategy:state-changed';
    this.redisStatus = 'CONNECTING';
    const subscriber = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5000)
    });
    this.redisSubscriber = subscriber;
    subscriber.on('ready', () => {
      subscriber.subscribe(channel)
        .then(() => {
          this.redisStatus = 'UP';
          this.fastify.log.info(`[StrategyEngineAdapter] Redis notifications subscribed on ${channel}.`);
        })
        .catch((err: any) => {
          this.markRedisDegraded(`Redis subscribe failed: ${err.message || String(err)}`);
        });
    });
    subscriber.on('message', (receivedChannel) => {
      if (receivedChannel !== channel) return;
      this.lastRedisEventAt = new Date().toISOString();
      this.requestRefresh().catch((err: any) => {
        this.lastError = err.message || String(err);
        this.fastify.log.warn(`[StrategyEngineAdapter] Redis-triggered refresh failed: ${this.lastError}`);
      });
    });
    subscriber.on('error', (err: any) => {
      this.markRedisDegraded(`Redis notifications unavailable; file polling remains active: ${err.message || String(err)}`);
    });
    subscriber.connect().catch((err: any) => {
      this.markRedisDegraded(`Redis notification connection deferred: ${err.message || String(err)}`);
    });
  }

  private markRedisDegraded(message: string): void {
    this.redisStatus = 'DEGRADED';
    const now = Date.now();
    if (now - this.lastRedisErrorLogAt < 60_000) return;
    this.lastRedisErrorLogAt = now;
    this.fastify.log.warn(`[StrategyEngineAdapter] ${message}`);
  }

  private requestRefresh(): Promise<void> {
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      do {
        this.refreshQueued = false;
        await this.poll();
      } while (this.refreshQueued);
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
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
    if (!this.authoritativeGexFresh(live, gexAge)) {
      throw this.conflict('The authoritative GEX snapshot is stale');
    }
    const quoteAge = this.optionQuoteAgeSeconds(live);
    if (quoteAge === null || quoteAge < 0 || quoteAge > 15) {
      throw this.conflict('The selected option quote is stale or missing');
    }
  }

  public async assertSignalReviewable(signalId: number): Promise<{
    optionQuoteFresh: boolean;
    optionQuoteAgeSeconds: number | null;
  }> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT strategy_setup_id
       FROM signals
       WHERE id = $1 AND engine_version = 'signal-only-v2'`,
      [signalId]
    );
    if (rows.length === 0 || !rows[0].strategy_setup_id) {
      throw this.conflict('The strategy setup is unavailable for review');
    }
    const live = this.currentSignal;
    if (!live || String(rows[0].strategy_setup_id) !== this.currentSetupId) {
      throw this.conflict('The strategy setup changed before the AI review started');
    }
    const signalAge = Date.now() / 1000 - Number(live.generated_at || 0);
    if (!Number.isFinite(signalAge) || signalAge < 0 || signalAge > 20) {
      throw this.conflict('The strategy snapshot is stale');
    }
    const gexAge = this.gexAgeSeconds(live);
    if (!this.authoritativeGexFresh(live, gexAge)) {
      throw this.conflict('The authoritative GEX snapshot is stale');
    }
    const quoteAge = this.optionQuoteAgeSeconds(live);
    return {
      optionQuoteFresh: quoteAge !== null && quoteAge >= 0 && quoteAge <= 15,
      optionQuoteAgeSeconds: quoteAge
    };
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
    const paperSetupId = this.currentSetupId;
    if (paperSetupId && (this.fastify as any).paperTrading) {
      (this.fastify as any).paperTrading.processSnapshot(signal, paperSetupId).catch((err: any) => {
        this.fastify.log.warn(`[PaperTrading] Snapshot processing failed: ${err.message || String(err)}`);
      });
    }
    this.broadcast({
      type: 'STRATEGY_SNAPSHOT_UPDATED',
      data: this.getCurrentState()
    });

    const eventFingerprint = this.eventFingerprint(signal);
    if (eventFingerprint === this.lastEventFingerprint) return;
    const eventInserted = await this.persistEvent(signal, eventFingerprint);
    this.lastEventFingerprint = eventFingerprint;

    if (this.mode === 'primary') {
      await this.persistPrimarySignal(signal);
    }
    if (eventInserted) {
      this.notifyStrategyLifecycle(signal).catch((err: any) => {
        this.fastify.log.warn(`[StrategyEngineAdapter] Discord lifecycle alert failed: ${err.message || String(err)}`);
      });
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

  private async persistEvent(signal: StrategySnapshot, eventFingerprint: string): Promise<boolean> {
    const result = await (this.fastify as any).pg.query(
      `INSERT INTO strategy_signal_events (
         setup_id, engine_version, mode, lifecycle_status, event_fingerprint,
         policy_fingerprint, signal_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_fingerprint) DO NOTHING
       RETURNING id`,
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
    return (result.rows?.length || 0) > 0;
  }

  private strategyAlert(signal: StrategySnapshot): {
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    category: string;
    eventKey: string;
  } | null {
    const state = String(signal.state || signal.signal_phase || 'WAIT').toUpperCase();
    const lifecycle = signal.lifecycle || {};
    const side = signal.favoring === 'calls' ? 'CALL' : signal.favoring === 'puts' ? 'PUT' : null;
    const setup = side === 'CALL' ? signal.call_setup || {} : side === 'PUT' ? signal.put_setup || {} : {};
    const option = setup.option || {};
    const targetsHit = Math.max(0, Number(lifecycle.targets_hit || 0));
    const strategyNames: Record<string, string> = {
      MTF_TREND_BREAK: 'multi-timeframe trend breakout',
      MTF_REVERSAL: 'multi-timeframe reversal',
      GEX_REJECTION: 'GEX level rejection',
      CONTINUATION: 'trend continuation'
    };
    const strategyCode = String(signal.strategy || 'setup').toUpperCase();
    const strategyName = strategyNames[strategyCode] || strategyCode.toLowerCase().replace(/_/g, ' ');
    const direction = side === 'CALL' ? 'bullish CALL' : side === 'PUT' ? 'bearish PUT' : 'directional';
    const price = (value: any) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : 'unavailable';
    };
    const targetNumber = Math.max(1, Number(option.exit_target_number || signal.paper_policy?.exit_after_target || 2));
    const targets = Array.isArray(setup.targets) ? setup.targets : [];
    const target = targets[Math.min(targetNumber, targets.length) - 1] ?? targets[0];
    const plannedContracts = Math.max(0, Number(option.planned_contracts || 0));
    const plannedLimit = Math.max(0, Number(option.planned_limit_price || option.mark || 0));
    const plannedDebit = Math.max(0, Number(option.planned_total_debit || (plannedContracts * plannedLimit * 100)));
    const triggerVerb = side === 'PUT' ? 'falls to or below' : 'rises to or above';
    const invalidationVerb = side === 'PUT' ? 'rises to or above' : 'falls to or below';
    const contract = option.local_symbol || option.ticker || 'not selected yet';
    const why = strategyCode === 'MTF_TREND_BREAK'
      ? 'The 5-minute, 15-minute, and 1-hour trends point in the same direction, with price on the confirming side of VWAP.'
      : Array.isArray(signal.confirmations) && signal.confirmations[0]
        ? String(signal.confirmations[0])
        : 'The strategy confirmation gates aligned.';
    const plan = [
      `Setup: ${direction} — ${strategyName}`,
      `Why: ${why}`,
      `Trigger: SPY ${triggerVerb} ${price(setup.trigger)}`,
      `Invalidation: SPY ${invalidationVerb} ${price(setup.invalidation)}`,
      `Target ${targetNumber}: ${price(target)}`,
      `Contract: ${contract}`,
      plannedContracts > 0 ? `Planned order: ${plannedContracts} contract${plannedContracts === 1 ? '' : 's'} at or below ${price(plannedLimit)} · maximum debit ${price(plannedDebit)}` : null
    ].filter(Boolean).join('\n');
    const rawCloseReason = String(lifecycle.close_reason || signal.signal_phase || state);
    const closeReasons: Record<string, string> = {
      protected_invalidation: 'SPY crossed the protected invalidation',
      tracking_gap_abort: 'live strategy tracking was interrupted too long',
      option_quote_stale: 'the selected option quote became stale',
      completed: 'the planned target lifecycle completed'
    };
    const closeReason = closeReasons[rawCloseReason.toLowerCase()] || rawCloseReason.toLowerCase().replace(/_/g, ' ');

    if (['INVALIDATED', 'TRACKING_ABORTED', 'FAILED'].includes(state)
      || ['INVALIDATED', 'TRACKING_ABORTED', 'FAILED'].includes(String(signal.signal_phase || '').toUpperCase())) {
      return {
        title: state === 'INVALIDATED' ? `CLOSED — SPY ${side || ''} setup invalidated` : `CLOSED — SPY ${side || ''} tracking stopped`,
        message: `ACTION: DO NOT ENTER OR RE-ENTER.\nReason: ${closeReason}.\nIf a broker position is still open, verify its exit status immediately.\n\n${plan}`,
        severity: 'critical',
        category: 'strategy-stop',
        eventKey: `stop:${state}:${closeReason}`
      };
    }
    if (state === 'COMPLETED') {
      return {
        title: `CLOSED — SPY ${side || ''} target complete`,
        message: `ACTION: CONFIRM THE BROKER EXIT AND FINAL FILL.\nDo not submit another entry from this setup.\n\n${plan}`,
        severity: 'info',
        category: 'strategy-target',
        eventKey: `target:completed:${targetsHit}`
      };
    }
    if (targetsHit > 0) {
      return {
        title: `MANAGE — SPY target ${targetsHit} reached`,
        message: `ACTION: DO NOT ADD A NEW POSITION.\nTarget ${targetsHit} was reached. Let the protected exit lifecycle continue and verify the broker position remains monitored.\n\n${plan}`,
        severity: 'info',
        category: 'strategy-target',
        eventKey: `target:${targetsHit}`
      };
    }
    if (state === 'ACTIVE') {
      return {
        title: `REVIEW NOW — SPY ${side || ''} entry active`,
        message: `ACTION: OPEN THE APP AND REVIEW THE PLANNED ORDER NOW.\nThe trigger and activation checks passed. Entry still requires manual approval, a fresh quote, and every hard risk limit.\n\n${plan}`,
        severity: 'warning',
        category: 'strategy-active',
        eventKey: 'active'
      };
    }
    if (state === 'ARMED') {
      return {
        title: `WAIT — SPY ${side || ''} setup forming`,
        message: `ACTION: WAIT. DO NOT ENTER YET.\nThe plan is frozen, but the final activation checks have not passed. Enter only if the app changes this setup to ACTIVE.\n\n${plan}`,
        severity: 'info',
        category: 'strategy-armed',
        eventKey: 'armed'
      };
    }
    return null;
  }

  private async notifyStrategyLifecycle(signal: StrategySnapshot): Promise<void> {
    const alert = this.strategyAlert(signal);
    const setupId = this.currentSetupId;
    if (!alert || !setupId) return;
    const [usersResult, signalResult] = await Promise.all([
      (this.fastify as any).pg.query(
        `SELECT DISTINCT user_id
         FROM settings
         WHERE key = 'day_trading_enabled' AND value = 'true'`
      ),
      (this.fastify as any).pg.query(
        `SELECT id FROM signals WHERE strategy_setup_id = $1 LIMIT 1`,
        [setupId]
      )
    ]);
    const signalId = signalResult.rows?.[0]?.id || null;
    const discord = new DiscordAlertService(this.fastify);
    await Promise.allSettled((usersResult.rows || []).map((row: any) => discord.send({
      userId: Number(row.user_id),
      title: alert.title,
      message: alert.message,
      severity: alert.severity,
      category: alert.category,
      signalId,
      dedupeKey: `strategy:${row.user_id}:${setupId}:${alert.eventKey}`,
      dedupeSeconds: 86_400
    })));
  }

  private async persistPrimarySignal(signal: StrategySnapshot): Promise<void> {
    const state = String(signal.state || 'WAIT');
    if (!this.currentSetupId) return;
    if (this.isTerminal(signal)) {
      const terminalState = TERMINAL_STATES.has(state)
        ? state
        : String(signal.signal_phase || state);
      await (this.fastify as any).pg.query(
        `UPDATE signals
         SET lifecycle_status = $2,
             entry_allowed = FALSE,
             strategy_snapshot = $3,
             status = CASE WHEN status IN ('PENDING', 'PENDING_TRIGGER') THEN 'CANCELLED' ELSE status END
         WHERE strategy_setup_id = $1`,
        [this.currentSetupId, terminalState, JSON.stringify(signal)]
      );
      await (this.fastify as any).pg.query(
        `UPDATE positions
         SET strategy_lifecycle_status = $2,
             strategy_snapshot = $3,
             strategy_exit_requested_at = COALESCE(strategy_exit_requested_at, CURRENT_TIMESTAMP),
             strategy_exit_reason = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE strategy_setup_id = $1
           AND strategy_managed = TRUE
           AND status = 'OPEN'`,
        [this.currentSetupId, terminalState, JSON.stringify(signal)]
      );
      return;
    }
    if (!ACTIVE_STATES.has(state)) return;

    const side = signal.favoring === 'puts' ? 'PUT' : 'CALL';
    const setup = side === 'CALL' ? signal.call_setup || {} : signal.put_setup || {};
    const option = setup.option || {};
    const lifecycle = signal.lifecycle || {};
    const expiry = this.normalizeExpiry(option.expiry);
    const targets = Array.isArray(setup.targets) ? setup.targets : [];
    const exitTargetNumber = Math.max(1, Number(signal.paper_policy?.exit_after_target || 2));
    const target = targets[Math.min(exitTargetNumber, targets.length) - 1] ?? targets[0] ?? null;
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
       ON CONFLICT (strategy_setup_id) WHERE strategy_setup_id IS NOT NULL DO UPDATE
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
          planned_contracts: option.planned_contracts || null,
          planned_limit_price: option.planned_limit_price || null,
          planned_total_debit: option.planned_total_debit || null,
          strategy_max_total_debit_dollars: signal.strategy_policy?.strategy_max_total_debit_dollars || null,
          targets,
          exit_target_number: exitTargetNumber,
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
    await (this.fastify as any).pg.query(
      `UPDATE positions
       SET suggested_stop_loss = $2,
           suggested_take_profit_1 = $3,
           suggested_take_profit_2 = $4,
           strategy_lifecycle_status = $5,
           strategy_policy_fingerprint = $6,
           strategy_snapshot = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE strategy_setup_id = $1
         AND strategy_managed = TRUE
         AND status = 'OPEN'`,
      [
        this.currentSetupId,
        setup.invalidation || null,
        target,
        targets[1] ?? null,
        state,
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
    await this.publishZeroGexCredential(
      String(settings.zerogex_api_key || process.env.ZEROGEX_API_KEY || '').trim()
    );
    const ibkr = await getIbkrGatewayConfig((this.fastify as any).pg);
    const ibkrDataTypes: Record<number, string> = {
      1: 'live',
      2: 'frozen',
      3: 'delayed',
      4: 'delayed-frozen'
    };
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
      ),
      ibkr_host: ibkr.host,
      ibkr_port: ibkr.port,
      ibkr_data_type: ibkrDataTypes[ibkr.marketDataType] || 'live'
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

  private async publishZeroGexCredential(apiKey: string): Promise<void> {
    const fingerprint = this.hash(apiKey);
    if (fingerprint === this.lastZeroGexKeyFingerprint) return;

    await fs.mkdir(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, 'zerogex.env');
    if (!apiKey) {
      await fs.unlink(target).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      this.lastZeroGexKeyFingerprint = fingerprint;
      return;
    }

    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `ZEROGEX_API_KEY=${apiKey}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    this.lastZeroGexKeyFingerprint = fingerprint;
  }

  private numberInRange(value: any, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  private gexAgeSeconds(signal: StrategySnapshot): number | null {
    const providerAge = signal.gex?.provider_age_seconds == null
      ? Number.NaN
      : Number(signal.gex.provider_age_seconds);
    if (Number.isFinite(providerAge)) return providerAge;
    const zeroGexProviderAge = signal.zerogex_shadow?.provider_age_seconds == null
      ? Number.NaN
      : Number(signal.zerogex_shadow.provider_age_seconds);
    if (Number.isFinite(zeroGexProviderAge)) return zeroGexProviderAge;
    const freshness = signal.zerogex_shadow?.data_freshness?.gex_summary;
    const age = Number(freshness?.adjusted_age_seconds ?? freshness?.age_seconds);
    if (Number.isFinite(age)) return age;
    const timestamp = Number(signal.gex?.provider_timestamp || signal.gex?.fetched_at);
    return Number.isFinite(timestamp) && timestamp > 0 ? Date.now() / 1000 - timestamp : null;
  }

  private authoritativeGexFresh(signal: StrategySnapshot, age = this.gexAgeSeconds(signal)): boolean {
    if (age === null || age < 0 || age > MAX_GEX_PROVIDER_AGE_SECONDS) return false;
    if (signal.gex?.error) return false;
    if (signal.zerogex_shadow?.fresh === false) return false;
    return true;
  }

  private optionQuoteAgeSeconds(signal: StrategySnapshot): number | null {
    const option = signal.favoring === 'puts'
      ? signal.put_setup?.option
      : signal.favoring === 'calls'
        ? signal.call_setup?.option
        : null;
    if (option?.quote_age_seconds == null) return null;
    const age = Number(option.quote_age_seconds);
    return Number.isFinite(age) ? age : null;
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
