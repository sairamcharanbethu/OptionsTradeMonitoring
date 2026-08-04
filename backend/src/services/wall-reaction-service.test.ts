import assert from 'node:assert/strict';
import { buildWallReactionPlan, chooseWallReactionExpiration, isFreshWallReactionQuote, selectWallReactionContract } from './wall-reaction-service';
import { WallReactionContext, WallReactionDecision } from './wall-reaction-engine';
import { IbkrOptionChainQuote } from './ibkr-market-data-service';

const context = {
  symbol: 'SPY', generatedAt: '2026-08-03T14:00:00Z', spot: 751.9, levelsAgeSeconds: 2,
  netGex: 1, gammaFlip: 748, callWall: 752, putWall: 745, maxPain: 750, msi: 30,
  gapPct: 0, gapBasis: 'opening_gap', trap: { breakout_buffer_pct: 0.05 }, rangeBreak: {}, marketPressure: {}, tradeBias: {},
  basicSignals: {}, playbook: {}, zeroDte: {}, gammaVwap: {}, volatility: {}, warnings: []
} satisfies WallReactionContext;
const decision = { code: 'CALL_WALL_FADE', setup: 'call_wall_fade', direction: 'bearish', confidence: 8, riskMultiplier: 0.5, action: '', reasons: [], warnings: [] } satisfies WallReactionDecision;
const plan = buildWallReactionPlan(context, decision, 500);
assert.ok(plan);
assert.equal(plan.target1, 750);
assert.equal(plan.target2, 748);
assert.equal(plan.debitBudget, 250);
assert.equal(buildWallReactionPlan({ ...context, trap: {} }, decision, 500), null);
assert.equal(chooseWallReactionExpiration(['2026-08-03', '2026-08-04'], new Date('2026-08-03T16:59:00Z')), '2026-08-03');
assert.equal(chooseWallReactionExpiration(['2026-08-03', '2026-08-04'], new Date('2026-08-03T17:00:00Z')), '2026-08-04');
assert.equal(isFreshWallReactionQuote('2026-08-03T14:00:00Z', new Date('2026-08-03T14:00:15Z')), true);
assert.equal(isFreshWallReactionQuote('2026-08-03T14:00:21Z', new Date('2026-08-03T14:00:15Z')), false);
assert.equal(isFreshWallReactionQuote(null, new Date('2026-08-03T14:00:15Z')), false);

const quote = {
  source: 'ibkr_chain', ticker: 'SPY260803P00750000', symbol: 'SPY', expiration: '2026-08-03', right: 'put', strike: 750,
  bid: 1.9, ask: 2, last: 1.95, mark: 1.95, spread: 0.1, spreadPct: 5, volume: 10, openInterest: 100,
  delta: -0.4, gamma: 0.1, theta: -0.1, vega: 0.1, impliedVolatility: 0.2, timestamp: '2026-08-03T14:00:00Z', raw: {}
} satisfies IbkrOptionChainQuote;
assert.equal(selectWallReactionContract([quote], 'bearish', 751.9, plan!, new Date('2026-08-03T14:00:10Z'))?.quantity, 1);
assert.equal(selectWallReactionContract([{ ...quote, timestamp: '2026-08-03T13:59:30Z' }], 'bearish', 751.9, plan!, new Date('2026-08-03T14:00:10Z')), null);
assert.equal(selectWallReactionContract([{ ...quote, spreadPct: 5.01 }], 'bearish', 751.9, plan!, new Date('2026-08-03T14:00:10Z')), null);
console.log('All WallReactionService tests passed!');
