import assert from 'node:assert/strict';
import { PaperTradingService } from './paper-trading-service';

function run() {
  assert.deepEqual(
    PaperTradingService.quantityForTier(100_000, 1.53, 'CAUTIOUS'),
    { quantity: 1, maxAffordable: 653 }
  );
  assert.deepEqual(
    PaperTradingService.quantityForTier(100_000, 1.53, 'STANDARD'),
    { quantity: 2, maxAffordable: 653 }
  );
  assert.deepEqual(
    PaperTradingService.quantityForTier(100_000, 1.53, 'FULL'),
    { quantity: 3, maxAffordable: 653 }
  );
  assert.equal(PaperTradingService.quantityForTier(100, 1.53, 'FULL').quantity, 0);

  assert.deepEqual(PaperTradingService.normalizeTokenUsage({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }), {
    promptTokens: 80, completionTokens: 20, totalTokens: 100
  });
  assert.deepEqual(PaperTradingService.aiReviewReasons({ confidence_score: 92 }, { spread_pct: 4 }, 11 * 60), []);
  assert.deepEqual(
    PaperTradingService.aiReviewReasons(
      { confidence_score: 74, favoring: 'calls', market_context: { rvol_1m: 1.1 }, zerogex_decision: { gates: { calls: { warnings: ['flow is split'] } } } },
      { spread_pct: 9 },
      15 * 60
    ),
    ['borderline confidence 74', 'wider spread 9.0%', 'low relative volume 1.10', 'ZeroGEX risk warnings', 'late-session entry']
  );

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
