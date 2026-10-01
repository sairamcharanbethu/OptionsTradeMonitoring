import { evaluateReadiness, ReadinessResult, ReadinessSnapshot } from './trading-readiness';

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type ProcessWatchdogDeps = {
  collect: () => Promise<ReadinessSnapshot>;
  log: Logger;
  /** Called right before exit; must resolve quickly (best-effort alert). */
  onBeforeExit?: (reason: string, result: ReadinessResult) => Promise<void>;
  /** Count self-exits in a rolling window for the loop guard; return the new count or null when unavailable. */
  countSelfExit?: () => Promise<number | null>;
  exit?: (code: number) => void;
  now?: () => number;
  intervalMs?: number;
  graceMs?: number;
  armDelayMs?: number;
  loopGuardThreshold?: number;
};

export type ProcessWatchdogState = {
  armed: boolean;
  armsAt: string;
  wedgedSince: string | null;
  wedgedReasons: string[];
  graceMs: number;
  lastTickAt: string | null;
  lastLagMs: number | null;
  lastResult: ReadinessResult | null;
  exitsInWindow: number | null;
};

/**
 * Turns an internal wedge into a process exit so Docker's restart policy can
 * do its job (it only restarts on exit, never on "unhealthy"). Mirrors the
 * Python engine's write-stall watchdog. External outages are never a reason
 * to exit — the backend must stay up to alert about them.
 *
 * Rules: arm `armDelayMs` after start (services boot lazily); an internal
 * wedge must persist for `graceMs` before exiting; measure event-loop lag by
 * how late our own timer fires. Loop guard: if the process has self-exited
 * `loopGuardThreshold`+ times in the rolling window, double the grace (never
 * disable — one restart per few minutes still beats a wedged exit engine).
 */
export class ProcessWatchdog {
  static readonly DEFAULT_INTERVAL_MS = 30_000;
  static readonly DEFAULT_GRACE_MS = 5 * 60 * 1000;
  static readonly DEFAULT_ARM_DELAY_MS = 2 * 60 * 1000;
  static readonly DEFAULT_LOOP_GUARD_THRESHOLD = 3;

  private timer: NodeJS.Timeout | null = null;
  private readonly startedAtMs: number;
  private readonly armsAtMs: number;
  private graceMs: number;
  private readonly intervalMs: number;
  private lastTickMs: number | null = null;
  private lastLagMs: number | null = null;
  private wedgedSinceMs: number | null = null;
  private wedgedReasons: string[] = [];
  private lastResult: ReadinessResult | null = null;
  private exitsInWindow: number | null = null;
  private exiting = false;
  private ticking = false;
  private readonly now: () => number;

  constructor(private deps: ProcessWatchdogDeps) {
    this.now = deps.now || (() => Date.now());
    this.startedAtMs = this.now();
    this.intervalMs = deps.intervalMs || ProcessWatchdog.DEFAULT_INTERVAL_MS;
    this.graceMs = deps.graceMs ?? Number(process.env.WATCHDOG_GRACE_MS || ProcessWatchdog.DEFAULT_GRACE_MS);
    this.armsAtMs = this.startedAtMs + (deps.armDelayMs ?? ProcessWatchdog.DEFAULT_ARM_DELAY_MS);
  }

  async start(): Promise<void> {
    if (this.deps.countSelfExit) {
      // Read (without incrementing) via a count call that the caller
      // implements as "return current count"; the exit path increments.
      try {
        const count = await this.deps.countSelfExit();
        if (count !== null) this.applyLoopGuard(count, false);
      } catch { /* ignore */ }
    }
    this.lastTickMs = this.now();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    this.deps.log.info(`[ProcessWatchdog] armed in ${Math.round((this.armsAtMs - this.now()) / 1000)}s; grace ${Math.round(this.graceMs / 1000)}s; interval ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check. Exposed for tests; the timer calls it. */
  async tick(): Promise<ReadinessResult | null> {
    if (this.ticking || this.exiting) return null;
    this.ticking = true;
    try {
      const nowMs = this.now();
      // Event-loop lag: how late did this timer fire versus its schedule?
      const expected = this.lastTickMs === null ? nowMs : this.lastTickMs + this.intervalMs;
      this.lastLagMs = Math.max(0, nowMs - expected);
      this.lastTickMs = nowMs;

      let snapshot: ReadinessSnapshot;
      try {
        snapshot = await this.deps.collect();
      } catch (err: any) {
        this.deps.log.warn(`[ProcessWatchdog] collect failed: ${err?.message || String(err)}`);
        return null;
      }
      snapshot.eventLoopLagMs = this.lastLagMs;
      const result = evaluateReadiness(snapshot, new Date(nowMs));
      this.lastResult = result;

      const armed = nowMs >= this.armsAtMs;
      if (result.failing.length === 0) {
        if (this.wedgedSinceMs !== null) this.deps.log.info('[ProcessWatchdog] internal wedge cleared');
        this.wedgedSinceMs = null;
        this.wedgedReasons = [];
        return result;
      }
      this.wedgedReasons = result.failing;
      if (this.wedgedSinceMs === null) {
        this.wedgedSinceMs = nowMs;
        this.deps.log.warn(`[ProcessWatchdog] internal wedge detected${armed ? '' : ' (not armed yet)'}: ${result.failing.join('; ')}`);
      }
      if (!armed) return result;
      const wedgedFor = nowMs - this.wedgedSinceMs;
      if (wedgedFor >= this.graceMs) {
        await this.selfExit(`internal wedge for ${Math.round(wedgedFor / 1000)}s: ${result.failing.join('; ')}`, result);
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  state(): ProcessWatchdogState {
    return {
      armed: this.now() >= this.armsAtMs,
      armsAt: new Date(this.armsAtMs).toISOString(),
      wedgedSince: this.wedgedSinceMs ? new Date(this.wedgedSinceMs).toISOString() : null,
      wedgedReasons: [...this.wedgedReasons],
      graceMs: this.graceMs,
      lastTickAt: this.lastTickMs ? new Date(this.lastTickMs).toISOString() : null,
      lastLagMs: this.lastLagMs,
      lastResult: this.lastResult,
      exitsInWindow: this.exitsInWindow
    };
  }

  private applyLoopGuard(count: number, log: boolean) {
    this.exitsInWindow = count;
    const threshold = this.deps.loopGuardThreshold ?? ProcessWatchdog.DEFAULT_LOOP_GUARD_THRESHOLD;
    if (count >= threshold) {
      const doubled = this.graceMs * 2;
      if (log) this.deps.log.error(`[ProcessWatchdog] ${count} self-exits in the window; doubling grace to ${Math.round(doubled / 1000)}s (never disabled)`);
      this.graceMs = doubled;
    }
  }

  private async selfExit(reason: string, result: ReadinessResult): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.deps.log.error(`[ProcessWatchdog] EXITING so the container restarts — ${reason}`);
    try {
      if (this.deps.countSelfExit) {
        const count = await this.deps.countSelfExit();
        if (count !== null) this.applyLoopGuard(count + 1, true);
      }
    } catch { /* ignore */ }
    try {
      if (this.deps.onBeforeExit) {
        await Promise.race([
          this.deps.onBeforeExit(reason, result),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
      }
    } catch { /* ignore */ }
    (this.deps.exit || ((code: number) => process.exit(code)))(1);
  }
}
