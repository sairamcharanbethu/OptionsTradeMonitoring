import { tradingEventBus, SignalDecision } from './trading-events';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testPublishWritesCacheBeforeHandlers() {
  const decision: SignalDecision = {
    signalId: 123,
    symbol: 'QQQ',
    side: 'CALL',
    createdAt: new Date().toISOString(),
    contract: {
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    },
    quote: {
      mark: 1.25,
      bid: 1.22,
      ask: 1.28,
      spreadPct: 4.8,
      volume: 1200,
      openInterest: 2200,
      usingTheoreticalPricing: false
    },
    grade: {
      baseScore: 91,
      macroScore: 72,
      macroConfidenceAdjustment: 3,
      pricingPenalty: 0,
      finalConfidence: 94,
      setupGrade: 'A+ / FULL',
      gradeKey: 'A+',
      executable: true,
      thresholds: {
        standard: 85,
        full: 92,
        fullMacro: 70
      },
      reasons: ['A+ because confidence, macro score, and pricing quality all passed full-size thresholds'],
      warnings: [],
      blockers: [],
      pricingWarnings: [],
      executionRealism: {
        score: 100,
        executable: true,
        threshold: 70,
        reasons: ['Live quote, spread, and liquidity passed execution realism checks']
      }
    }
  };

  let cachedInsideHandler: SignalDecision | null = null;
  const unsubscribe = tradingEventBus.subscribe('SIGNAL_GENERATED', () => {
    cachedInsideHandler = tradingEventBus.getCached<SignalDecision>('test:latestDecision');
  });

  try {
    tradingEventBus.publish({
      type: 'SIGNAL_GENERATED',
      createdAt: decision.createdAt,
      signalId: decision.signalId!,
      symbol: decision.symbol,
      data: decision
    }, {
      'test:latestDecision': decision
    });

    const observed = cachedInsideHandler as SignalDecision | null;
    assert(observed?.signalId === 123, 'Handler should read cache updated by the same publish call');
  } finally {
    unsubscribe();
  }
}

async function runTests() {
  console.log('Running trading event bus tests...');
  await testPublishWritesCacheBeforeHandlers();
  console.log('All trading event bus tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
