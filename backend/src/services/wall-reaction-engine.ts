import { createHash, randomUUID } from 'crypto';
import { IbkrHistoricalBar } from './ibkr-market-data-service';
import { providerAgeSeconds, WallReactionSymbol, ZeroGexWallSnapshot } from './wall-reaction-providers';

export type WallReactionCode =
  | 'CALL_WALL_FADE' | 'PUT_WALL_BOUNCE'
  | 'CALL_BREAKOUT_WATCH' | 'PUT_BREAKOUT_WATCH'
  | 'EXIT_CALLS' | 'EXIT_PUTS'
  | 'WAIT_FOR_TRAP' | 'WAIT' | 'STAND_DOWN';

export type WallReactionDecision = {
  code: WallReactionCode;
  setup: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  riskMultiplier: 0 | 0.25 | 0.5;
  action: string;
  reasons: string[];
  warnings: string[];
};

export type WallReactionContext = {
  symbol: WallReactionSymbol;
  generatedAt: string;
  spot: number;
  levelsAgeSeconds: number;
  netGex: number;
  gammaFlip: number;
  callWall: number;
  putWall: number;
  maxPain: number | null;
  msi: number;
  gapPct: number | null;
  gapBasis: 'opening_gap' | 'premarket_change' | 'unavailable';
  trap: Record<string, any>;
  rangeBreak: Record<string, any>;
  marketPressure: Record<string, any>;
  tradeBias: Record<string, any>;
  basicSignals: Record<string, any>;
  playbook: Record<string, any>;
  zeroDte: Record<string, any>;
  gammaVwap: Record<string, any>;
  volatility: Record<string, any>;
  warnings: string[];
};

const WALL_DISTANCE_PCT = 0.25;
const STRONG_GAP_PCT = 0.5;

function number(value: unknown): number | null {
  if (typeof value === 'boolean' || value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNumber(value: unknown, name: string): number {
  const parsed = number(value);
  if (parsed === null) throw new Error(`ZeroGEX snapshot is missing numeric ${name}`);
  return parsed;
}

function direction(value: unknown): 'bullish' | 'bearish' | 'neutral' {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'bullish' || normalized === 'bearish' ? normalized : 'neutral';
}

function timestampFor(payload: Record<string, any>): unknown {
  return payload.timestamp ?? payload.as_of ?? payload.updated_at;
}

function freshPayload(
  payload: unknown,
  name: string,
  now: Date,
  maxAgeSeconds: number,
  required: boolean,
  warnings: string[]
): Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    if (required) throw new Error(`Required ZeroGEX ${name} data is unavailable`);
    warnings.push(`${name} data unavailable`);
    return {};
  }
  const object = payload as Record<string, any>;
  const age = providerAgeSeconds(timestampFor(object), now);
  if (age === null || age < -5 || age > maxAgeSeconds) {
    const reason = age === null ? 'has no provider timestamp' : age < -5 ? 'has a future provider timestamp' : `is stale (${age.toFixed(0)}s)`;
    if (required) throw new Error(`Required ZeroGEX ${name} ${reason}`);
    warnings.push(`Ignoring ${name}: ${reason}`);
    return {};
  }
  return object;
}

function hasPayload(payload: Record<string, any>): boolean {
  return Object.keys(payload).length > 0;
}

function freshBasicSignals(payload: unknown, now: Date, warnings: string[]): Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    warnings.push('basic signals data unavailable');
    return {};
  }
  return Object.fromEntries(Object.entries(payload as Record<string, any>).flatMap(([name, value]) => {
    const fresh = freshPayload(value, `basic signal ${name}`, now, 180, false, warnings);
    return hasPayload(fresh) ? [[name, fresh]] : [];
  }));
}

function etParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function computeWallReactionGap(bars: IbkrHistoricalBar[], now: Date): { pct: number | null; basis: WallReactionContext['gapBasis'] } {
  const today = etParts(now).date;
  const normalized = bars.flatMap((bar) => {
    const stamp = new Date(bar.start);
    if (!Number.isFinite(stamp.getTime())) return [];
    const parts = etParts(stamp);
    return [{ ...bar, date: parts.date, minutes: parts.minutes }];
  }).sort((a, b) => a.start.localeCompare(b.start));
  const previousDates = [...new Set(normalized.filter((bar) => bar.date < today && bar.minutes >= 570 && bar.minutes < 960).map((bar) => bar.date))].sort();
  const previousDate = previousDates.at(-1);
  const previousBars = normalized.filter((bar) => bar.date === previousDate && bar.minutes >= 570 && bar.minutes < 960);
  const priorClose = previousBars.at(-1)?.close;
  if (!(priorClose && priorClose > 0)) return { pct: null, basis: 'unavailable' };
  const rth = normalized.filter((bar) => bar.date === today && bar.minutes >= 570 && bar.minutes < 960);
  if (rth.length > 0 && rth[0].minutes <= 575 && rth[0].open > 0) {
    return { pct: (rth[0].open - priorClose) / priorClose * 100, basis: 'opening_gap' };
  }
  if (etParts(now).minutes < 570) {
    const current = normalized.filter((bar) => bar.date === today).at(-1)?.close;
    if (current && current > 0) return { pct: (current - priorClose) / priorClose * 100, basis: 'premarket_change' };
  }
  return { pct: null, basis: 'unavailable' };
}

export function contextFromZeroGex(
  snapshot: ZeroGexWallSnapshot,
  bars: IbkrHistoricalBar[],
  now = new Date()
): WallReactionContext {
  const raw = snapshot.raw;
  const warnings: string[] = [];
  const gex = freshPayload(raw.gex_summary, 'GEX summary', now, 60, true, warnings);
  const composite = freshPayload(raw.composite, 'MSI composite', now, 180, true, warnings);
  const advanced = raw.advanced_signals || {};
  const trap = freshPayload(advanced.trap_detection, 'trap detection', now, 180, true, warnings);
  const rangeBreak = freshPayload(advanced.range_break_imminence, 'range-break', now, 180, true, warnings);
  const marketPressure = freshPayload(advanced.market_pressure, 'market pressure', now, 180, false, warnings);
  const zeroDte = freshPayload(advanced.zero_dte_position_imbalance, '0DTE imbalance', now, 180, false, warnings);
  const gammaVwap = freshPayload(advanced.gamma_vwap_confluence, 'gamma/VWAP', now, 180, false, warnings);
  const tradeBias = freshPayload(raw.trade_bias, 'trade bias', now, 180, false, warnings);
  const playbook = freshPayload(raw.playbook, 'playbook', now, 180, false, warnings);
  const volatility = freshPayload(raw.market_volatility, 'volatility', now, 180, false, warnings);
  const basicSignals = freshBasicSignals(raw.basic_signals, now, warnings);
  const gap = computeWallReactionGap(bars, now);
  if (gap.pct === null) warnings.push('Opening-gap state is unavailable');
  return {
    symbol: snapshot.symbol,
    generatedAt: now.toISOString(),
    spot: requiredNumber(gex.spot_price, 'spot_price'),
    levelsAgeSeconds: providerAgeSeconds(gex.timestamp, now) ?? 0,
    netGex: requiredNumber(gex.net_gex_at_spot ?? gex.net_gex, 'net_gex_at_spot'),
    gammaFlip: requiredNumber(gex.gamma_flip, 'gamma_flip'),
    callWall: requiredNumber(gex.call_wall, 'call_wall'),
    putWall: requiredNumber(gex.put_wall, 'put_wall'),
    maxPain: number(gex.max_pain),
    msi: requiredNumber(composite.score, 'composite score'),
    gapPct: gap.pct,
    gapBasis: gap.basis,
    trap,
    rangeBreak,
    marketPressure,
    tradeBias,
    basicSignals,
    playbook,
    zeroDte,
    gammaVwap,
    volatility,
    warnings
  };
}

export function msiRegime(msi: number): string {
  return msi >= 70 ? 'Trend/Expansion' : msi >= 40 ? 'Controlled Trend' : msi >= 20 ? 'Chop/Range' : 'High-Risk Reversal';
}

function wallDistancePct(spot: number, wall: number): number {
  return spot > 0 && wall > 0 ? Math.abs(spot - wall) / spot * 100 : Number.POSITIVE_INFINITY;
}

function confirmedBreak(context: WallReactionContext, side: 'bullish' | 'bearish'): boolean {
  return number(context.rangeBreak.imminence) !== null
    && Number(context.rangeBreak.imminence) >= 65
    && context.rangeBreak.triggered === true
    && direction(context.rangeBreak.direction ?? context.rangeBreak.bias) === side
    && context.marketPressure.triggered === true
    && direction(context.marketPressure.direction) === side
    && Number(context.marketPressure.loading || 0) >= 50;
}

function decision(context: WallReactionContext, values: Omit<WallReactionDecision, 'warnings'>): WallReactionDecision {
  return { ...values, warnings: [...context.warnings] };
}

function wallReaction(context: WallReactionContext, kind: 'call' | 'put'): WallReactionDecision {
  const call = kind === 'call';
  const setup = call ? 'call_wall_fade' : 'put_wall_bounce';
  const side = call ? 'bearish' : 'bullish';
  const wall = call ? context.callWall : context.putWall;
  const expectedTrap = call ? 'bearish_fade' : 'bullish_fade';
  const breakout = call ? 'breakout_up' : 'breakout_down';
  const migration = call ? 'call_wall_migrated_up' : 'put_wall_migrated_down';
  const distance = wallDistancePct(context.spot, wall);
  if (distance > WALL_DISTANCE_PCT) return decision(context, {
    code: 'WAIT', setup, direction: 'neutral', confidence: 0, riskMultiplier: 0,
    action: `Spot is ${distance.toFixed(2)}% from the wall; wait for a structural test.`,
    reasons: [`Wall proximity requires <= ${WALL_DISTANCE_PCT.toFixed(2)}%`]
  });
  const volatility = number(context.volatility.level);
  if (volatility !== null && volatility >= 8) return decision(context, {
    code: 'STAND_DOWN', setup, direction: side, confidence: 0, riskMultiplier: 0,
    action: 'Extreme volatility blocks a short-duration wall reaction.', reasons: [`Volatility level ${volatility.toFixed(1)}/10`]
  });
  if (context.netGex <= 0 || context.spot <= context.gammaFlip) return decision(context, {
    code: 'STAND_DOWN', setup, direction: side, confidence: 0, riskMultiplier: 0,
    action: 'Do not fade the wall in short-gamma or below-flip conditions.',
    reasons: ['Wall reactions require positive GEX at spot and spot above the gamma flip']
  });
  if (context.trap[migration] === true) return decision(context, {
    code: 'STAND_DOWN', setup, direction: side, confidence: 0, riskMultiplier: 0,
    action: 'The wall migrated with price, invalidating the reaction setup.', reasons: ['Wall migration invalidated the fade']
  });
  if (!(context.trap.triggered === true && context.trap.signal === expectedTrap && context.trap[breakout] === true)) {
    return decision(context, {
      code: 'WAIT_FOR_TRAP', setup, direction: side, confidence: 0, riskMultiplier: 0,
      action: 'Wait for the provider failed-breakout trap signal; a wick alone is not an entry.',
      reasons: [`Required trap signal: ${expectedTrap}`]
    });
  }
  const opposite = side === 'bullish' ? 'bearish' : 'bullish';
  if (context.marketPressure.triggered === true && direction(context.marketPressure.direction) === opposite) {
    return decision(context, { code: 'STAND_DOWN', setup, direction: side, confidence: 0, riskMultiplier: 0,
      action: 'Loaded market pressure opposes the wall reaction.', reasons: [`Market pressure is triggered ${opposite}`] });
  }
  const dealerScore = number(context.basicSignals.dealer_delta_pressure?.score) || 0;
  if ((side === 'bearish' && dealerScore > 60) || (side === 'bullish' && dealerScore < -60)) {
    return decision(context, { code: 'STAND_DOWN', setup, direction: side, confidence: 0, riskMultiplier: 0,
      action: 'Dealer delta pressure indicates chase risk against the reaction.', reasons: [`Dealer delta pressure ${dealerScore.toFixed(1)}`] });
  }
  if (context.playbook.state === 'candidate' && direction(context.playbook.direction) === opposite && Number(context.playbook.confidence || 0) >= 0.5) {
    return decision(context, { code: 'STAND_DOWN', setup, direction: side, confidence: 0, riskMultiplier: 0,
      action: 'The ZeroGEX playbook has a confident opposing setup.', reasons: ['Opposing playbook candidate'] });
  }
  const reasons = ['Positive GEX supports wall absorption', 'ZeroGEX trap detector confirmed the failed breakout'];
  let confidence = 5;
  if (context.trap.context_values?.gamma_strengthening === true) { confidence += 1; reasons.push('Dealer gamma is strengthening'); }
  const imminence = Number(context.rangeBreak.imminence || 0);
  if (imminence < 65) { confidence += 1; reasons.push('Range-break risk is below the break-watch threshold'); }
  if (hasPayload(context.marketPressure) && direction(context.marketPressure.direction) !== opposite) confidence += 1;
  if (hasPayload(context.tradeBias) && direction(context.tradeBias.direction) !== opposite) confidence += 1;
  if (direction(context.playbook.direction) === side) confidence += 1;
  let risk: 0 | 0.25 | 0.5 = 0.5;
  const riskWarnings: string[] = [];
  const adverseGap = context.gapPct !== null && (call ? context.gapPct > STRONG_GAP_PCT : context.gapPct < -STRONG_GAP_PCT);
  if (context.gapPct === null || adverseGap || imminence >= 40 || context.msi < 20 || context.msi >= 70 || (volatility !== null && volatility >= 6)) risk = 0.25;
  if (adverseGap) riskWarnings.push(`Adverse ${context.gapBasis.replaceAll('_', ' ')} ${context.gapPct!.toFixed(2)}%`);
  if (imminence >= 40) riskWarnings.push(`Range-break imminence is elevated at ${imminence.toFixed(1)}`);
  if (context.msi < 20 || context.msi >= 70) riskWarnings.push(`MSI ${context.msi.toFixed(1)} is ${msiRegime(context.msi)}`);
  if (volatility !== null && volatility >= 6) riskWarnings.push(`Volatility level is elevated at ${volatility.toFixed(1)}/10`);
  if (hasPayload(context.tradeBias) && direction(context.tradeBias.direction) === opposite && Number(context.tradeBias.confidence || 0) >= 0.6) {
    riskWarnings.push('Intraday trade bias confidently opposes the setup');
  }
  if (context.playbook.state === 'stand_down') riskWarnings.push('ZeroGEX playbook currently says stand down');
  if (context.zeroDte.triggered === true && direction(context.zeroDte.direction) === opposite) {
    risk = 0.25;
    riskWarnings.push('Triggered 0DTE imbalance opposes the wall reaction');
  }
  if (context.gammaVwap.triggered === true && direction(context.gammaVwap.direction) === opposite) {
    risk = 0.25;
    riskWarnings.push('Gamma/VWAP confluence opposes the wall reaction');
  }
  if (imminence >= 80) risk = 0;
  if (imminence >= 80) {
    const result = decision(context, { code: 'STAND_DOWN', setup, direction: side, confidence: Math.min(confidence, 10), riskMultiplier: 0,
      action: 'Breakout Mode is active; do not initiate a wall reaction.', reasons });
    result.warnings.push(...riskWarnings);
    return result;
  }
  const result = decision(context, {
    code: call ? 'CALL_WALL_FADE' : 'PUT_WALL_BOUNCE', setup, direction: side,
    confidence: Math.min(confidence, 10), riskMultiplier: risk,
    action: 'Administrator review required after price returns through and holds the frozen wall.', reasons
  });
  result.warnings.push(...riskWarnings);
  return result;
}

export function evaluateWallReaction(context: WallReactionContext): WallReactionDecision {
  if (context.levelsAgeSeconds < -5 || context.levelsAgeSeconds > 60) return decision(context, {
    code: 'STAND_DOWN', setup: 'stale_data', direction: 'neutral', confidence: 0, riskMultiplier: 0,
    action: 'Levels are stale or future-dated.', reasons: [`Level age ${context.levelsAgeSeconds.toFixed(1)}s`]
  });
  if (context.trap.call_wall_migrated_up === true) return decision(context, {
    code: confirmedBreak(context, 'bullish') ? 'CALL_BREAKOUT_WATCH' : 'EXIT_PUTS', setup: 'call_wall_migration',
    direction: confirmedBreak(context, 'bullish') ? 'bullish' : 'neutral', confidence: confirmedBreak(context, 'bullish') ? 7 : 0,
    riskMultiplier: 0, action: 'Exit puts; never auto-flip. Wait for acceptance and retest.', reasons: ['Call wall migrated upward']
  });
  if (context.trap.put_wall_migrated_down === true) return decision(context, {
    code: confirmedBreak(context, 'bearish') ? 'PUT_BREAKOUT_WATCH' : 'EXIT_CALLS', setup: 'put_wall_migration',
    direction: confirmedBreak(context, 'bearish') ? 'bearish' : 'neutral', confidence: confirmedBreak(context, 'bearish') ? 7 : 0,
    riskMultiplier: 0, action: 'Exit calls; never auto-flip. Wait for acceptance and retest.', reasons: ['Put wall migrated downward']
  });
  const callDistance = wallDistancePct(context.spot, context.callWall);
  const putDistance = wallDistancePct(context.spot, context.putWall);
  if (callDistance <= WALL_DISTANCE_PCT && callDistance <= putDistance) return wallReaction(context, 'call');
  if (putDistance <= WALL_DISTANCE_PCT) return wallReaction(context, 'put');
  if (confirmedBreak(context, 'bullish')) return decision(context, { code: 'CALL_BREAKOUT_WATCH', setup: 'confirmed_break_watch', direction: 'bullish', confidence: 7, riskMultiplier: 0,
    action: 'Wait for a broken level to hold on retest; this is not an entry.', reasons: ['Range-break and market-pressure signals agree bullish'] });
  if (confirmedBreak(context, 'bearish')) return decision(context, { code: 'PUT_BREAKOUT_WATCH', setup: 'confirmed_break_watch', direction: 'bearish', confidence: 7, riskMultiplier: 0,
    action: 'Wait for a broken level to hold on retest; this is not an entry.', reasons: ['Range-break and market-pressure signals agree bearish'] });
  return decision(context, { code: 'WAIT', setup: 'no_structural_entry', direction: 'neutral', confidence: 0, riskMultiplier: 0,
    action: 'No confirmed wall reaction or two-signal breakout setup is present.', reasons: [`MSI ${context.msi.toFixed(1)} is ${msiRegime(context.msi)} and is not directional`] });
}

export function wallReactionFingerprint(symbol: WallReactionSymbol, decisionValue: WallReactionDecision, plan: Record<string, any>): string {
  return createHash('sha256').update(JSON.stringify({ symbol, code: decisionValue.code, direction: decisionValue.direction, plan })).digest('hex');
}

export function newWallReactionCandidateId(): string {
  return randomUUID();
}
