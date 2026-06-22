import '@fastify/postgres';
import '@fastify/websocket';
import { SignalScannerService } from './signal-scanner-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
}

function createScanner() {
  return new SignalScannerService(createFastifyMock()) as any;
}

function macroSnapshot(overrides: Record<string, any>) {
  return {
    symbol: overrides.symbol || 'TEST',
    label: overrides.label || 'Test',
    value: overrides.value ?? null,
    previousClose: overrides.previousClose ?? null,
    changePct: overrides.changePct ?? null,
    changeBps: overrides.changeBps ?? null,
    source: 'test',
    error: null,
    ...overrides
  };
}

async function testThetaDataMissingVolumeDoesNotRejectLiquidCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 3.6,
      ask: 3.68,
      mark: 3.64,
      spread: 0.08,
      spreadPct: 2.2,
      volume: null,
      openInterest: 842,
      last: null,
      delta: 0.4674,
      gamma: null,
      theta: -0.543,
      impliedVolatility: 0.132,
      timestamp: '2026-06-18T16:15:00.082Z'
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected !== null, 'Missing ThetaData volume should be treated as unknown, not failed');
  assert(result.selected?.ticker === 'QQQ260622C00741000', `Expected selected contract, got ${result.selected?.ticker}`);
  assert(result.ranked[0].reasons.includes('volume unavailable'), 'Ranked candidate should explain unknown volume');
}

async function testThetaDataKnownLowVolumeStillRejectsCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 3.6,
      ask: 3.68,
      mark: 3.64,
      spread: 0.08,
      spreadPct: 2.2,
      volume: 25,
      openInterest: 842,
      last: null,
      delta: 0.4674,
      gamma: null,
      theta: -0.543,
      impliedVolatility: 0.132,
      timestamp: '2026-06-18T16:15:00.082Z'
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected === null, 'Known low volume should still reject the candidate');
  assert(result.ranked[0].reasons.includes('volume below 200'), 'Ranked candidate should explain low volume');
}

async function testThetaDataPrefersUsefulDeltaOverExactOffset() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
    chain: [
      {
        ticker: 'QQQ260622C00741000',
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 741,
        bid: 1.18,
        ask: 1.22,
        mark: 1.20,
        spread: 0.04,
        spreadPct: 3.3,
        volume: 1400,
        openInterest: 2500,
        last: null,
        delta: 0.12,
        gamma: null,
        theta: -0.28,
        impliedVolatility: 0.18,
        timestamp: '2026-06-18T16:15:00.082Z'
      },
      {
        ticker: 'QQQ260622C00742000',
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 742,
        bid: 1.16,
        ask: 1.20,
        mark: 1.18,
        spread: 0.04,
        spreadPct: 3.4,
        volume: 1300,
        openInterest: 2400,
        last: null,
        delta: 0.45,
        gamma: null,
        theta: -0.31,
        impliedVolatility: 0.18,
        timestamp: '2026-06-18T16:15:00.082Z'
      }
    ],
    candidates: [
      {
        ticker: 'QQQ260622C00741000',
        strike: 741,
        expiry: '2026-06-22'
      },
      {
        ticker: 'QQQ260622C00742000',
        strike: 742,
        expiry: '2026-06-22'
      }
    ],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected?.ticker === 'QQQ260622C00742000', `Expected useful-delta contract, got ${result.selected?.ticker}`);
  assert(result.ranked[0].reasons.includes('delta in quick-profit band'), 'Selected candidate should explain useful delta');
  assert(result.ranked[1].reasons.includes('delta too low 0.12'), 'Rejected candidate should explain weak delta');
}

async function testMacroBlocksCallsWhenVixIsTooHighOrSpiking() {
  const scanner = createScanner();

  const result = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 31.5, previousClose: 26.8, changePct: 17.54 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 43.2, previousClose: 43.1, changePct: 0.23, changeBps: 1 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 104.1, previousClose: 104.0, changePct: 0.1 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 78, previousClose: 77.8, changePct: 0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2340, previousClose: 2335, changePct: 0.21 })
  });

  assert(result.blockers.some((item: string) => item.includes('VIX')), 'High/spiking VIX should block bullish calls');
  assert(result.confidenceAdjustment < 0, 'High/spiking VIX should reduce confidence');
}

async function testMacroBlocksCallsWhenDxyAndTenYearRiseTogether() {
  const scanner = createScanner();

  const result = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60 + 30,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 18.2, previousClose: 18.1, changePct: 0.55 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 43.7, previousClose: 43.1, changePct: 1.39, changeBps: 6 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 104.6, previousClose: 104.1, changePct: 0.48 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 78, previousClose: 77.8, changePct: 0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2340, previousClose: 2335, changePct: 0.21 })
  });

  assert(result.blockers.some((item: string) => item.includes('DXY') && item.includes('10Y')), 'DXY + 10Y risk-off combo should block bullish calls');
  assert(result.thresholdAdjustment > 0, 'Risk-off macro should tighten the entry threshold');
}

async function testMacroRewardsRiskOnCallSetups() {
  const scanner = createScanner();

  const result = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 17.5, previousClose: 18.4, changePct: -4.89 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 42.8, previousClose: 43.2, changePct: -0.93, changeBps: -4 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 103.7, previousClose: 104.1, changePct: -0.38 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 77.6, previousClose: 77.8, changePct: -0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2329, previousClose: 2335, changePct: -0.26 })
  });

  assert(result.blockers.length === 0, 'Supportive risk-on macro should not block calls');
  assert(result.directionBias === 'CALL', `Expected CALL macro bias, got ${result.directionBias}`);
  assert(result.confidenceAdjustment > 0, 'Supportive risk-on macro should improve confidence');
}

async function runTests() {
  console.log('Running SignalScannerService candidate and macro tests...');
  await testThetaDataMissingVolumeDoesNotRejectLiquidCandidate();
  await testThetaDataKnownLowVolumeStillRejectsCandidate();
  await testThetaDataPrefersUsefulDeltaOverExactOffset();
  await testMacroBlocksCallsWhenVixIsTooHighOrSpiking();
  await testMacroBlocksCallsWhenDxyAndTenYearRiseTogether();
  await testMacroRewardsRiskOnCallSetups();
  console.log('All SignalScannerService candidate and macro tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
