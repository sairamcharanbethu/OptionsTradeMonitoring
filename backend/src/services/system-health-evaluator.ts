import { FastifyInstance } from 'fastify';
import { getNewYorkMarketState, getUSMarketCloseMinutes } from '../lib/market-calendar';
import { publishRealtime } from '../lib/realtime';
import { redis } from '../lib/redis';
import { DiscordAlertService } from './discord-alert-service';

export type SystemHealthSnapshot = {
  engine: {
    updatedAtEpoch: number | null;
    status: string | null;
    connected: boolean | null;
    kernel: string | null;
    startedAt: number | null;
    error: string | null;
  } | null;
  ibkrStream: { status: string | null; connected: boolean | null; lastError: string | null } | null;
  zerogex: { status: string | null; updatedAtEpoch: number | null; error: string | null; startedAt: number | null } | null;
  redisReady: boolean;
  poller: { status: string | null; lastPollCompletedAt: string | null; intervalSeconds: number; pollingEnabled: boolean } | null;
  postgres: { ok: boolean; error: string | null };
  backendRestartsLastHour: number | null;
  heartbeatConfigured: boolean;
};

export type CheckSeverity = 'critical' | 'warning' | 'info';
export type CheckState = 'ok' | 'suspect' | 'firing';

export type CheckStatus = {
  id: string;
  title: string;
  severity: CheckSeverity;
  state: CheckState;
  since: string | null;
  firedAt: string | null;
  message: string | null;
  stage: number;
};

export type HealthTransition = {
  id: string;
  kind: 'fired' | 'renotify' | 'recovered';
  severity: CheckSeverity;
  title: string;
  message: string;
  stage: number;
};

export type SystemHealthSummary = {
  overall: 'OK' | 'DEGRADED' | 'CRITICAL';
  evaluatedAt: string | null;
  checks: CheckStatus[];
  heartbeat: { configured: boolean; lastPingAt: string | null; lastPingOk: boolean | null; mode: 'ok' | 'fail' | null };
  restartWindow: string | null;
};

type CheckDefinition = {
  id: string;
  title: string;
  severity: CheckSeverity;
  /** Seconds the condition must hold before firing (0 = immediately). */
  holdSeconds: number;
  /** Returns a message when the condition is failing, null when healthy, or undefined when not applicable right now. */
  failing: (snapshot: SystemHealthSnapshot, ctx: EvalContext) => string | null | undefined;
};

type EvalContext = {
  now: Date;
  nowMs: number;
  marketOpen: boolean;
  preOpen: boolean;
  weekend: boolean;
  inRestartWindow: boolean;
  sundayReminderWindow: boolean;
};

type CheckRuntime = {
  state: CheckState;
  sinceMs: number | null;
  firedAtMs: number | null;
  lastNotifiedStage: number;
  lastNotifiedAtMs: number | null;
  okStreak: number;
  message: string | null;
};

type EvaluatorDeps = {
  collect: () => Promise<SystemHealthSnapshot>;
  now?: () => Date;
  intervalMs?: number;
  heartbeatUrl?: string | null;
  restartWindow?: string | null;
  fetchImpl?: typeof fetch;
  notify?: (transition: HealthTransition) => Promise<void>;
};

const RENOTIFY_STAGES_MS = [15 * 60 * 1000, 60 * 60 * 1000];
const RENOTIFY_PERIOD_MS = 4 * 60 * 60 * 1000;
const RECOVERY_PASSES = 2;
const SUMMARY_KEY = 'ops:health:summary';
const SUMMARY_TTL_SECONDS = 120;

/** Parse "HH:MM-HH:MM" (ET) into minute bounds; supports crossing midnight. */
export function parseRestartWindow(value: string | null | undefined): { start: number; end: number } | null {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start < 0 || start >= 1440 || end < 0 || end >= 1440) return null;
  return { start, end };
}

export function minutesInWindow(minutes: number, window: { start: number; end: number } | null): boolean {
  if (!window) return false;
  if (window.start <= window.end) return minutes >= window.start && minutes < window.end;
  return minutes >= window.start || minutes < window.end; // crosses midnight
}

const ageSeconds = (epochSeconds: number | null, nowMs: number): number | null =>
  epochSeconds && Number.isFinite(epochSeconds) ? Math.max(0, nowMs / 1000 - epochSeconds) : null;

/**
 * Evaluates feed/process health on a timer and pages the operator while the
 * system is FLAT — the moment execution gating silently blocks trades. Each
 * check is a tiny state machine (ok → suspect → firing → ok) with a hold time
 * so one-tick blips never page, staged re-notification (+15m, +60m, then
 * every 4h) so a long outage is not forgotten, and a recovery notice. The
 * summary is mirrored to Redis so a restarted backend does not re-page for a
 * condition it already reported, and an external heartbeat is pinged every
 * tick (``/fail`` while anything critical is firing).
 */
export class SystemHealthEvaluator {
  static readonly DEFAULT_INTERVAL_MS = 30_000;

  private readonly checks: CheckDefinition[];
  private readonly runtime = new Map<string, CheckRuntime>();
  private readonly startedAtSeen = new Map<string, Array<{ value: number; seenAtMs: number }>>();
  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;
  private lastEvaluatedAt: string | null = null;
  private lastSnapshot: SystemHealthSnapshot | null = null;
  private heartbeat: SystemHealthSummary['heartbeat'] = { configured: false, lastPingAt: null, lastPingOk: null, mode: null };
  private recipientsCache: { ids: number[]; loadedAtMs: number } | null = null;
  private readonly restartWindow: { start: number; end: number } | null;
  private readonly restartWindowRaw: string | null;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly heartbeatUrl: string | null;
  private restored = false;

  constructor(private fastify: FastifyInstance, private deps: EvaluatorDeps) {
    this.now = deps.now || (() => new Date());
    this.fetchImpl = deps.fetchImpl || fetch;
    this.heartbeatUrl = (deps.heartbeatUrl ?? process.env.HEARTBEAT_URL ?? '').trim() || null;
    this.restartWindowRaw = (deps.restartWindow ?? process.env.IBKR_RESTART_WINDOW_ET ?? '').trim() || null;
    this.restartWindow = parseRestartWindow(this.restartWindowRaw);
    this.heartbeat.configured = Boolean(this.heartbeatUrl);
    this.checks = SystemHealthEvaluator.buildChecks();
    for (const check of this.checks) {
      this.runtime.set(check.id, { state: 'ok', sinceMs: null, firedAtMs: null, lastNotifiedStage: -1, lastNotifiedAtMs: null, okStreak: 0, message: null });
    }
  }

  static buildChecks(): CheckDefinition[] {
    return [
      {
        id: 'engine_stale', title: 'Strategy engine heartbeat stale', severity: 'critical', holdSeconds: 90,
        failing: (s, c) => {
          if (!s.engine) return 'health.json unreadable';
          const age = ageSeconds(s.engine.updatedAtEpoch, c.nowMs);
          return age === null ? 'health.json has no updated_at' : age > 30 ? `health.json is ${Math.round(age)}s old` : null;
        }
      },
      {
        id: 'engine_error', title: 'Strategy engine in error state', severity: 'critical', holdSeconds: 120,
        failing: (s) => (s.engine && String(s.engine.status || '').toLowerCase() === 'error' ? `engine status=error: ${s.engine.error || 'unknown'}` : null)
      },
      {
        id: 'engine_disconnected', title: 'Strategy engine disconnected from IBKR', severity: 'critical', holdSeconds: 180,
        failing: (s, c) => {
          if (!s.engine || s.engine.connected !== false) return null;
          if (c.inRestartWindow) return undefined;
          if (c.marketOpen || c.preOpen) return 'engine reports connected=false during the session';
          return undefined; // off-hours disconnects are handled by engine_disconnected_offhours
        }
      },
      {
        id: 'engine_disconnected_offhours', title: 'Strategy engine disconnected from IBKR (off-hours)', severity: 'warning', holdSeconds: 30 * 60,
        failing: (s, c) => {
          if (!s.engine || s.engine.connected !== false) return null;
          if (c.inRestartWindow || c.marketOpen || c.preOpen || c.weekend) return undefined;
          return 'engine reports connected=false outside the session for 30+ min';
        }
      },
      {
        id: 'ibkr_stream', title: 'IBKR quote stream degraded', severity: 'critical', holdSeconds: 180,
        failing: (s, c) => {
          if (!c.marketOpen || c.inRestartWindow) return undefined;
          const status = String(s.ibkrStream?.status || '').toUpperCase();
          return ['DOWN', 'DEGRADED'].includes(status) ? `ibkr stream ${status}${s.ibkrStream?.lastError ? `: ${s.ibkrStream.lastError}` : ''}` : null;
        }
      },
      {
        id: 'zerogex_auth', title: 'ZeroGEX authentication failing', severity: 'critical', holdSeconds: 0,
        failing: (s) => (String(s.zerogex?.status || '').toLowerCase() === 'auth_error' ? `zerogex auth_error: ${s.zerogex?.error || 'unknown'}` : null)
      },
      {
        id: 'zerogex_stale', title: 'ZeroGEX data stale or erroring', severity: 'warning', holdSeconds: 300,
        failing: (s, c) => {
          if (!c.marketOpen) return undefined;
          if (!s.zerogex) return 'zerogex-health.json unreadable';
          const status = String(s.zerogex.status || '').toLowerCase();
          if (status === 'auth_error') return undefined; // covered by zerogex_auth
          const age = ageSeconds(s.zerogex.updatedAtEpoch, c.nowMs);
          if (status === 'error') return `zerogex status=error: ${s.zerogex.error || 'unknown'}`;
          return age !== null && age > 120 ? `zerogex health is ${Math.round(age)}s old` : null;
        }
      },
      {
        id: 'redis_down', title: 'Redis unavailable', severity: 'critical', holdSeconds: 120,
        failing: (s) => (s.redisReady ? null : 'redis client not ready')
      },
      {
        id: 'poller_stalled', title: 'Exit safety-net poller stalled', severity: 'critical', holdSeconds: 0,
        failing: (s, c) => {
          if (!s.poller || !s.poller.pollingEnabled) return undefined;
          if (!s.poller.lastPollCompletedAt) return undefined; // starting
          const age = c.nowMs - new Date(s.poller.lastPollCompletedAt).getTime();
          const limit = Math.max(60, s.poller.intervalSeconds) * 3 * 1000;
          return age > limit ? `poller last completed ${Math.round(age / 1000)}s ago (limit ${Math.round(limit / 1000)}s)` : null;
        }
      },
      {
        id: 'postgres_down', title: 'Postgres unreachable', severity: 'critical', holdSeconds: 60,
        failing: (s) => (s.postgres.ok ? null : `postgres: ${s.postgres.error || 'unreachable'}`)
      },
      {
        id: 'kernel_not_rust', title: 'Strategy engine not on the Rust kernel', severity: 'warning', holdSeconds: 0,
        failing: (s) => (s.engine && s.engine.kernel && s.engine.kernel !== 'rust' ? `engine kernel=${s.engine.kernel}` : null)
      },
      {
        id: 'restart_loop', title: 'Service restart loop', severity: 'warning', holdSeconds: 0,
        failing: (s, c) => {
          const parts: string[] = [];
          if ((s.backendRestartsLastHour || 0) > 3) parts.push(`backend restarted ${s.backendRestartsLastHour}x in the last hour`);
          return parts.length ? parts.join('; ') : null;
        }
      },
      {
        id: 'heartbeat_unconfigured', title: 'External heartbeat not configured', severity: 'info', holdSeconds: 0,
        failing: (s) => (s.heartbeatConfigured ? null : 'HEARTBEAT_URL is not set; a dead backend cannot page anyone')
      },
      {
        // IBKR forces a weekly full re-login (IB Key 2FA tap) on Sunday; the
        // IBC auto-restart cannot do it. Remind at 16:00 ET so Monday's open
        // is not the moment it is discovered. Info-level: recovers silently.
        id: 'ib_weekly_reauth_due', title: 'IB Gateway weekly re-auth due (Sunday)', severity: 'info', holdSeconds: 0,
        failing: (_s, c) => (c.sundayReminderWindow ? 'Sunday 16:00 ET: complete the IB Gateway weekly re-login (IB Key) before Monday open' : null)
      }
    ];
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    await this.restoreFromRedis();
    const intervalMs = this.deps.intervalMs || SystemHealthEvaluator.DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One evaluation cycle: collect → evaluate → notify → mirror → heartbeat. Never throws. */
  async tick(): Promise<HealthTransition[]> {
    if (this.evaluating) return [];
    this.evaluating = true;
    try {
      let snapshot: SystemHealthSnapshot;
      try {
        snapshot = await this.deps.collect();
      } catch (err: any) {
        this.fastify.log.warn(`[SystemHealth] collect failed: ${err?.message || String(err)}`);
        return [];
      }
      const transitions = this.evaluate(snapshot, this.now());
      for (const transition of transitions) {
        await this.dispatch(transition);
      }
      await this.mirrorToRedis();
      await this.pingHeartbeat();
      return transitions;
    } finally {
      this.evaluating = false;
    }
  }

  // ------------------------------------------------------------ evaluation

  /** Pure state-machine step; exposed for tests. */
  evaluate(snapshot: SystemHealthSnapshot, now: Date = this.now()): HealthTransition[] {
    const nowMs = now.getTime();
    const closeMinutes = getUSMarketCloseMinutes(now);
    const market = getNewYorkMarketState(now, 9 * 60 + 30, closeMinutes);
    const ctx: EvalContext = {
      now,
      nowMs,
      marketOpen: market.isOpen,
      preOpen: !market.isWeekend && !market.isHoliday && market.minutes >= 9 * 60 && market.minutes < 9 * 60 + 30,
      weekend: market.isWeekend,
      inRestartWindow: minutesInWindow(market.minutes, this.restartWindow),
      sundayReminderWindow: this.newYorkWeekday(now) === 0 && market.minutes >= 16 * 60 && market.minutes < 16 * 60 + 30
    };
    this.lastSnapshot = snapshot;
    this.lastEvaluatedAt = now.toISOString();
    this.trackStartedAt('engine', snapshot.engine?.startedAt ?? null, nowMs);
    this.trackStartedAt('zerogex', snapshot.zerogex?.startedAt ?? null, nowMs);

    const transitions: HealthTransition[] = [];
    for (const check of this.checks) {
      const rt = this.runtime.get(check.id)!;
      let failing = check.failing(snapshot, ctx);
      if (check.id === 'restart_loop') {
        const loops = this.restartLoopMessages(nowMs);
        if (loops.length) failing = [failing, ...loops].filter(Boolean).join('; ');
      }
      if (failing === undefined) {
        // Not applicable right now: treat as healthy but do not emit recovery noise.
        if (rt.state === 'firing') {
          rt.okStreak += 1;
          if (rt.okStreak >= RECOVERY_PASSES) this.recover(check, rt, nowMs, transitions, true);
        } else {
          rt.state = 'ok'; rt.sinceMs = null; rt.okStreak = 0;
        }
        continue;
      }
      if (failing === null) {
        if (rt.state === 'firing') {
          rt.okStreak += 1;
          if (rt.okStreak >= RECOVERY_PASSES) this.recover(check, rt, nowMs, transitions, false);
        } else {
          rt.state = 'ok'; rt.sinceMs = null; rt.okStreak = 0; rt.message = null;
        }
        continue;
      }
      // Failing.
      rt.okStreak = 0;
      rt.message = failing;
      if (rt.state === 'ok') {
        rt.state = 'suspect';
        rt.sinceMs = nowMs;
      }
      if (rt.state === 'suspect' && nowMs - (rt.sinceMs ?? nowMs) >= check.holdSeconds * 1000) {
        rt.state = 'firing';
        rt.firedAtMs = nowMs;
        rt.lastNotifiedStage = 0;
        rt.lastNotifiedAtMs = nowMs;
        transitions.push({ id: check.id, kind: 'fired', severity: check.severity, title: check.title, message: failing, stage: 0 });
        continue;
      }
      if (rt.state === 'firing') {
        const stage = this.stageFor(nowMs - (rt.firedAtMs ?? nowMs), rt.lastNotifiedStage, rt.lastNotifiedAtMs, nowMs);
        if (stage > rt.lastNotifiedStage) {
          rt.lastNotifiedStage = stage;
          rt.lastNotifiedAtMs = nowMs;
          const minutes = Math.round((nowMs - (rt.firedAtMs ?? nowMs)) / 60000);
          transitions.push({ id: check.id, kind: 'renotify', severity: check.severity, title: `${check.title} (still firing, ${minutes}m)`, message: failing, stage });
        }
      }
    }
    if (transitions.length) {
      publishRealtime('SYSTEM_HEALTH', this.summary(), {});
    }
    return transitions;
  }

  private recover(check: CheckDefinition, rt: CheckRuntime, nowMs: number, transitions: HealthTransition[], silent: boolean) {
    const minutes = Math.round((nowMs - (rt.firedAtMs ?? nowMs)) / 60000);
    const title = `${check.title} — RECOVERED after ${minutes}m`;
    rt.state = 'ok'; rt.sinceMs = null; rt.firedAtMs = null; rt.lastNotifiedStage = -1; rt.lastNotifiedAtMs = null; rt.okStreak = 0;
    const lastMessage = rt.message;
    rt.message = null;
    if (!silent && check.severity !== 'info') transitions.push({ id: check.id, kind: 'recovered', severity: 'info', title, message: lastMessage || 'condition cleared', stage: -1 });
  }

  /** 0 at fire; 1 after 15m; 2 after 60m; then one more every 4h. */
  private stageFor(firingForMs: number, lastStage: number, lastNotifiedAtMs: number | null, nowMs: number): number {
    let stage = 0;
    for (let i = 0; i < RENOTIFY_STAGES_MS.length; i += 1) if (firingForMs >= RENOTIFY_STAGES_MS[i]) stage = i + 1;
    if (stage === RENOTIFY_STAGES_MS.length && lastStage >= RENOTIFY_STAGES_MS.length) {
      if (lastNotifiedAtMs !== null && nowMs - lastNotifiedAtMs >= RENOTIFY_PERIOD_MS) return lastStage + 1;
      return lastStage;
    }
    return Math.max(stage, Math.min(lastStage, RENOTIFY_STAGES_MS.length));
  }

  private trackStartedAt(service: string, startedAt: number | null, nowMs: number) {
    if (!startedAt || !Number.isFinite(startedAt)) return;
    const list = (this.startedAtSeen.get(service) || []).filter((e) => nowMs - e.seenAtMs <= 60 * 60 * 1000);
    if (!list.some((e) => Math.abs(e.value - startedAt) < 1)) list.push({ value: startedAt, seenAtMs: nowMs });
    this.startedAtSeen.set(service, list);
  }

  private restartLoopMessages(nowMs: number): string[] {
    const out: string[] = [];
    for (const [service, list] of this.startedAtSeen) {
      const recent = list.filter((e) => nowMs - e.seenAtMs <= 60 * 60 * 1000);
      if (recent.length > 3) out.push(`${service} restarted ${recent.length}x in the last hour`);
    }
    return out;
  }

  // ----------------------------------------------------------- reporting

  summary(): SystemHealthSummary {
    const checks: CheckStatus[] = this.checks.map((check) => {
      const rt = this.runtime.get(check.id)!;
      return {
        id: check.id,
        title: check.title,
        severity: check.severity,
        state: rt.state,
        since: rt.sinceMs ? new Date(rt.sinceMs).toISOString() : null,
        firedAt: rt.firedAtMs ? new Date(rt.firedAtMs).toISOString() : null,
        message: rt.message,
        stage: rt.lastNotifiedStage
      };
    });
    const firing = checks.filter((c) => c.state === 'firing');
    const overall = firing.some((c) => c.severity === 'critical') ? 'CRITICAL' : firing.some((c) => c.severity === 'warning') ? 'DEGRADED' : 'OK';
    return { overall, evaluatedAt: this.lastEvaluatedAt, checks, heartbeat: { ...this.heartbeat }, restartWindow: this.restartWindowRaw };
  }

  lastSnapshotSeen(): SystemHealthSnapshot | null {
    return this.lastSnapshot;
  }

  private async dispatch(transition: HealthTransition): Promise<void> {
    if (this.deps.notify) {
      await this.deps.notify(transition).catch((err: any) => this.fastify.log.warn(`[SystemHealth] notify failed: ${err?.message || String(err)}`));
      return;
    }
    const level = transition.kind === 'recovered' ? 'info' : transition.severity === 'critical' ? 'error' : 'warn';
    (this.fastify.log as any)[level]?.(`[SystemHealth] ${transition.kind.toUpperCase()} ${transition.id}: ${transition.message}`);
    const recipients = await this.recipients();
    const dedupeSeconds = transition.kind === 'recovered' ? 5 * 60 : transition.stage <= 0 ? 10 * 60 : transition.stage === 1 ? 40 * 60 : 3 * 60 * 60;
    for (const userId of recipients) {
      await new DiscordAlertService(this.fastify).send({
        userId,
        title: transition.title,
        message: transition.message,
        severity: transition.kind === 'recovered' ? 'info' : transition.severity,
        category: `system-health:${transition.id}`,
        dedupeKey: `sys:${transition.id}:${transition.kind}:${transition.stage}:${userId}`,
        dedupeSeconds
      }).catch(() => false);
    }
  }

  /** Admin users (cached 5 min) or OPS_ALERT_USER_IDS; falls back to the env webhook via user 0. */
  private async recipients(): Promise<number[]> {
    const nowMs = this.now().getTime();
    if (this.recipientsCache && nowMs - this.recipientsCache.loadedAtMs < 5 * 60 * 1000) return this.recipientsCache.ids;
    const fromEnv = String(process.env.OPS_ALERT_USER_IDS || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0);
    let ids: number[] = fromEnv;
    if (ids.length === 0) {
      try {
        const { rows } = await (this.fastify as any).pg.query(`SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id`);
        ids = rows.map((r: any) => Number(r.id)).filter((v: number) => Number.isInteger(v) && v > 0);
      } catch {
        ids = this.recipientsCache?.ids || [];
      }
    }
    if (ids.length === 0) ids = [0];
    this.recipientsCache = { ids, loadedAtMs: nowMs };
    return ids;
  }

  private async mirrorToRedis(): Promise<void> {
    try {
      const firing: Record<string, { firedAtMs: number | null; lastNotifiedStage: number; lastNotifiedAtMs: number | null; message: string | null }> = {};
      for (const [id, rt] of this.runtime) {
        if (rt.state === 'firing') firing[id] = { firedAtMs: rt.firedAtMs, lastNotifiedStage: rt.lastNotifiedStage, lastNotifiedAtMs: rt.lastNotifiedAtMs, message: rt.message };
      }
      await redis.set(SUMMARY_KEY, JSON.stringify({ at: this.lastEvaluatedAt, firing }), SUMMARY_TTL_SECONDS);
    } catch { /* fail-open */ }
  }

  private async restoreFromRedis(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    try {
      const raw = await redis.get(SUMMARY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const firing = parsed?.firing || {};
      for (const [id, saved] of Object.entries<any>(firing)) {
        const rt = this.runtime.get(id);
        if (!rt) continue;
        rt.state = 'firing';
        rt.firedAtMs = saved.firedAtMs ?? this.now().getTime();
        rt.sinceMs = rt.firedAtMs;
        rt.lastNotifiedStage = Number.isFinite(saved.lastNotifiedStage) ? saved.lastNotifiedStage : 0;
        rt.lastNotifiedAtMs = saved.lastNotifiedAtMs ?? rt.firedAtMs;
        rt.message = saved.message || null;
      }
      this.fastify.log.info(`[SystemHealth] Restored ${Object.keys(firing).length} firing check(s) from Redis; no re-page.`);
    } catch { /* ignore */ }
  }

  /** 0 = Sunday … 6 = Saturday, in New York local time. */
  private newYorkWeekday(date: Date): number {
    const label = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(date);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
  }

  // ------------------------------------------------------------ heartbeat

  private async pingHeartbeat(): Promise<void> {
    if (!this.heartbeatUrl) return;
    const overall = this.summary().overall;
    const url = overall === 'CRITICAL' ? `${this.heartbeatUrl.replace(/\/$/, '')}/fail` : this.heartbeatUrl;
    const body = overall === 'CRITICAL'
      ? this.summary().checks.filter((c) => c.state === 'firing').map((c) => `${c.id}: ${c.message || ''}`).join('\n')
      : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetchImpl(url, { method: body ? 'POST' : 'GET', body, signal: controller.signal, headers: body ? { 'Content-Type': 'text/plain' } : undefined });
      this.heartbeat = { configured: true, lastPingAt: this.now().toISOString(), lastPingOk: response.ok, mode: overall === 'CRITICAL' ? 'fail' : 'ok' };
    } catch (err: any) {
      this.heartbeat = { configured: true, lastPingAt: this.now().toISOString(), lastPingOk: false, mode: overall === 'CRITICAL' ? 'fail' : 'ok' };
      this.fastify.log.warn(`[SystemHealth] heartbeat ping failed: ${err?.message || String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
