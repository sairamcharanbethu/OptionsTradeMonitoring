
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

  console.log('All tests passed!');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
