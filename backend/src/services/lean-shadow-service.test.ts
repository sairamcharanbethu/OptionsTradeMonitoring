import { compareLeanShadowPlan, leanShadowStableJson } from './lean-shadow-service';

function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function signal(overrides: Record<string, any> = {}) {
  return {
    engine_version: 'signal-only-v2', execution_enabled: false, strategy_lane: 'mtf', state: 'ACTIVE', favoring: 'calls',
    lifecycle: { entry_allowed: true },
    call_setup: { trigger: 777, invalidation: 776.8, targets: [777.1, 777.2], option: { expiry: '20260814', strike: 777 } },
    ...overrides
  };
}

assert(leanShadowStableJson({ b: 2, a: [true, { z: 1, a: 2 }] }) === '{"a":[true,{"a":2,"z":1}],"b":2}', 'Canonical signing JSON must sort keys recursively');
const same = compareLeanShadowPlan(signal(), signal());
assert(same.qualified && same.matches, 'Equivalent trade-ready plans must match');
const different = compareLeanShadowPlan(signal(), signal({ favoring: 'puts', call_setup: { trigger: 776.8, invalidation: 777.2, targets: [776.4], option: { expiry: '20260815', strike: 775 } } }));
assert(different.qualified && !different.matches && different.reasons.includes('direction differs'), 'Material drift must be identified');
const notReady = compareLeanShadowPlan(signal({ state: 'WATCH', lifecycle: { entry_allowed: false } }), signal());
assert(!notReady.qualified, 'Comparison must not count non-trade-ready heartbeats as parity');
console.log('LEAN shadow service tests passed!');
