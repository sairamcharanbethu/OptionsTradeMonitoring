import { FastifyInstance } from 'fastify';
import { getNewYorkDateParts, getNewYorkMarketState, getUSMarketCloseMinutes } from '../lib/market-calendar';
import { getGlobalSettings } from '../lib/settings-utils';
import { IbkrMarketDataService, IbkrOptionChainQuote } from './ibkr-market-data-service';
import {
  contextFromZeroGex, evaluateWallReaction, newWallReactionCandidateId,
  WallReactionContext, WallReactionDecision, wallReactionFingerprint
} from './wall-reaction-engine';
import { blockingEconomicEvent, WallReactionProviders, WallReactionSymbol } from './wall-reaction-providers';

export const WALL_REACTION_POLICY_VERSION = 'wall-reaction-v1';
const SYMBOLS: WallReactionSymbol[] = ['SPY', 'QQQ'];
const LOOP_MS = 20_000;
const CALENDAR_REFRESH_MS = 15 * 60_000;

export type WallReactionPlan = {
  wall: number;
  invalidation: number;
  target1: number;
  target2: number | null;
  riskPoints: number;
  baseRiskDollars: number;
  debitBudget: number;
};

export type WallReactionContract = {
  ticker: string;
  expiration: string;
  right: 'call' | 'put';
  strike: number;
  bid: number;
  ask: number;
  mark: number;
  spreadPct: number;
  delta: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  quoteTimestamp: string;
  protectedLimit: number;
  quantity: number;
};

export type WallReactionCandidate = {
  id: string;
  symbol: WallReactionSymbol;
  fingerprint: string;
  status: string;
  generatedAt: string;
  context: WallReactionContext | null;
  decision: WallReactionDecision;
  macro: ReturnType<typeof blockingEconomicEvent>;
  plan: WallReactionPlan | null;
  contract: WallReactionContract | null;
};

function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}

export function buildWallReactionPlan(
  context: WallReactionContext,
  decision: WallReactionDecision,
  baseRiskDollars: number
): WallReactionPlan | null {
  if (!['CALL_WALL_FADE', 'PUT_WALL_BOUNCE'].includes(decision.code) || decision.riskMultiplier <= 0) return null;
  const bufferPct = Number(context.trap.breakout_buffer_pct);
  if (!Number.isFinite(bufferPct) || bufferPct <= 0 || bufferPct > 1) return null;
  const bearish = decision.direction === 'bearish';
  const wall = bearish ? context.callWall : context.putWall;
  const invalidation = wall * (bearish ? 1 + bufferPct / 100 : 1 - bufferPct / 100);
  const riskPoints = Math.abs(context.spot - invalidation);
  if (!(riskPoints > 0)) return null;
  const favorable = [context.maxPain, context.gammaFlip, bearish ? context.putWall : context.callWall]
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .filter((value, index, rows) => rows.indexOf(value) === index)
    .filter((value) => bearish ? value < context.spot : value > context.spot)
    .sort((a, b) => bearish ? b - a : a - b);
  const reward = (target: number) => Math.abs(target - context.spot);
  const target1 = favorable.find((target) => reward(target) >= riskPoints);
  if (target1 === undefined) return null;
  const target2 = favorable.find((target) => target !== target1 && reward(target) >= riskPoints * 2) ?? null;
  const normalizedBaseRisk = Math.max(50, Math.min(10_000, baseRiskDollars));
  return {
    wall: round(wall), invalidation: round(invalidation), target1: round(target1),
    target2: target2 === null ? null : round(target2), riskPoints: round(riskPoints, 4),
    baseRiskDollars: round(normalizedBaseRisk), debitBudget: round(normalizedBaseRisk * decision.riskMultiplier)
  };
}

export function chooseWallReactionExpiration(expirations: string[], now = new Date()): string | null {
  const { dateKey, minutes } = getNewYorkDateParts(now);
  const listed = [...new Set(expirations)].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= dateKey).sort();
  if (minutes < 13 * 60 && listed.includes(dateKey)) return dateKey;
  return listed.find((value) => value > dateKey) || null;
}

export function selectWallReactionContract(
  chain: IbkrOptionChainQuote[],
  direction: WallReactionDecision['direction'],
  spot: number,
  plan: WallReactionPlan,
  now = new Date()
): WallReactionContract | null {
  const right = direction === 'bearish' ? 'put' : direction === 'bullish' ? 'call' : null;
  if (!right) return null;
  const eligible = chain.filter((quote) => {
    const age = quote.timestamp ? (now.getTime() - Date.parse(quote.timestamp)) / 1000 : NaN;
    const isOtm = right === 'call' ? quote.strike >= spot : quote.strike <= spot;
    return quote.right === right && isOtm
      && Number.isFinite(age) && age >= -5 && age <= 15
      && Number(quote.bid) > 0 && Number(quote.ask) >= Number(quote.bid) && Number(quote.mark) > 0
      && Number(quote.spreadPct) <= 5 && Number(quote.volume) > 0 && Number(quote.openInterest) > 0
      && Number(quote.impliedVolatility) > 0 && Math.abs(Number(quote.delta)) >= 0.15 && Math.abs(Number(quote.delta)) <= 0.65;
  }).sort((a, b) => Math.abs(Math.abs(Number(a.delta)) - 0.4) - Math.abs(Math.abs(Number(b.delta)) - 0.4));
  const quote = eligible[0];
  if (!quote || !quote.timestamp || quote.bid === null || quote.ask === null || quote.mark === null || quote.spreadPct === null
    || quote.delta === null || quote.volume === null || quote.openInterest === null || quote.impliedVolatility === null) return null;
  const protectedLimit = round(Math.min(quote.ask, quote.mark + (quote.ask - quote.mark) * 0.2));
  let quantity = Math.min(2, Math.floor(plan.debitBudget / (protectedLimit * 100)));
  if (plan.target2 === null) quantity = Math.min(quantity, 1);
  if (quantity < 1) return null;
  return {
    ticker: quote.ticker, expiration: quote.expiration, right, strike: quote.strike,
    bid: quote.bid, ask: quote.ask, mark: quote.mark, spreadPct: quote.spreadPct,
    delta: quote.delta, volume: quote.volume, openInterest: quote.openInterest,
    impliedVolatility: quote.impliedVolatility, quoteTimestamp: quote.timestamp, protectedLimit, quantity
  };
}

function standDown(reason: string): WallReactionDecision {
  return { code: 'STAND_DOWN', setup: 'runtime_gate', direction: 'neutral', confidence: 0, riskMultiplier: 0, action: reason, reasons: [reason], warnings: [] };
}

export class WallReactionService {
  private readonly providers = new WallReactionProviders();
  private readonly marketData: IbkrMarketDataService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastCalendarRefresh = 0;
  private lastCalendarAttempt = 0;
  private state = new Map<WallReactionSymbol, WallReactionCandidate>();
  private health = { status: 'IDLE', lastRunAt: null as string | null, lastError: null as string | null };

  constructor(private readonly fastify: FastifyInstance) {
    this.marketData = (fastify as any).ibkrMarketData || new IbkrMarketDataService(fastify);
  }

  public start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), LOOP_MS);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public getState() {
    return { policyVersion: WALL_REACTION_POLICY_VERSION, health: this.health, symbols: Object.fromEntries(this.state) };
  }

  public getCandidate(symbol: WallReactionSymbol): WallReactionCandidate | null {
    return this.state.get(symbol) || null;
  }

  public async getHistory(limit = 50, offset = 0) {
    const { rows } = await (this.fastify as any).pg.query(
      `SELECT id, symbol, fingerprint, decision_code AS "decisionCode", status, context, plan, contract,
              generated_at AS "generatedAt", armed_at AS "armedAt", armed_until AS "armedUntil",
              entered_at AS "enteredAt", invalidated_at AS "invalidatedAt"
       FROM wall_reaction_candidates ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
    );
    return rows;
  }

  public async run(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.health = { ...this.health, status: 'RUNNING', lastRunAt: now.toISOString() };
    try {
      const settings = await getGlobalSettings((this.fastify as any).pg);
      if (settings.wall_reaction_enabled === 'false') {
        for (const symbol of SYMBOLS) await this.storeGated(symbol, 'Wall Reaction is disabled in Settings', now);
        this.health = { status: 'DISABLED', lastRunAt: now.toISOString(), lastError: null };
        return;
      }
      const apiKey = settings.trading_economics_api_key || '';
      const calendarRetryMs = this.lastCalendarRefresh ? CALENDAR_REFRESH_MS : 60_000;
      if (Date.now() - this.lastCalendarAttempt >= calendarRetryMs) {
        this.lastCalendarAttempt = Date.now();
        try {
          await this.providers.refreshCalendar(apiKey, now);
          this.lastCalendarRefresh = Date.now();
        } catch (error: any) {
          this.fastify.log.warn(`[WallReaction] Economic calendar refresh failed: ${error.message}`);
        }
      }
      const results = await Promise.allSettled(SYMBOLS.map((symbol) => this.runSymbol(symbol, settings, now)));
      const errors = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason?.message || result.reason)] : []);
      this.health = { status: errors.length ? 'DEGRADED' : 'UP', lastRunAt: now.toISOString(), lastError: errors.join('; ') || null };
    } catch (error: any) {
      this.health = { status: 'ERROR', lastRunAt: now.toISOString(), lastError: error.message || String(error) };
      this.fastify.log.error(`[WallReaction] Runtime failed: ${this.health.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async storeGated(symbol: WallReactionSymbol, reason: string, now: Date): Promise<void> {
    const decision = standDown(reason);
    const candidate: WallReactionCandidate = {
      id: newWallReactionCandidateId(), symbol, fingerprint: wallReactionFingerprint(symbol, decision, {}), status: 'BLOCKED',
      generatedAt: now.toISOString(), context: null, decision, macro: { blocked: true, reason, event: null }, plan: null, contract: null
    };
    this.state.set(symbol, candidate);
    await this.persist(candidate);
  }

  private async runSymbol(symbol: WallReactionSymbol, settings: Record<string, string>, now: Date): Promise<void> {
    try {
      const [snapshot, bars] = await Promise.all([
        this.providers.readZeroGex(symbol),
        this.marketData.getHistoricalBars(symbol, '5 D', '1 min')
      ]);
      const context = contextFromZeroGex(snapshot, bars, now);
      let decision = evaluateWallReaction(context);
      const macro = blockingEconomicEvent(this.providers.getCalendar(), now);
      const market = getNewYorkMarketState(now);
      const closeMinutes = getUSMarketCloseMinutes(now);
      if (['CALL_WALL_FADE', 'PUT_WALL_BOUNCE'].includes(decision.code)) {
        if (macro.blocked) decision = standDown(macro.reason);
        else if (!market.isOpen) decision = standDown(`Entry window closed: ${market.reason}`);
        else if (market.minutes >= closeMinutes - 40) decision = standDown('Entry window closes 40 minutes before the cash close');
      }
      let plan = buildWallReactionPlan(context, decision, Number(settings.wall_reaction_max_risk_dollars || 500));
      let contract: WallReactionContract | null = null;
      if (['CALL_WALL_FADE', 'PUT_WALL_BOUNCE'].includes(decision.code)) {
        if (!plan) decision = standDown('No valid structural target at 1R or provider breakout buffer is unavailable');
        else {
          const expirations = await this.marketData.getOptionExpirations(symbol);
          const expiration = chooseWallReactionExpiration(expirations, now);
          if (!expiration) decision = standDown('No eligible 0DTE/1DTE option expiration is listed');
          else {
            const side = decision.direction === 'bearish' ? 'put' : 'call';
            contract = selectWallReactionContract(
              await this.marketData.getOptionChainSnapshot(null, symbol, expiration, side), decision.direction, context.spot, plan, now
            );
            if (!contract) decision = standDown('No fresh liquid option contract fits the debit budget');
          }
        }
      }
      if (decision.code === 'STAND_DOWN') { plan = null; contract = null; }
      const stablePlan = plan ? {
        wall: plan.wall, invalidation: plan.invalidation, target1: plan.target1, target2: plan.target2,
        debitBudget: plan.debitBudget,
        contract: contract ? { ticker: contract.ticker, expiration: contract.expiration, strike: contract.strike, right: contract.right, quantity: contract.quantity } : null
      } : {};
      const candidate: WallReactionCandidate = {
        id: newWallReactionCandidateId(), symbol, fingerprint: wallReactionFingerprint(symbol, decision, stablePlan),
        status: contract ? 'CANDIDATE' : decision.code.endsWith('_WATCH') || decision.code === 'WAIT' || decision.code === 'WAIT_FOR_TRAP' ? 'WATCHING' : 'BLOCKED',
        generatedAt: now.toISOString(), context, decision, macro, plan, contract
      };
      this.state.set(symbol, candidate);
      await this.persist(candidate);
    } catch (error: any) {
      await this.storeGated(symbol, error.message || String(error), now);
      throw error;
    }
  }

  private async persist(candidate: WallReactionCandidate): Promise<void> {
    const { rows } = await (this.fastify as any).pg.query(
      `INSERT INTO wall_reaction_candidates (id, symbol, fingerprint, decision_code, status, context, plan, contract, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (symbol, fingerprint) DO UPDATE SET
         decision_code=EXCLUDED.decision_code, status=CASE WHEN wall_reaction_candidates.status IN ('ARMED','ENTERED','EXPIRED','INVALIDATED') THEN wall_reaction_candidates.status ELSE EXCLUDED.status END,
         context=EXCLUDED.context, plan=EXCLUDED.plan, contract=EXCLUDED.contract, generated_at=EXCLUDED.generated_at, updated_at=NOW()
       RETURNING id, status`,
      [candidate.id, candidate.symbol, candidate.fingerprint, candidate.decision.code, candidate.status,
        JSON.stringify({ context: candidate.context, decision: candidate.decision, macro: candidate.macro }),
        JSON.stringify(candidate.plan || {}), JSON.stringify(candidate.contract || {}), candidate.generatedAt]
    );
    candidate.id = String(rows[0]?.id || candidate.id);
    candidate.status = String(rows[0]?.status || candidate.status);
  }
}
