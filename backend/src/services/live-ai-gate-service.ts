import { FastifyInstance } from 'fastify';
import { AIService } from './ai-service';
import { PaperTradingService, PaperDecision } from './paper-trading-service';
import { TradeRedisService } from './trade-redis-service';

/**
 * AI gate for AUTONOMOUS LIVE entries.
 *
 * Modes (per-user setting `autonomous_live_ai_mode`):
 *   off      — never called.
 *   advisory — called and recorded on every candidate entry, never blocks and
 *              never sizes; use this to build an evidence base first.
 *   gate     — a SKIP verdict blocks the entry; the risk tier caps size
 *              (CAUTIOUS = 1 contract). Default, per operator request.
 *
 * Boundaries the model cannot cross: it never picks the contract, stop, or
 * targets (the engine's frozen plan does), and it runs only after every
 * deterministic gate (session window, freshness, plan quality, lifecycle) has
 * passed. It is the last check, not a replacement for them.
 *
 * Failure policy (`autonomous_live_ai_fallback`): on timeout, provider error,
 * malformed JSON or exhausted daily budget, `trade_cautious` (default) lets
 * the entry through at one contract and flags it; `skip` blocks it.
 *
 * Every verdict is written to trade_events (AI_LIVE_GATE) with the signal id,
 * so verdicts can be joined to outcomes and the gate's value measured.
 */
export type LiveAiGateMode = 'off' | 'advisory' | 'gate';
export type LiveAiFallback = 'trade_cautious' | 'skip';

export interface LiveAiVerdict {
  mode: LiveAiGateMode;
  decision: 'TRADE' | 'SKIP';
  riskTier: 'CAUTIOUS' | 'STANDARD' | 'FULL';
  exitProfile: string;
  rationale: string;
  riskFlags: string[];
  source: 'AI' | 'FALLBACK' | 'BUDGET' | 'OFF';
  blocks: boolean;
  latencyMs: number;
  aiRequested: boolean;
}

export interface LiveAiGateInput {
  userId: number;
  signalId: number;
  signal: Record<string, any>;
  settings: Record<string, string>;
  riskContext?: Record<string, any>;
  now?: Date;
}

type AskFn = (prompt: string, userId: number, maxTokens: number, timeoutMs: number) => Promise<any>;

export class LiveAiGateService {
  static readonly DEFAULT_DAILY_BUDGET = 30;
  static readonly TIMEOUT_MS = 15_000;
  static readonly PROMPT_VERSION = 'live-gate-v1';

  constructor(private fastify: FastifyInstance, private ask?: AskFn) {}

  static mode(settings: Record<string, string> | undefined): LiveAiGateMode {
    const raw = String(settings?.autonomous_live_ai_mode || 'gate').trim().toLowerCase();
    return raw === 'off' || raw === 'advisory' ? raw : 'gate';
  }

  static fallback(settings: Record<string, string> | undefined): LiveAiFallback {
    return String(settings?.autonomous_live_ai_fallback || '').trim().toLowerCase() === 'skip' ? 'skip' : 'trade_cautious';
  }

  static dailyBudget(settings: Record<string, string> | undefined): number {
    const raw = Number(settings?.live_ai_daily_call_budget);
    return Number.isInteger(raw) && raw >= 0 && raw <= 500 ? raw : this.DEFAULT_DAILY_BUDGET;
  }

  static side(signal: Record<string, any>): 'CALL' | 'PUT' {
    return signal?.favoring === 'puts' ? 'PUT' : 'CALL';
  }

  /** Compact, deterministic prompt: only fields the engine already froze. */
  static buildPrompt(signal: Record<string, any>, riskContext: Record<string, any> = {}): string {
    const side = this.side(signal);
    const setup = (side === 'CALL' ? signal.call_setup : signal.put_setup) || {};
    const option = setup.option || {};
    const gex = signal.gex || {};
    const session = signal.session_policy || {};
    const facts = {
      strategy: signal.strategy,
      side,
      confidence_score: signal.confidence_score,
      plan: {
        trigger: setup.trigger,
        invalidation: setup.invalidation,
        targets: setup.targets,
        reward_risk: setup.plan_quality?.reward_risk
      },
      option: {
        strike: option.strike,
        expiry: option.expiry,
        mid: option.mid,
        spread_pct: option.spread_pct,
        delta: option.delta,
        quote_age_seconds: option.quote_age_seconds,
        planned_contracts: option.planned_contracts,
        stop_risk_per_contract: option.estimated_stop_risk?.per_contract_dollars
      },
      gex: {
        regime: gex.regime,
        gamma_regime: gex.gamma_regime,
        call_wall: gex.call_wall,
        put_wall: gex.put_wall,
        flip: gex.flip,
        net_gex_percentile: signal.zerogex_decision?.gex_history?.net_gex_30d_percentile,
        source: gex.source
      },
      zerogex_state: signal.zerogex_decision?.state || signal.zerogex_decision?.regime,
      market: {
        rvol_1m: signal.market_context?.rvol_1m,
        vwap: signal.market_context?.vwap,
        atr_5m: signal.market_context?.atr_5m
      },
      session: { event_day: session.event_day || null, entry_cutoff_minute_et: session.entry_cutoff_minute_et },
      warnings: (signal.warnings || []).slice(0, 6),
      risk: riskContext
    };
    return `You are the final risk reviewer for one autonomous 0DTE index option entry. The contract, stop and targets are fixed by the strategy engine; you may only TRADE or SKIP and set a size tier.
Rules: SKIP when the supplied facts show degraded edge (thin/late tape, GEX conflict with direction, event risk, wide spread, stale quote, weak reward/risk, warnings that undercut the setup). Prefer CAUTIOUS when uncertain. Never invent facts.
Facts: ${JSON.stringify(facts)}
Respond only JSON: {"decision":"TRADE|SKIP","risk_tier":"CAUTIOUS|STANDARD|FULL","exit_profile":"CONSERVATIVE_T1|BALANCED_T2","rationale":"one sentence","risk_flags":["short"]}`;
  }

  private async callsToday(userId: number, now: Date): Promise<number> {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT COUNT(*)::int AS count
         FROM trade_events
        WHERE user_id = $1
          AND event_type = 'AI_LIVE_GATE'
          AND (metadata->>'ai_requested') = 'true'
          AND (created_at AT TIME ZONE 'America/New_York')::date = ($2::timestamptz AT TIME ZONE 'America/New_York')::date`,
      [userId, now.toISOString()]
    );
    return Number(rows?.[0]?.count || 0);
  }

  private fallbackVerdict(mode: LiveAiGateMode, fallback: LiveAiFallback, source: 'FALLBACK' | 'BUDGET', reason: string, latencyMs: number, aiRequested: boolean): LiveAiVerdict {
    const skip = fallback === 'skip';
    return {
      mode,
      decision: skip ? 'SKIP' : 'TRADE',
      riskTier: 'CAUTIOUS',
      exitProfile: 'BALANCED_T2',
      rationale: `${reason} ${skip ? 'Entry skipped by fallback policy.' : 'One-contract fallback applied.'}`,
      riskFlags: [source === 'BUDGET' ? 'AI daily budget reached' : 'AI review unavailable'],
      source,
      blocks: mode === 'gate' && skip,
      latencyMs,
      aiRequested
    };
  }

  async decide(input: LiveAiGateInput): Promise<LiveAiVerdict> {
    const mode = LiveAiGateService.mode(input.settings);
    const now = input.now || new Date();
    if (mode === 'off') {
      return { mode, decision: 'TRADE', riskTier: 'STANDARD', exitProfile: 'BALANCED_T2', rationale: 'AI gate off.', riskFlags: [], source: 'OFF', blocks: false, latencyMs: 0, aiRequested: false };
    }
    const fallback = LiveAiGateService.fallback(input.settings);
    const startedAt = Date.now();
    let verdict: LiveAiVerdict;
    let usage: any = null;
    const budget = LiveAiGateService.dailyBudget(input.settings);
    const used = await this.callsToday(input.userId, now).catch(() => 0);
    if (used >= budget) {
      verdict = this.fallbackVerdict(mode, fallback, 'BUDGET', `Daily live AI budget of ${budget} calls reached.`, 0, false);
    } else {
      try {
        const prompt = LiveAiGateService.buildPrompt(input.signal, input.riskContext);
        const ask: AskFn = this.ask || ((p, u, t, ms) => new AIService(this.fastify).askTradingJSON(p, u, t, ms));
        const raw = await ask(prompt, input.userId, 200, LiveAiGateService.TIMEOUT_MS);
        usage = raw?.usage || null;
        const normalized: PaperDecision | null = PaperTradingService.normalizeAIDecision(raw);
        const latencyMs = Date.now() - startedAt;
        verdict = normalized
          ? {
              mode,
              decision: normalized.decision,
              riskTier: normalized.riskTier,
              exitProfile: normalized.exitProfile,
              rationale: normalized.rationale || '',
              riskFlags: normalized.riskFlags || [],
              source: 'AI',
              blocks: mode === 'gate' && normalized.decision === 'SKIP',
              latencyMs,
              aiRequested: true
            }
          : this.fallbackVerdict(mode, fallback, 'FALLBACK', 'AI reply was malformed.', latencyMs, true);
      } catch (err: any) {
        verdict = this.fallbackVerdict(mode, fallback, 'FALLBACK', `AI call failed (${err?.message || String(err)}).`.slice(0, 200), Date.now() - startedAt, true);
      }
    }
    await TradeRedisService.recordEvent((this.fastify as any).pg, {
      userId: input.userId,
      signalId: input.signalId,
      eventType: 'AI_LIVE_GATE',
      message: `${verdict.mode.toUpperCase()} ${verdict.decision} ${verdict.riskTier} (${verdict.source}): ${verdict.rationale}`.slice(0, 500),
      metadata: {
        ai_requested: verdict.aiRequested ? 'true' : 'false',
        mode: verdict.mode,
        decision: verdict.decision,
        risk_tier: verdict.riskTier,
        exit_profile: verdict.exitProfile,
        source: verdict.source,
        blocks: verdict.blocks,
        rationale: verdict.rationale,
        risk_flags: verdict.riskFlags,
        latency_ms: verdict.latencyMs,
        prompt_version: LiveAiGateService.PROMPT_VERSION,
        strategy: input.signal?.strategy || null,
        side: LiveAiGateService.side(input.signal),
        setup_id: input.signal?.setup_id || null,
        usage
      }
    }).catch((err: any) => this.fastify.log.warn(`[LiveAiGate] Failed to record verdict: ${err?.message || String(err)}`));
    return verdict;
  }
}
