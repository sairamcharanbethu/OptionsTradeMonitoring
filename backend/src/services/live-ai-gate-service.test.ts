import { LiveAiGateService } from './live-ai-gate-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function createFastify(callsToday = 0) {
  const events: any[] = [];
  return {
    events,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: {
      query: async (sql: string, params: any[]) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: callsToday }] };
        if (sql.includes('INSERT INTO trade_events')) events.push(params);
        return { rows: [] };
      }
    }
  } as any;
}

const signal = {
  strategy: 'CONTINUATION', favoring: 'calls', confidence_score: 82, setup_id: 'setup-1',
  call_setup: { trigger: 550, invalidation: 548, targets: [552, 554], plan_quality: { reward_risk: 2 }, option: { strike: 551, expiry: '20260916', mid: 1.2, spread_pct: 3, delta: 0.45, planned_contracts: 2, estimated_stop_risk: { per_contract_dollars: 40 } } },
  gex: { regime: 'Negative', gamma_regime: 'Trend' }, warnings: [], session_policy: { event_day: null }
};

async function runTests() {
  console.log('Running LiveAiGateService tests...');

  assert(LiveAiGateService.mode({}) === 'gate', 'Default mode is gate');
  assert(LiveAiGateService.mode({ autonomous_live_ai_mode: 'advisory' }) === 'advisory', 'Advisory mode parses');
  assert(LiveAiGateService.mode({ autonomous_live_ai_mode: 'OFF' }) === 'off', 'Off mode parses case-insensitively');
  assert(LiveAiGateService.mode({ autonomous_live_ai_mode: 'bogus' }) === 'gate', 'Unknown mode falls back to gate');
  assert(LiveAiGateService.fallback({}) === 'trade_cautious' && LiveAiGateService.fallback({ autonomous_live_ai_fallback: 'skip' }) === 'skip', 'Fallback policy parses');
  assert(LiveAiGateService.dailyBudget({}) === 30 && LiveAiGateService.dailyBudget({ live_ai_daily_call_budget: '5' }) === 5, 'Daily budget parses with default');

  const prompt = LiveAiGateService.buildPrompt(signal, { daily_realized_pnl: -40 });
  assert(prompt.includes('"strategy":"CONTINUATION"') && prompt.includes('"stop_risk_per_contract":40') && prompt.includes('daily_realized_pnl'), 'Prompt carries frozen plan, option risk and risk context');
  assert(prompt.includes('only TRADE or SKIP'), 'Prompt states the model cannot change the plan');

  // Off: no call, never blocks.
  const off = new LiveAiGateService(createFastify(), async () => { throw new Error('must not be called'); });
  const offVerdict = await off.decide({ userId: 7, signalId: 1, signal, settings: { autonomous_live_ai_mode: 'off' } });
  assert(offVerdict.source === 'OFF' && offVerdict.blocks === false, 'Off mode never calls the model');

  // Gate + SKIP blocks and is recorded.
  const skipFastify = createFastify();
  const skipGate = new LiveAiGateService(skipFastify, async () => ({ decision: 'SKIP', risk_tier: 'CAUTIOUS', exit_profile: 'BALANCED_T2', rationale: 'GEX conflicts with direction', risk_flags: ['gex'] }));
  const skip = await skipGate.decide({ userId: 7, signalId: 2, signal, settings: {} });
  assert(skip.decision === 'SKIP' && skip.blocks === true && skip.source === 'AI', 'Gate mode SKIP blocks the entry');
  assert(skipFastify.events.length === 1 && skipFastify.events[0][3] === 'AI_LIVE_GATE' && skipFastify.events[0][1] === 2, 'Verdict is recorded against the signal');

  // Advisory + SKIP never blocks.
  const advisory = new LiveAiGateService(createFastify(), async () => ({ decision: 'SKIP', risk_tier: 'CAUTIOUS', exit_profile: 'BALANCED_T2', rationale: 'x' }));
  const adv = await advisory.decide({ userId: 7, signalId: 3, signal, settings: { autonomous_live_ai_mode: 'advisory' } });
  assert(adv.decision === 'SKIP' && adv.blocks === false, 'Advisory mode records but does not block');

  // Gate + TRADE STANDARD passes through with tier.
  const trade = new LiveAiGateService(createFastify(), async () => ({ decision: 'TRADE', risk_tier: 'STANDARD', exit_profile: 'BALANCED_T2', rationale: 'clean' }));
  const tv = await trade.decide({ userId: 7, signalId: 4, signal, settings: {} });
  assert(tv.decision === 'TRADE' && tv.riskTier === 'STANDARD' && tv.blocks === false, 'TRADE verdict passes with its tier');

  // Timeout/error: default fallback trades cautiously; skip fallback blocks.
  const failing = new LiveAiGateService(createFastify(), async () => { throw new Error('timeout'); });
  const fb = await failing.decide({ userId: 7, signalId: 5, signal, settings: {} });
  assert(fb.source === 'FALLBACK' && fb.decision === 'TRADE' && fb.riskTier === 'CAUTIOUS' && fb.blocks === false, 'Default fallback is a one-contract TRADE');
  const failingSkip = new LiveAiGateService(createFastify(), async () => { throw new Error('timeout'); });
  const fbs = await failingSkip.decide({ userId: 7, signalId: 6, signal, settings: { autonomous_live_ai_fallback: 'skip' } });
  assert(fbs.decision === 'SKIP' && fbs.blocks === true, 'Skip fallback blocks when the model is unavailable');

  // Malformed reply is treated as unavailable.
  const malformed = new LiveAiGateService(createFastify(), async () => ({ decision: 'MAYBE' }));
  const mv = await malformed.decide({ userId: 7, signalId: 7, signal, settings: {} });
  assert(mv.source === 'FALLBACK' && mv.riskTier === 'CAUTIOUS', 'Malformed JSON falls back');

  // Budget exhausted: no call, budget fallback.
  const budget = new LiveAiGateService(createFastify(30), async () => { throw new Error('must not be called'); });
  const bv = await budget.decide({ userId: 7, signalId: 8, signal, settings: {} });
  assert(bv.source === 'BUDGET' && bv.aiRequested === false && bv.decision === 'TRADE', 'Budget exhaustion skips the call and applies the fallback');

  console.log('All LiveAiGateService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
