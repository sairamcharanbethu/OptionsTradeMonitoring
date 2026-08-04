import assert from 'node:assert/strict';
import { isWallReturnConfirmed, wallReactionExitIntent, wallReactionSecondTarget } from './wall-reaction-paper-service';

const candidate: any = { context: { spot: 751.9 }, plan: { wall: 752 }, decision: { direction: 'bearish' } };
assert.equal(isWallReturnConfirmed(candidate), true);
assert.equal(isWallReturnConfirmed({ ...candidate, context: { spot: 752.1 } }), false);
const position = { option_type: 'PUT', suggested_stop_loss: 752.4, suggested_take_profit_1: 750, suggested_take_profit_2: 748, expiration_date: '2026-08-03', analysis_data: {} };
assert.equal(wallReactionExitIntent(position, 752.5, new Date('2026-08-03T14:00:00Z')), 'INVALIDATION');
assert.equal(wallReactionExitIntent(position, 749.9, new Date('2026-08-03T14:00:00Z')), 'TARGET_1');
assert.equal(wallReactionExitIntent({ ...position, analysis_data: { t1Reached: true } }, 747.9, new Date('2026-08-03T14:00:00Z')), 'TARGET_2');
assert.equal(wallReactionExitIntent(position, 751, new Date('2026-08-03T19:51:00Z')), 'END_OF_DAY');
assert.equal(wallReactionSecondTarget({ target2: 748 }, 1), null);
assert.equal(wallReactionSecondTarget({ target2: 748 }, 2), 748);
assert.equal(wallReactionSecondTarget({ target2: null }, 2), null);
console.log('All WallReactionPaperService tests passed!');
