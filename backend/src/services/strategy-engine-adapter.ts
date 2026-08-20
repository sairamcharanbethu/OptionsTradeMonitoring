import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { getGlobalSettings, getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { getIbkrGatewayConfig } from '../lib/ibkr-config';
import { getNewYorkDateParts, getNewYorkMarketState, getUSMarketCloseMinutes } from '../lib/market-calendar';
import { DiscordAlertService } from './discord-alert-service';
import { StrategyLifecycleManager } from './strategy-lifecycle-manager';

export type StrategyEngineMode = 'legacy' | 'shadow' | 'primary';

type StrategySnapshot = Record<string, any>;

const ACTIVE_STATES = new Set(['ARMED', 'ACTIVE', 'MANAGE', 'EXTENDED']);
const TERMINAL_STATES = new Set(['COMPLETED', 'INVALIDATED', 'TRACKING_ABORTED', 'FAILED']);
const MAX_GEX_PROVIDER_AGE_SECONDS = 120;
const MIN_PLAN_REWARD_RISK = 1.5;

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
  private currentSignals: Record<string, StrategySnapshot> = {};
  private currentHealth: StrategySnapshot | null = null;
  private currentSetupId: string | null = null;
  private laneSetupIds: Record<string, string | null> = {};
  private currentPlanFingerprint: string | null = null;
  private lanePlanFingerprints: Record<string, string | null> = {};
  private lastEventFingerprint: string | null = null;
  private laneEventFingerprints: Record<string, string | null> = {};
  private lastSnapshotFingerprint: string | null = null;
  private lastReceivedAt: string | null = null;
  private lastError: string | null = null;
  private lastPolicyFingerprint: string | null = null;
  private lastZeroGexKeyFingerprint: string | null = null;
  private lastAutonomousEntryAt: string | null = null;
  private lastAutonomousEntryResult: string | null = null;
  private lifecycleManager: StrategyLifecycleManager;

  constructor(private fastify: FastifyInstance) {
    this.dataDir = process.env.STRATEGY_DATA_DIR || '/strategy-data/trade';
    this.lifecycleManager = new StrategyLifecycleManager(fastify);
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
      this.publishOpenPositions().catch((err: any) => {
        this.fastify.log.warn(`[StrategyEngineAdapter] Open-position reconciliation publish failed: ${err.message || String(err)}`);
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
      marketDataReadiness: this.currentSignal?.market_data_readiness
        || this.currentHealth?.market_data_readiness
        || null,
      signal: this.currentSignal,
      strategySignals: Object.entries(this.currentSignals).map(([lane, signal]) => ({
        lane,
        setupId: this.laneSetupIds[lane] || null,
        ageSeconds: Number(signal.generated_at || 0) > 0
          ? Date.now() / 1000 - Number(signal.generated_at)
          : null,
        signal
      })),
      autonomousEntry: {
        lastAttemptAt: this.lastAutonomousEntryAt,
        lastResult: this.lastAutonomousEntryResult,
        contractLimit: 1,
        entryCutoffMinutesBeforeClose: 60
      },
      transport: {
        redis: this.redisStatus,
        lastRedisEventAt: this.lastRedisEventAt,
        filePollFallback: true,
        filePollIntervalMs: Number(process.env.STRATEGY_FILE_POLL_INTERVAL_MS || 2000),
        redisWatchdogIntervalMs: Number(process.env.STRATEGY_REDIS_WATCHDOG_INTERVAL_MS || 30000)
      },
      source: 'python',
      entryBlocked: false
    };
  }

  public async getStrategyFamilyHistory(limit = 100): Promise<Array<Record<string, any>>> {
    const cappedLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)));
    const historyDir = path.join(this.dataDir, 'history');
    let fileNames: string[];
    try {
      fileNames = (await fs.readdir(historyDir))
        .filter(name => /^signals-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .reverse()
        .slice(0, 7);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    const events: Array<Record<string, any>> = [];
    const seen = new Set<string>();
    for (const fileName of fileNames) {
      let lines: string[];
      try {
        lines = (await fs.readFile(path.join(historyDir, fileName), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .reverse();
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const line of lines) {
        let record: Record<string, any>;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const context = record.strategy_family_context;
        if (
          !context
          || !['shadow', 'primary'].includes(String(context.mode || ''))
          || typeof context.entry_authority !== 'boolean'
        ) continue;
        for (const [field, familyName] of [
          ['vwap_trend', 'VWAP_TREND'],
          ['orb_index', 'ORB_INDEX']
        ] as const) {
          const family = context[field];
          if (!family || typeof family !== 'object') continue;
          const candidate = family.candidate || family.suppressed_candidate;
          const eventId = String(candidate?.event_id || '');
          if (!eventId || seen.has(eventId)) continue;
          seen.add(eventId);
          events.push({
            event_id: eventId,
            family: familyName,
            side: candidate.side || null,
            status: family.status || null,
            confirmed_at: Number(candidate.confirmed_at || 0) || null,
            journaled_at: Number(record.journaled_at || 0) || null,
            generated_at: Number(record.generated_at || 0) || null,
            spot: Number(record.spot || 0) || null,
            fresh: candidate.fresh === true,
            suppressed: !family.candidate && Boolean(family.suppressed_candidate),
            entry_authority: context.entry_authority === true,
            observation: family.observation || null,
            opening_range: family.opening_range || null,
            gex_alignment: family.gex_alignment || null,
            trend: family.trend || null,
            kill_switch: family.kill_switch || null,
            risk_plan: context.shared_risk || family.risk_plan || null
          });
        }
      }
    }
    return events
      .sort((left, right) => (
        Number(right.confirmed_at || right.journaled_at || 0)
        - Number(left.confirmed_at || left.journaled_at || 0)
      ))
      .slice(0, cappedLimit);
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
    const setupId = String(row.strategy_setup_id);
    const live = this.liveSignalForSetup(setupId);
    if (!live || live.engine_version !== 'signal-only-v2') {
      throw this.conflict('The live signal-only-v2 snapshot is unavailable');
    }
    if (!this.isCurrentSetup(setupId)) {
      throw this.conflict('The strategy setup changed after this signal was displayed');
    }
    const lifecycle = live.lifecycle || {};
    if (String(live.state) !== 'ACTIVE' || lifecycle.entry_allowed !== true) {
      throw this.conflict('The strategy is no longer accepting a new entry');
    }
    const setup = live.favoring === 'puts' ? live.put_setup || {} : live.call_setup || {};
    const planQuality = setup.plan_quality || live.plan_quality || {};
    const rewardRisk = Number(planQuality.reward_risk);
    if (planQuality.meets_minimum !== true || !Number.isFinite(rewardRisk) || rewardRisk < MIN_PLAN_REWARD_RISK) {
      throw this.conflict(`The strategy plan does not meet the ${MIN_PLAN_REWARD_RISK.toFixed(2)}:1 minimum reward/risk`);
    }
    const session = live.session_policy || {};
    const now = new Date();
    const sessionParts = getNewYorkDateParts(now);
    const sessionMinute = sessionParts.hour * 60 + sessionParts.minute;
    if (
      session.valid !== true
      || session.market_date !== sessionParts.dateKey
      || session.is_trading_day !== true
      || !Number.isFinite(Number(session.open_minute_et))
      || !Number.isFinite(Number(session.entry_cutoff_minute_et))
      || sessionMinute < Number(session.open_minute_et)
      || sessionMinute >= Number(session.entry_cutoff_minute_et)
    ) {
      throw this.conflict('The strategy entry session is closed or its calendar policy is stale');
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
    const setupId = String(rows[0].strategy_setup_id);
    const live = this.liveSignalForSetup(setupId);
    if (!live || !this.isCurrentSetup(setupId)) {
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

  private strategyLane(signal: StrategySnapshot | null | undefined): string {
    const explicit = String(signal?.strategy_lane || '').trim().toLowerCase();
    if (explicit) return explicit;
    const strategy = String(signal?.strategy || '').toUpperCase();
    if (strategy === 'ORB_INDEX') return 'orb_index';
    if (strategy === 'VWAP_TREND') return 'vwap_trend';
    return 'mtf';
  }

  private isCurrentSetup(setupId: string): boolean {
    return Object.values(this.laneSetupIds).some(value => value === setupId)
      || this.currentSetupId === setupId;
  }

  private liveSignalForSetup(setupId: string): StrategySnapshot | null {
    const lane = Object.entries(this.laneSetupIds)
      .find(([, value]) => value === setupId)?.[0];
    return lane ? this.currentSignals[lane] || null : this.currentSignal;
  }

  private async poll(): Promise<void> {
    const [bundle, legacySignal, health] = await Promise.all([
      this.readJson(path.join(this.dataDir, 'strategy-signals.json')),
      this.readJson(path.join(this.dataDir, 'signal.json')),
      this.readJson(path.join(this.dataDir, 'health.json'))
    ]);
    const bundledSignals = bundle?.signals && typeof bundle.signals === 'object'
      ? bundle.signals
      : null;
    const signals: Record<string, StrategySnapshot> = bundledSignals
      ? Object.fromEntries(
        Object.entries(bundledSignals).filter(([, value]) => value && typeof value === 'object')
      ) as Record<string, StrategySnapshot>
      : legacySignal
        ? { [this.strategyLane(legacySignal)]: legacySignal }
        : {};
    await this.applySignals(signals, health, 'python');
  }

  private async applySignals(
    signals: Record<string, StrategySnapshot>,
    health: StrategySnapshot | null,
    source: 'python'
  ): Promise<void> {
    if (Object.keys(signals).length === 0) return;
    for (const signal of Object.values(signals)) {
      if (signal.engine_version !== 'signal-only-v2' || signal.execution_enabled !== false) {
        throw new Error('Rejected strategy snapshot with an invalid signal-only contract');
      }
    }
    this.currentHealth = health;
    const snapshotFingerprint = this.hash({ source, signals });
    if (snapshotFingerprint === this.lastSnapshotFingerprint) return;
    if (Object.keys(this.currentSignals).length === 0 && this.currentSignal) {
      const legacyLane = this.strategyLane(this.currentSignal);
      this.currentSignals[legacyLane] = this.currentSignal;
      this.laneSetupIds[legacyLane] = this.currentSetupId;
      this.lanePlanFingerprints[legacyLane] = this.currentPlanFingerprint;
      this.laneEventFingerprints[legacyLane] = this.lastEventFingerprint;
    }

    try {
      this.lastReceivedAt = new Date().toISOString();
      this.lastError = null;
      for (const [lane, signal] of Object.entries(signals)) {
        await this.processLaneSnapshot(lane, signal);
      }
      const displayLane = this.selectDisplayLane(this.currentSignals);
      this.currentSignal = this.currentSignals[displayLane] || Object.values(this.currentSignals)[0] || null;
      this.currentSetupId = this.laneSetupIds[displayLane] || null;
      this.currentPlanFingerprint = this.lanePlanFingerprints[displayLane] || null;
      this.lastEventFingerprint = this.laneEventFingerprints[displayLane] || null;
      this.lastSnapshotFingerprint = snapshotFingerprint;
      this.broadcast({
        type: 'STRATEGY_SNAPSHOT_UPDATED',
        data: this.getCurrentState()
      });
      this.broadcast({
        type: 'STRATEGY_STATE_CHANGED',
        data: this.getCurrentState()
      });
    } catch (error) {
      const displayLane = this.selectDisplayLane(this.currentSignals);
      this.currentSignal = this.currentSignals[displayLane] || this.currentSignal;
      this.currentSetupId = this.laneSetupIds[displayLane] || this.currentSetupId;
      this.currentPlanFingerprint = this.lanePlanFingerprints[displayLane] || this.currentPlanFingerprint;
      this.lastEventFingerprint = this.laneEventFingerprints[displayLane] || this.lastEventFingerprint;
      throw error;
    }
  }

  private selectDisplayLane(signals: Record<string, StrategySnapshot>): string {
    const rank: Record<string, number> = {
      ACTIVE: 5,
      MANAGE: 4,
      EXTENDED: 4,
      ARMED: 3,
      WATCH: 2,
      WAIT: 1
    };
    return Object.entries(signals).reduce((selected, [lane, signal]) => {
      if (!selected) return lane;
      const current = rank[String(signals[selected]?.state || 'WAIT').toUpperCase()] || 0;
      const candidate = rank[String(signal.state || 'WAIT').toUpperCase()] || 0;
      return candidate > current ? lane : selected;
    }, '');
  }

  private async processLaneSnapshot(lane: string, signal: StrategySnapshot): Promise<void> {
    if (this.hash(signal) === this.hash(this.currentSignals[lane])) return;
    const previousSignal = this.currentSignals[lane];
    const previousEventFingerprint = this.laneEventFingerprints[lane] || null;
    const planFingerprint = this.planFingerprint(signal);
    let setupId = this.laneSetupIds[lane] || null;
    const previousPlanFingerprint = this.lanePlanFingerprints[lane] || null;
    if (planFingerprint && planFingerprint !== previousPlanFingerprint) {
      const supersededSetupId = setupId;
      setupId = randomUUID();
      this.laneSetupIds[lane] = setupId;
      this.lanePlanFingerprints[lane] = planFingerprint;
      if (supersededSetupId) {
        void this.retireSupersededSetup(supersededSetupId, signal).catch((err: any) => {
          this.fastify.log.error(`[StrategyEngineAdapter:${lane}] Lifecycle manager could not retire superseded setup ${supersededSetupId}: ${err.message || String(err)}`);
        });
      }
    }
    this.currentSignals[lane] = signal;

    try {
      if (setupId && (this.fastify as any).paperTrading) {
        (this.fastify as any).paperTrading.processSnapshot(signal, setupId).catch((err: any) => {
          this.fastify.log.warn(`[PaperTrading:${lane}] Snapshot processing failed: ${err.message || String(err)}`);
        });
      }

      const eventFingerprint = this.eventFingerprint(signal, setupId);
      if (eventFingerprint === this.laneEventFingerprints[lane]) return;
      const eventInserted = await this.persistEvent(signal, eventFingerprint, setupId);
      this.laneEventFingerprints[lane] = eventFingerprint;

      let persistedSignalId: number | null = null;
      if (this.mode === 'primary') {
        persistedSignalId = await this.persistPrimarySignal(signal, setupId);
        if (persistedSignalId) {
          void this.maybeExecuteAutonomousLiveEntries(signal, persistedSignalId).catch((err: any) => {
            this.fastify.log.error(`[StrategyEngineAdapter:${lane}] Lifecycle manager autonomous entry processing failed: ${err.message || String(err)}`);
          });
        }
      }
      if (eventInserted) {
        this.notifyStrategyLifecycle(signal, setupId).catch((err: any) => {
          this.fastify.log.warn(`[StrategyEngineAdapter:${lane}] Discord lifecycle alert failed: ${err.message || String(err)}`);
        });
      }
      if (this.isTerminal(signal)) {
        this.lanePlanFingerprints[lane] = null;
        this.laneSetupIds[lane] = null;
      }
    } catch (error) {
      if (previousSignal) this.currentSignals[lane] = previousSignal;
      else delete this.currentSignals[lane];
      this.laneEventFingerprints[lane] = previousEventFingerprint;
      throw error;
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

  private updateSetupIdentity(signal: StrategySnapshot): string | null {
    const planFingerprint = this.planFingerprint(signal);
    if (!planFingerprint) {
      return null;
    }
    if (planFingerprint !== this.currentPlanFingerprint) {
      const previousSetupId = this.currentSetupId;
      this.currentPlanFingerprint = planFingerprint;
      this.currentSetupId = randomUUID();
      return previousSetupId;
    }
    return null;
  }

  private async retireSupersededSetup(setupId: string, signal: StrategySnapshot): Promise<void> {
    await this.lifecycleManager.retireSupersededSetup(setupId, signal);
    this.fastify.log.info(`[StrategyEngineAdapter] Retired superseded setup ${setupId} before activating the new ${signal.favoring || 'directional'} plan.`);
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
      sourceEventId: setup.source_event_id || signal.reversal_setup?.event_id || null,
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

  private eventFingerprint(signal: StrategySnapshot, setupId = this.currentSetupId): string {
    const lifecycle = signal.lifecycle || {};
    return this.hash({
      mode: this.mode,
      setupId,
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

  private async persistEvent(
    signal: StrategySnapshot,
    eventFingerprint: string,
    setupId = this.currentSetupId
  ): Promise<boolean> {
    const result = await (this.fastify as any).pg.query(
      `INSERT INTO strategy_signal_events (
         setup_id, engine_version, mode, lifecycle_status, event_fingerprint,
         policy_fingerprint, signal_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_fingerprint) DO NOTHING
       RETURNING id`,
      [
        setupId,
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
      CONTINUATION: 'trend continuation',
      ORB_INDEX: 'opening-range breakout',
      VWAP_TREND: 'VWAP trend pullback'
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

  private async notifyStrategyLifecycle(
    signal: StrategySnapshot,
    setupId = this.currentSetupId
  ): Promise<void> {
    const alert = this.strategyAlert(signal);
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
    await Promise.allSettled((usersResult.rows || []).map(async (row: any) => {
      const userId = Number(row.user_id);
      const settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
      const autonomousActive = alert.category === 'strategy-active'
        && this.isAutonomousLiveEntryConfigured(settings);
      await discord.send({
        userId,
        title: autonomousActive ? alert.title.replace('REVIEW NOW', 'AUTO ENTRY') : alert.title,
        message: autonomousActive
          ? alert.message.replace(
            'ACTION: OPEN THE APP AND REVIEW THE PLANNED ORDER NOW.\nThe trigger and activation checks passed. Entry still requires manual approval, a fresh quote, and every hard risk limit.',
            'ACTION: MONITOR THE AUTONOMOUS ENTRY.\nThe backend will submit at most one contract only if the live account, market window, lifecycle, quote, debit, and hard risk checks all pass.'
          )
          : alert.message,
        severity: alert.severity,
        category: alert.category,
        signalId,
        dedupeKey: `strategy:${userId}:${setupId}:${alert.eventKey}`,
        dedupeSeconds: 86_400
      });
    }));
  }

  private async persistPrimarySignal(
    signal: StrategySnapshot,
    setupId = this.currentSetupId
  ): Promise<number | null> {
    const state = String(signal.state || 'WAIT');
    if (!setupId) return null;
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
        [setupId, terminalState, JSON.stringify(signal)]
      );
      void this.lifecycleManager.requestTerminalExit(setupId, terminalState, signal).catch((err: any) => {
        this.fastify.log.error(`[StrategyEngineAdapter] Lifecycle manager could not request ${terminalState} exit for ${setupId}: ${err.message || String(err)}`);
      });
      return null;
    }
    if (!ACTIVE_STATES.has(state)) return null;

    const side = signal.favoring === 'puts' ? 'PUT' : 'CALL';
    const setup = side === 'CALL' ? signal.call_setup || {} : signal.put_setup || {};
    const option = setup.option || {};
    const lifecycle = signal.lifecycle || {};
    const expiry = this.normalizeExpiry(option.expiry);
    const targets = Array.isArray(setup.targets) ? setup.targets : [];
    const exitTargetNumber = Math.max(1, Number(signal.paper_policy?.exit_after_target || 2));
    const target = targets[Math.min(exitTargetNumber, targets.length) - 1] ?? targets[0] ?? null;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(signal.confidence_score || 0))));
    const tradeBias = side === 'CALL' ? 'BULLISH' : 'BEARISH';
    const confidenceGrade = confidence >= 90 ? 'A+' : confidence >= 70 ? 'A' : null;
    const setupGrade = state === 'ACTIVE' && lifecycle.entry_allowed === true ? confidenceGrade : null;
    const signalResult = await (this.fastify as any).pg.query(
      `INSERT INTO signals (
         symbol, signal_type, trade_bias, current_price, entry_trigger, stop_loss,
         target_price, confidence_score, setup_grade, status, indicators, gex,
         no_trade_reasons, option_expiration_date, market_date, option_details,
         engine_version, strategy_name, strategy_setup_id, lifecycle_status,
         entry_allowed, activated_at, policy_fingerprint, strategy_snapshot
         ) VALUES (
         'SPY', $1, $21, $3, $4, $5, $6, $7, $22, 'PENDING', $9, $10, $11,
         $12, $13, $14, $15, $2, $16, $8, $17, $18, $19, $20
       )
       ON CONFLICT (strategy_setup_id) WHERE strategy_setup_id IS NOT NULL DO UPDATE
       SET trade_bias = EXCLUDED.trade_bias,
           current_price = EXCLUDED.current_price,
           confidence_score = EXCLUDED.confidence_score,
           setup_grade = EXCLUDED.setup_grade,
           lifecycle_status = EXCLUDED.lifecycle_status,
           entry_allowed = EXCLUDED.entry_allowed,
           activated_at = EXCLUDED.activated_at,
           indicators = EXCLUDED.indicators,
           gex = EXCLUDED.gex,
           no_trade_reasons = EXCLUDED.no_trade_reasons,
           option_details = EXCLUDED.option_details,
           policy_fingerprint = EXCLUDED.policy_fingerprint,
           strategy_snapshot = EXCLUDED.strategy_snapshot
       RETURNING id`,
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
          plan_quality: setup.plan_quality || signal.plan_quality || null,
          estimated_stop_risk: option.estimated_stop_risk || null,
          decision_telemetry: signal.decision_telemetry || null,
          setupId,
          lifecycle
        }),
        signal.engine_version,
        setupId,
        lifecycle.entry_allowed === true,
        lifecycle.activated_at ? new Date(Number(lifecycle.activated_at) * 1000) : null,
        signal.policy_fingerprint || null,
        JSON.stringify(signal),
        tradeBias,
        setupGrade
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
        setupId,
        setup.invalidation || null,
        targets[0] ?? target,
        target,
        state,
        signal.policy_fingerprint || null,
        JSON.stringify(signal)
      ]
    );
    return Number(signalResult.rows?.[0]?.id || 0) || null;
  }

  private autonomousEntryWindow(date: Date = new Date()): { open: boolean; reason: string; cutoffMinutes: number; closeMinutes: number } {
    const closeMinutes = getUSMarketCloseMinutes(date);
    const cutoffMinutes = closeMinutes - 60;
    const market = getNewYorkMarketState(date, 9 * 60 + 30, closeMinutes);
    if (!market.isOpen) return { open: false, reason: market.reason, cutoffMinutes, closeMinutes };
    if (market.minutes >= cutoffMinutes) return { open: false, reason: 'AUTO_ENTRY_CUTOFF', cutoffMinutes, closeMinutes };
    return { open: true, reason: 'OPEN', cutoffMinutes, closeMinutes };
  }

  private isAutonomousLiveEntryConfigured(settings: Record<string, string>): boolean {
    return settings.autonomous_live_entry_enabled === 'true'
      && settings.day_trading_enabled === 'true'
      && settings.execution_broker === 'wealthsimple_snaptrade'
      && settings.snaptrade_auto_trade === 'true'
      && settings.live_trading_acknowledged === 'true'
      && Boolean(String(settings.snaptrade_trading_account_id || '').trim())
      && settings.shadow_trading_enabled !== 'true';
  }

  private async maybeExecuteAutonomousLiveEntries(signal: StrategySnapshot, signalId: number): Promise<void> {
    if (String(signal.state || '') !== 'ACTIVE' || signal.lifecycle?.entry_allowed !== true) return;
    const entryWindow = this.autonomousEntryWindow();
    if (!entryWindow.open) {
      this.lastAutonomousEntryResult = `Blocked: ${entryWindow.reason}`;
      return;
    }

    const { rows } = await (this.fastify as any).pg.query(
      `SELECT DISTINCT user_id
       FROM settings
       WHERE key = 'autonomous_live_entry_enabled' AND value = 'true'`
    );
    if (!rows?.length) return;

    const attemptedAt = new Date().toISOString();
    const outcomes = await Promise.all(rows.map(async (row: any) => {
      const userId = Number(row.user_id);
      if (!Number.isInteger(userId) || userId <= 0) return null;
      const settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
      if (!this.isAutonomousLiveEntryConfigured(settings)) {
        this.fastify.log.warn(`[StrategyEngineAdapter] Autonomous live entry is enabled but incomplete for user ${userId}.`);
        return { userId, result: 'configuration incomplete' };
      }

      try {
        const result = await this.lifecycleManager.submitAutonomousEntry({
          userId,
          signalId,
          settings,
          assertExecutable: (candidateSignalId) => this.assertSignalExecutable(candidateSignalId)
        });
        return {
          userId,
          result: result?.success
            ? 'order submitted'
            : `entry skipped: ${result?.message || 'risk check denied entry'}`
        };
      } catch (err: any) {
        this.fastify.log.error(`[StrategyEngineAdapter] Autonomous entry failed for user ${userId}: ${err.message || String(err)}`);
        return { userId, result: `entry failed: ${err.message || String(err)}` };
      }
    }));
    const completed = outcomes.filter((outcome): outcome is { userId: number; result: string } => Boolean(outcome));
    if (completed.length > 0) {
      this.lastAutonomousEntryAt = attemptedAt;
      this.lastAutonomousEntryResult = completed.map(outcome => `User ${outcome.userId}: ${outcome.result}`).join('; ');
    }
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
        const snapshot = row.signal_snapshot || {};
        const lane = this.strategyLane(snapshot);
        if (this.laneSetupIds[lane]) continue;
        const fingerprint = this.planFingerprint(snapshot);
        if (!fingerprint) continue;
        this.laneSetupIds[lane] = String(row.setup_id);
        this.lanePlanFingerprints[lane] = fingerprint;
      }
      const restoredLane = Object.keys(this.laneSetupIds)[0];
      this.currentSetupId = restoredLane ? this.laneSetupIds[restoredLane] : null;
      this.currentPlanFingerprint = restoredLane
        ? this.lanePlanFingerprints[restoredLane]
        : null;
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
    const now = new Date();
    const sessionParts = getNewYorkDateParts(now);
    const sessionMarket = getNewYorkMarketState(now);
    const sessionCloseMinutes = getUSMarketCloseMinutes(now);
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
      strategy_families: {
        enabled: true,
        mode: 'primary',
        orb_index: { enabled: true },
        vwap_trend: { enabled: true }
      },
      ibkr_host: ibkr.host,
      ibkr_port: ibkr.port,
      ibkr_data_type: ibkrDataTypes[ibkr.marketDataType] || 'live',
      session: {
        market_date: sessionParts.dateKey,
        is_trading_day: !sessionMarket.isWeekend && !sessionMarket.isHoliday,
        open_minute_et: 9 * 60 + 30,
        close_minute_et: sessionCloseMinutes,
        entry_cutoff_minute_et: sessionCloseMinutes - 60,
        flatten_minute_et: sessionCloseMinutes - 40,
        source: 'backend-market-calendar-v1'
      }
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

  // Pure per-lane reconciliation decision (see publishOpenPositions). Confident
  // there is no position once the position exists, or once the engine's entry
  // window has fully elapsed (plus grace) with no fill — never before, so an
  // in-flight fill is never mistaken for a phantom.
  static laneReconciliation(
    open: boolean, entryWindowUntil: number, nowSec: number, graceSeconds: number
  ): { open: boolean; confident: boolean } {
    const windowElapsed = Number.isFinite(entryWindowUntil) && entryWindowUntil > 0
      && nowSec > entryWindowUntil + graceSeconds;
    return { open, confident: open || windowElapsed };
  }

  // Ledger reconciliation feedback for the engine (consumed by
  // trade_prefetch_service.reconcile_open_positions). Per lane, reports whether
  // a real OPEN paper position exists for the lane's current setup, and whether
  // we are CONFIDENT the entry is resolved. Until confident, we leave the flag
  // off so the engine keeps its own assumption and never sheds protection off a
  // fill that may be in flight.
  private async publishOpenPositions(): Promise<void> {
    const setupIds = Object.values(this.laneSetupIds).filter((value): value is string => Boolean(value));
    const openSetups = new Set<string>();
    if (setupIds.length > 0) {
      const { rows } = await (this.fastify as any).pg.query(
        `SELECT DISTINCT strategy_setup_id FROM positions
          WHERE status = 'OPEN' AND strategy_setup_id = ANY($1::text[])`,
        [setupIds]
      );
      for (const row of rows) openSetups.add(String(row.strategy_setup_id));
    }
    const laneSignals = (await this.readJson(path.join(this.dataDir, 'strategy-signals.json')))?.signals || {};
    // Grace past the engine's entry window before declaring an entry missed, so
    // an in-flight fill (or async ledger write) is never mistaken for a phantom.
    const graceSeconds = Math.max(0, Number(process.env.STRATEGY_RECONCILE_GRACE_SECONDS || 30));
    const nowSec = Date.now() / 1000;
    const lanes: Record<string, { open: boolean; confident: boolean }> = {};
    for (const [lane, setupId] of Object.entries(this.laneSetupIds)) {
      if (!setupId) continue;
      const open = openSetups.has(String(setupId));
      const entryWindowUntil = Number(laneSignals[lane]?.lifecycle?.entry_window_until || 0);
      lanes[lane] = StrategyEngineAdapter.laneReconciliation(open, entryWindowUntil, nowSec, graceSeconds);
    }
    if (Object.keys(lanes).length === 0) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, 'positions.json');
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ generated_at: nowSec, lanes }));
    await fs.rename(temporary, target);
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
