import assert from 'node:assert/strict';
import { PaperTradingService } from './paper-trading-service';

function run() {
  assert.deepEqual(
    PaperTradingService.quantityForBudget(100_000, 100_000, 1.53, 'CAUTIOUS'),
    { quantity: 1, maxQuantity: 3, debitBudget: 200 }
  );
  assert.deepEqual(
    PaperTradingService.quantityForBudget(100_000, 100_000, 1.53, 'STANDARD'),
    { quantity: 2, maxQuantity: 3, debitBudget: 350 }
  );
  assert.deepEqual(
    PaperTradingService.quantityForBudget(100_000, 100_000, 1.53, 'FULL'),
    { quantity: 3, maxQuantity: 3, debitBudget: 500 }
  );
  assert.equal(PaperTradingService.quantityForBudget(1_000_000, 1_000_000, 0.50, 'FULL').quantity, 5);
  assert.equal(PaperTradingService.quantityForBudget(100_000, 100, 1.53, 'FULL').quantity, 0);

  assert.deepEqual(PaperTradingService.normalizeAIDecision({
    decision: 'trade', risk_tier: 'standard', exit_profile: 'balanced_t2',
    rationale: 'Aligned and liquid', risk_flags: ['late entry']
  }), {
    decision: 'TRADE', riskTier: 'STANDARD', exitProfile: 'BALANCED_T2', source: 'AI',
    rationale: 'Aligned and liquid', riskFlags: ['late entry']
  });
  assert.equal(PaperTradingService.normalizeAIDecision({ decision: 'TRADE', risk_tier: 'UNBOUNDED', exit_profile: 'BALANCED_T2' }), null);
  assert.equal(PaperTradingService.normalizeAIDecision({ decision: 'TRADE', risk_tier: 'FULL', exit_profile: 'TRAIL_FOREVER' }), null);

  console.log('All PaperTradingService tests passed!');
}

run();
