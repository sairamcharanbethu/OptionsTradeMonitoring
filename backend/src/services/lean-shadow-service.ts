import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { FastifyInstance } from 'fastify';
import { getNewYorkMarketState } from '../lib/market-calendar';

type StrategySnapshot = Record<string, any>;

export type LeanShadowSnapshotEnvelope = {
  runId: string;
  revision: string;
  sequence: number;
  generatedAt: string;
  signals: Record<string, StrategySnapshot>;
  health: Record<string, any>;
};

type LeanShadowComparison = {
  lane: string;
  qualified: boolean;
  matches: boolean;
  reasons: string[];
};

const EXPECTED_LANES = ['mtf', 'orb_index', 'vwap_trend'];
const MAX_SIGNATURE_AGE_MS = 60_000;
const MIN_SESSION_SAMPLES = 300;
const REQUIRED_COMPLETED_SESSIONS = 10;

function stableJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function selectedPlan(snapshot: StrategySnapshot): Record<string, any> {
  const side = String(snapshot?.favoring || '').toLowerCase();
  return side === 'calls' ? snapshot.call_setup || {} : side === 'puts' ? snapshot.put_setup || {} : {};
}

function planComparison(reference: StrategySnapshot | undefined, candidate: StrategySnapshot): LeanShadowComparison {
  const lane = String(candidate.strategy_lane || 'unknown');
  const referencePlan = selectedPlan(reference || {});
  const candidatePlan = selectedPlan(candidate);
  const referenceReady = String(reference?.state || '') === 'ACTIVE' && reference?.lifecycle?.entry_allowed === true;
  const candidateReady = String(candidate.state || '') === 'ACTIVE' && candidate.lifecycle?.entry_allowed === true;
  if (!referenceReady || !candidateReady) {
    return { lane, qualified: false, matches: false, reasons: ['both engines are not trade-ready'] };
  }
  const reasons: string[] = [];
  if (reference?.favoring !== candidate.favoring) reasons.push('direction differs');
  const referenceOption = referencePlan.option || {};
  const candidateOption = candidatePlan.option || {};
  if (String(referenceOption.expiry || '') !== String(candidateOption.expiry || '')) reasons.push('expiry differs');
  const strikeGap = Math.abs(Number(referenceOption.strike) - Number(candidateOption.strike));
  if (!Number.isFinite(strikeGap) || strikeGap > 1) reasons.push('strike differs by more than one SPY strike');
  for (const [label, tolerance, left, right] of [
    ['trigger', 0.05, referencePlan.trigger, candidatePlan.trigger],
    ['invalidation', 0.05, referencePlan.invalidation, candidatePlan.invalidation],
    ['target', 0.10, (referencePlan.targets || []).at(-1), (candidatePlan.targets || []).at(-1)]
  ] as Array<[string, number, any, any]>) {
    const gap = Math.abs(Number(left) - Number(right));
    if (!Number.isFinite(gap) || gap > tolerance) reasons.push(`${label} differs beyond $${tolerance.toFixed(2)}`);
  }
  return { lane, qualified: true, matches: reasons.length === 0, reasons };
}

export class LeanShadowService {
  private latest: LeanShadowSnapshotEnvelope | null = null;
  private lastReceivedAt: string | null = null;
  private lastError: string | null = null;
  private orderGuardViolation = false;
  private authority: 'python' | 'lean' = 'python';
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly fastify: FastifyInstance) {}

  async start(): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT source, entry_blocked FROM strategy_engine_authority WHERE singleton=true LIMIT 1`
    );
    if (rows[0]?.source === 'lean') this.authority = 'lean';
    (this.fastify as any).strategyEngine?.setSignalSource(this.authority, rows[0]?.entry_blocked === true);
    await (this.fastify as any).pg.query(`DELETE FROM lean_shadow_nonces WHERE expires_at < NOW()`);
    this.timer = setInterval(() => this.refreshEntrySafety().catch((error: any) => {
      this.lastError = error.message || String(error);
      this.fastify.log.error(`[LeanShadow] Safety refresh failed: ${this.lastError}`);
    }), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public getAuthority(): 'python' | 'lean' {
    return this.authority;
  }

  public getHealth() {
    const ageSeconds = this.lastReceivedAt ? Math.max(0, (Date.now() - new Date(this.lastReceivedAt).getTime()) / 1000) : null;
    const healthy = this.latest !== null && ageSeconds !== null && ageSeconds <= 15 && this.latest.health?.connected === true;
    return {
      status: this.orderGuardViolation || this.lastError ? 'DEGRADED' : healthy ? 'UP' : this.latest ? 'DEGRADED' : 'STARTING',
      authority: this.authority,
      runId: this.latest?.runId || null,
      revision: this.latest?.revision || null,
      freshnessMs: ageSeconds === null ? null : Math.round(ageSeconds * 1000),
      lastSeen: this.lastReceivedAt,
      connected: this.latest?.health?.connected === true,
      orderGuard: this.orderGuardViolation ? 'VIOLATED' : this.latest?.health?.order_guard === 'ARMED' ? 'ARMED' : 'UNKNOWN',
      lastError: this.lastError,
      signals: this.latest?.signals || {}
    };
  }

  public async authenticate(headers: Record<string, any>, body: unknown): Promise<void> {
    if (process.env.LEAN_SHADOW_ENABLED !== 'true') throw this.failure(503, 'LEAN shadow ingestion is disabled');
    const secret = String(process.env.LEAN_SHADOW_INGEST_SECRET || '');
    if (secret.length < 32) throw this.failure(503, 'LEAN shadow ingestion secret is not configured');
    const timestamp = String(headers['x-lean-timestamp'] || '');
    const nonce = String(headers['x-lean-nonce'] || '');
    const signature = String(headers['x-lean-signature'] || '');
    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt * 1000) > MAX_SIGNATURE_AGE_MS) {
      throw this.failure(401, 'LEAN request timestamp is expired');
    }
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
      throw this.failure(401, 'LEAN request signature is invalid');
    }
    const bodyHash = createHash('sha256').update(stableJson(body)).digest('hex');
    const expected = createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      throw this.failure(401, 'LEAN request signature does not match');
    }
    const nonceResult = await (this.fastify as any).pg.query(
      `INSERT INTO lean_shadow_nonces (nonce, expires_at) VALUES ($1, NOW() + INTERVAL '5 minutes') ON CONFLICT DO NOTHING RETURNING nonce`,
      [nonce]
    );
    if (!nonceResult.rows?.[0]) throw this.failure(409, 'LEAN request replay detected');
  }

  public async ingestSnapshot(envelope: LeanShadowSnapshotEnvelope): Promise<{ comparisons: LeanShadowComparison[] }> {
    this.validateEnvelope(envelope);
    const generatedAt = new Date(envelope.generatedAt);
    if (Number.isNaN(generatedAt.getTime())) throw this.failure(400, 'LEAN generatedAt must be an ISO timestamp');
    const pythonSignals = Object.fromEntries(
      (((this.fastify as any).strategyEngine?.getCurrentState?.().strategySignals || []) as Array<any>)
        .map(item => [String(item.lane), item.signal])
    ) as Record<string, StrategySnapshot>;
    const comparisons = EXPECTED_LANES.map(lane => planComparison(pythonSignals[lane], envelope.signals[lane]));
    await (this.fastify as any).pg.query(
      `INSERT INTO strategy_engine_runs (run_id, source, revision, status, started_at, last_seen_at)
       VALUES ($1, 'lean', $2, 'SHADOW', NOW(), NOW())
       ON CONFLICT (run_id) DO UPDATE SET revision=EXCLUDED.revision, last_seen_at=NOW()`,
      [envelope.runId, envelope.revision]
    );
    const healthy = envelope.health?.connected === true && envelope.health?.order_guard === 'ARMED';
    await (this.fastify as any).pg.query(
      `INSERT INTO lean_shadow_snapshots (run_id, sequence, generated_at, payload, health)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [envelope.runId, envelope.sequence, generatedAt, JSON.stringify(envelope.signals), JSON.stringify(envelope.health)]
    );
    for (const comparison of comparisons) {
      const candidate = envelope.signals[comparison.lane] || {};
      const candidatePlan = selectedPlan(candidate);
      const planKey = comparison.qualified
        ? createHash('sha256').update(stableJson({
          lane: comparison.lane,
          favoring: candidate.favoring,
          trigger: candidatePlan.trigger,
          invalidation: candidatePlan.invalidation,
          targets: candidatePlan.targets,
          option: candidatePlan.option
        })).digest('hex')
        : null;
      await (this.fastify as any).pg.query(
        `INSERT INTO lean_shadow_comparisons (run_id, lane, generated_at, healthy, qualified, matches, plan_key, reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [envelope.runId, comparison.lane, generatedAt, healthy, comparison.qualified, comparison.matches, planKey, JSON.stringify(comparison.reasons)]
      );
    }
    if (envelope.health?.order_guard === 'VIOLATED') {
      this.orderGuardViolation = true;
      this.lastError = 'LEAN order guard reported an attempted brokerage order';
    }
    this.latest = envelope;
    this.lastReceivedAt = new Date().toISOString();
    if (envelope.health?.connected === true && !this.orderGuardViolation) this.lastError = null;
    if (this.authority === 'lean') {
      if (healthy && !this.orderGuardViolation) {
        await this.setEntryBlocked(false, null);
        await (this.fastify as any).strategyEngine?.ingestLeanSnapshot(envelope.signals, envelope.health);
      } else {
        await this.setEntryBlocked(true, 'LEAN_PRIMARY_UNHEALTHY');
      }
    } else {
      await this.maybePromote();
    }
    return { comparisons };
  }

  private async refreshEntrySafety(): Promise<void> {
    if (this.authority !== 'lean') return;
    const health = this.getHealth();
    if (health.status !== 'UP') {
      await this.setEntryBlocked(true, 'LEAN_PRIMARY_UNHEALTHY');
      await this.maybeFailBackWhenFlat();
    }
  }

  private async setEntryBlocked(entryBlocked: boolean, reason: string | null): Promise<void> {
    await (this.fastify as any).pg.query(
      `UPDATE strategy_engine_authority
       SET entry_blocked=$1, reason=$2, updated_at=NOW()
       WHERE singleton=true`,
      [entryBlocked, reason]
    );
    (this.fastify as any).strategyEngine?.setSignalSource(this.authority, entryBlocked);
  }

  private async maybePromote(): Promise<void> {
    if (process.env.LEAN_AUTO_PROMOTE === 'false' || this.orderGuardViolation) return;
    const market = getNewYorkMarketState();
    // Promotion is deliberately limited to the quiet pre-market window.
    if (!market.isWeekday || market.isHoliday || market.minutes < 8 * 60 + 45 || market.minutes >= 9 * 60 + 30) return;
    const open = await (this.fastify as any).pg.query(
      `SELECT 1 FROM positions WHERE status IN ('OPEN', 'PENDING_ORDER') LIMIT 1`
    );
    if (open.rows?.length) return;
    const sessions = await (this.fastify as any).pg.query(
      `WITH daily AS (
         SELECT lane,
                (generated_at AT TIME ZONE 'America/New_York')::date AS market_date,
                COUNT(*) AS samples,
                COUNT(*) FILTER (WHERE healthy) AS healthy_samples,
                COUNT(*) FILTER (WHERE qualified) AS qualified_samples,
                COUNT(*) FILTER (WHERE qualified AND matches) AS matching_samples
         FROM lean_shadow_comparisons
         WHERE generated_at < date_trunc('day', NOW() AT TIME ZONE 'America/New_York')
         GROUP BY lane, (generated_at AT TIME ZONE 'America/New_York')::date
       ), eligible AS (
         SELECT lane, market_date
         FROM daily
         WHERE samples >= $1
           AND healthy_samples::numeric / samples >= 0.99
           AND qualified_samples > 0
           AND matching_samples::numeric / qualified_samples >= 0.95
       )
       SELECT lane, COUNT(*)::int AS completed_sessions
       FROM eligible
       GROUP BY lane`,
      [MIN_SESSION_SAMPLES]
    );
    const laneCounts = Object.fromEntries((sessions.rows || []).map((row: any) => [row.lane, Number(row.completed_sessions)]));
    if (!EXPECTED_LANES.every(lane => laneCounts[lane] >= REQUIRED_COMPLETED_SESSIONS)) return;
    const episodes = await (this.fastify as any).pg.query(
      `SELECT lane, COUNT(DISTINCT plan_key)::int AS plans
       FROM lean_shadow_comparisons
       WHERE qualified AND plan_key IS NOT NULL
       GROUP BY lane`
    );
    const planCounts = Object.fromEntries((episodes.rows || []).map((row: any) => [row.lane, Number(row.plans)]));
    if (!EXPECTED_LANES.every(lane => planCounts[lane] >= 10)) return;
    this.authority = 'lean';
    await this.setEntryBlocked(false, 'LEAN_AUTO_PROMOTED');
    this.fastify.log.warn('[LeanShadow] Promoted LEAN to the signal source after strict shadow qualification.');
  }

  private async maybeFailBackWhenFlat(): Promise<void> {
    const market = getNewYorkMarketState();
    if (!market.isWeekday || market.isHoliday || market.minutes >= 9 * 60 + 30) return;
    const open = await (this.fastify as any).pg.query(
      `SELECT 1 FROM positions WHERE status IN ('OPEN', 'PENDING_ORDER') LIMIT 1`
    );
    if (open.rows?.length) return;
    this.authority = 'python';
    await this.setEntryBlocked(false, 'LEAN_FAILBACK_WHILE_FLAT');
    this.fastify.log.warn('[LeanShadow] Returned signal authority to the warm Python engine while flat.');
  }

  private validateEnvelope(envelope: LeanShadowSnapshotEnvelope): void {
    if (!/^[a-zA-Z0-9._-]{8,128}$/.test(String(envelope.runId || ''))) throw this.failure(400, 'LEAN runId is invalid');
    if (!/^[a-zA-Z0-9._:-]{7,128}$/.test(String(envelope.revision || ''))) throw this.failure(400, 'LEAN revision is invalid');
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence <= 0) throw this.failure(400, 'LEAN sequence must be a positive integer');
    if (!envelope.signals || typeof envelope.signals !== 'object') throw this.failure(400, 'LEAN signals are required');
    for (const lane of EXPECTED_LANES) {
      const signal = envelope.signals[lane];
      if (!signal || signal.engine_version !== 'signal-only-v2' || signal.execution_enabled !== false || signal.strategy_lane !== lane) {
        throw this.failure(400, `LEAN ${lane} signal does not meet the signal-only-v2 contract`);
      }
    }
  }

  private failure(statusCode: number, message: string): Error {
    const error: any = new Error(message);
    error.statusCode = statusCode;
    return error;
  }
}

export const leanShadowStableJson = stableJson;
export const compareLeanShadowPlan = planComparison;
