import assert from 'node:assert/strict';
import { contextFromZeroGex, evaluateWallReaction, msiRegime, WallReactionContext } from './wall-reaction-engine';

function base(overrides: Partial<WallReactionContext> = {}): WallReactionContext {
  return {
    symbol: 'SPY', generatedAt: '2026-08-03T13:37:00Z', spot: 751.9, levelsAgeSeconds: 8,
    netGex: 9.33e9, gammaFlip: 748, callWall: 752, putWall: 745, maxPain: 750, msi: 30,
    gapPct: 0.3, gapBasis: 'opening_gap',
    trap: { triggered: true, signal: 'bearish_fade', breakout_up: true, breakout_down: false, call_wall_migrated_up: false, put_wall_migrated_down: false, context_values: { gamma_strengthening: true } },
    rangeBreak: { triggered: false, imminence: 30, direction: 'neutral' },
    marketPressure: { triggered: false, loading: 20, direction: 'neutral' },
    tradeBias: { direction: 'bearish', confidence: 0.65 },
    basicSignals: { dealer_delta_pressure: { score: 0 } },
    playbook: { state: 'candidate', direction: 'bearish', confidence: 0.68 }, zeroDte: {}, gammaVwap: {}, volatility: {}, entryDataBlockers: [], warnings: [],
    ...overrides
  };
}

assert.equal(msiRegime(7.7), 'High-Risk Reversal');
assert.equal(evaluateWallReaction(base()).code, 'CALL_WALL_FADE');
assert.equal(evaluateWallReaction(base({ netGex: -1 })).code, 'STAND_DOWN');
assert.equal(evaluateWallReaction(base({ trap: { triggered: false } })).code, 'WAIT_FOR_TRAP');
assert.equal(evaluateWallReaction(base({ levelsAgeSeconds: 61 })).setup, 'stale_data');
assert.equal(evaluateWallReaction(base({ levelsAgeSeconds: -6 })).setup, 'stale_data');
assert.equal(evaluateWallReaction(base({ marketPressure: { triggered: true, loading: 72, direction: 'bullish' } })).code, 'STAND_DOWN');
assert.equal(evaluateWallReaction(base({ trap: { ...base().trap, call_wall_migrated_up: true } })).code, 'EXIT_PUTS');
assert.equal(evaluateWallReaction(base({ trap: { ...base().trap, call_wall_migrated_up: true }, rangeBreak: { triggered: true, imminence: 70, direction: 'bullish' }, marketPressure: { triggered: true, loading: 60, direction: 'bullish' } })).code, 'CALL_BREAKOUT_WATCH');
const put = base({ symbol: 'QQQ', spot: 598.1, gammaFlip: 590, callWall: 605, putWall: 598, maxPain: 601,
  trap: { triggered: true, signal: 'bullish_fade', breakout_down: true }, tradeBias: { direction: 'bullish' }, playbook: { state: 'candidate', direction: 'bullish', confidence: 0.6 } });
assert.equal(evaluateWallReaction(put).code, 'PUT_WALL_BOUNCE');
assert.equal(evaluateWallReaction(base({ callWall: 760, putWall: 740, rangeBreak: { triggered: true, imminence: 70, direction: 'bearish' }, marketPressure: { triggered: true, loading: 60, direction: 'bearish' } })).code, 'PUT_BREAKOUT_WATCH');
assert.equal(evaluateWallReaction(base({ zeroDte: { triggered: true, direction: 'bullish' } })).riskMultiplier, 0.25);

const now = new Date('2026-08-03T13:37:00Z');
const timestamp = now.toISOString();
const context = contextFromZeroGex({
  symbol: 'SPY', fetchedAt: timestamp, raw: {
    gex_summary: { timestamp, spot_price: 751.9, net_gex_at_spot: 9.33e9, gamma_flip: 748, call_wall: 752, put_wall: 745, max_pain: 750 },
    composite: { timestamp, score: 30 },
    advanced_signals: {
      trap_detection: { timestamp, triggered: true, signal: 'bearish_fade', breakout_up: true },
      range_break_imminence: { timestamp, triggered: false, imminence: 30 },
      market_pressure: { timestamp: '2026-08-03T13:30:00Z', triggered: false, direction: 'neutral' }
    },
    trade_bias: { timestamp, direction: 'bearish' },
    playbook: { timestamp, state: 'candidate', direction: 'bearish', confidence: 0.6 },
    basic_signals: { dealer_delta_pressure: { timestamp, score: 0 } }
  }
}, [], now);
assert.deepEqual(context.marketPressure, {});
assert.ok(context.warnings.some((warning) => warning.includes('market pressure')));
assert.equal(context.basicSignals.dealer_delta_pressure.score, 0);
const staleButReadableTimestamp = new Date(now.getTime() - 78_000).toISOString();
const staleButReadableContext = contextFromZeroGex({
  symbol: 'SPY', fetchedAt: timestamp, raw: {
    gex_summary: { timestamp: staleButReadableTimestamp, spot_price: 751.9, net_gex_at_spot: 9.33e9, gamma_flip: 748, call_wall: 752, put_wall: 745, max_pain: 750 },
    composite: { timestamp, score: 30 },
    advanced_signals: {
      trap_detection: { timestamp, triggered: true, signal: 'bearish_fade', breakout_up: true },
      range_break_imminence: { timestamp, triggered: false, imminence: 30 }
    }
  }
}, [], now);
assert.equal(staleButReadableContext.levelsAgeSeconds, 78);
assert.equal(evaluateWallReaction(staleButReadableContext).setup, 'stale_data');
const staleRangeTimestamp = new Date(now.getTime() - 198_000).toISOString();
const staleRangeContext = contextFromZeroGex({
  symbol: 'SPY', fetchedAt: timestamp, raw: {
    gex_summary: { timestamp, spot_price: 751.9, net_gex_at_spot: 9.33e9, gamma_flip: 748, call_wall: 752, put_wall: 745, max_pain: 750 },
    composite: { timestamp, score: 30 },
    advanced_signals: {
      trap_detection: { timestamp, triggered: true, signal: 'bearish_fade', breakout_up: true },
      range_break_imminence: { timestamp: staleRangeTimestamp, triggered: false, imminence: 30 }
    }
  }
}, [], now);
assert.deepEqual(staleRangeContext.entryDataBlockers, ['Range-break confirmation is unavailable or stale']);
assert.equal(evaluateWallReaction(staleRangeContext).setup, 'signal_data_unavailable');
assert.ok(staleRangeContext.warnings.some((warning) => warning.includes('range-break') && warning.includes('198s')));
const expiredContextTimestamp = new Date(now.getTime() - 121_000).toISOString();
assert.throws(() => contextFromZeroGex({
  symbol: 'SPY', fetchedAt: timestamp, raw: {
    gex_summary: { timestamp: expiredContextTimestamp, spot_price: 751.9, net_gex_at_spot: 9.33e9, gamma_flip: 748, call_wall: 752, put_wall: 745 },
    composite: { timestamp, score: 30 },
    advanced_signals: { trap_detection: { timestamp }, range_break_imminence: { timestamp } }
  }
}, [], now), /stale \(121s\)/);
assert.throws(() => contextFromZeroGex({
  symbol: 'SPY', fetchedAt: timestamp, raw: {
    gex_summary: { timestamp: '2026-08-03T13:37:10Z', spot_price: 751.9, net_gex_at_spot: 1, gamma_flip: 748, call_wall: 752, put_wall: 745 },
    composite: { timestamp, score: 30 },
    advanced_signals: { trap_detection: { timestamp }, range_break_imminence: { timestamp } }
  }
}, [], now), /future provider timestamp/);
console.log('All WallReactionEngine tests passed!');
