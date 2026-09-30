
import { StopLossEngine } from './stop-loss-engine';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('Running StopLossEngine tests...');

  // Test 1: No trigger
  const res1 = StopLossEngine.evaluate(10, {
    entry_price: 10,
    stop_loss_trigger: 8,
    trailing_high_price: 10
  });
  assert(res1.triggered === false, 'Should not trigger at 10');

  // Test 2: Stop loss trigger
  const res2 = StopLossEngine.evaluate(7, {
    entry_price: 10,
    stop_loss_trigger: 8,
    trailing_high_price: 10
  });
  assert(res2.triggered === true, 'Should trigger at 7');
  assert(res2.triggerType === 'STOP_LOSS', 'Trigger type should be STOP_LOSS');

  // Test 3: Take profit trigger
  const res3 = StopLossEngine.evaluate(15, {
    entry_price: 10,
    stop_loss_trigger: 8,
    take_profit_trigger: 14,
    trailing_high_price: 10
  });
  assert(res3.triggered === true, 'Should trigger at 15 (TP)');
  assert(res3.triggerType === 'TAKE_PROFIT', 'Trigger type should be TAKE_PROFIT');

  // Test 4: Trailing stop loss update
  const res4 = StopLossEngine.evaluate(12, {
    entry_price: 10,
    stop_loss_trigger: 8,
    trailing_high_price: 10,
    trailing_stop_loss_pct: 20 // Stop at 12 * 0.8 = 9.6
  });
  // console.log('res4:', res4);
  assert(res4.triggered === false, 'Should not trigger at 12');
  assert(res4.newHigh === 12, 'New high should be 12');
  assert(Math.abs((res4.newStopLoss || 0) - 9.6) < 0.0001, `New stop loss should be 9.6, got ${res4.newStopLoss}`);

  // Test 5: Trailing stop loss trigger
  const res5 = StopLossEngine.evaluate(9.5, {
    entry_price: 10,
    stop_loss_trigger: 9.6, // From previous step
    trailing_high_price: 12
  });
  assert(res5.triggered === true, 'Should trigger at 9.5');
  assert(res5.triggerType === 'STOP_LOSS', 'Trigger type should be STOP_LOSS');

  // Test 6: arm the trail from the existing high on activation
  const res6 = StopLossEngine.evaluate(12, {
    entry_price: 10,
    stop_loss_trigger: 8,
    trailing_high_price: 12,
    trailing_stop_loss_pct: 15
  });
  assert(res6.newStopLoss === 10.2, `Existing $12 high with a 15% trail should arm at $10.20, got ${res6.newStopLoss}`);

  // Test 7: strategy trails protect at least breakeven after TP1
  const res7 = StopLossEngine.evaluate(11, {
    entry_price: 10,
    stop_loss_trigger: 8,
    trailing_high_price: 11,
    trailing_stop_loss_pct: 15,
    trailing_floor_price: 10
  });
  assert(res7.newStopLoss === 10, `Strategy trail should respect its $10 breakeven floor, got ${res7.newStopLoss}`);

  // Test 8: half-cent floating point values must not loosen a protective stop
  const res8 = StopLossEngine.evaluate(0.5, {
    entry_price: 0.5,
    stop_loss_trigger: 0,
    trailing_high_price: 0.5,
    trailing_stop_loss_pct: 15
  });
  assert(res8.newStopLoss === 0.43, `A 15% trail from $0.50 should protect at $0.43, got ${res8.newStopLoss}`);

  // Profit-lock ladder: breakeven at +20% peak, +25% locked at +50% peak.
  assert(StopLossEngine.profitLockFloor(3, 3.3) === 0, 'below +20% peak: no lock');
  assert(StopLossEngine.profitLockFloor(3, 3.59) === 0, '+19.7% peak: no lock');
  assert(StopLossEngine.profitLockFloor(3, 3.6) === 3, '+20% peak locks breakeven');
  assert(StopLossEngine.profitLockFloor(3, 4.2) === 3, '+40% peak still breakeven lock');
  assert(StopLossEngine.profitLockFloor(3, 4.5) === 3.75, '+50% peak locks +25%');
  assert(StopLossEngine.profitLockFloor(3, 9) === 3.75, '+200% peak keeps the +25% lock');
  assert(StopLossEngine.profitLockFloor(0, 5) === 0, 'zero entry: no lock');
  assert(StopLossEngine.profitLockFloor(3, 0) === 0, 'zero peak: no lock');
  // The floor clamps the trailing stop: peak +30% with a 15% trail would stop
  // at 1.105x entry, but the breakeven lock holds it at entry.
  const res9 = StopLossEngine.evaluate(2.9, {
    entry_price: 3,
    stop_loss_trigger: 0,
    trailing_high_price: 3.9,
    trailing_stop_loss_pct: 15,
    trailing_floor_price: StopLossEngine.profitLockFloor(3, 3.9)
  });
  assert(res9.triggered === true, 'faded to below entry with lock armed: should trigger');
  assert(res9.triggerType === 'STOP_LOSS', 'lock exit is a STOP_LOSS');

  console.log('All tests passed!');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
