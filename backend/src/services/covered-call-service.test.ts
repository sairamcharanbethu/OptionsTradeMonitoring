import { rankCoveredCallCandidates, scoreCoveredCallCandidate } from './covered-call-service';
import { ThetaDataOptionChainQuote } from './thetadata-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const now = new Date('2026-06-23T12:00:00Z');

function callQuote(overrides: Partial<ThetaDataOptionChainQuote>): ThetaDataOptionChainQuote {
  return {
    source: 'thetadata_chain',
    ticker: 'AAPL260717C00215000',
    symbol: 'AAPL',
    expiration: '2026-07-17',
    right: 'call',
    strike: 215,
    bid: 2.1,
    ask: 2.24,
    last: 2.16,
    mark: 2.17,
    spread: 0.14,
    spreadPct: 6.45,
    volume: 1200,
    openInterest: 4400,
    delta: 0.28,
    gamma: 0.02,
    theta: -0.04,
    vega: 0.11,
    impliedVolatility: 0.31,
    raw: {},
    ...overrides
  };
}

function testConservativeCoveredCallPasses() {
  const candidate = scoreCoveredCallCandidate(callQuote({}), 200, now);

  assert(candidate.eligible === true, 'Balanced OTM liquid call should be eligible');
  assert(candidate.dte === 24, `Expected 24 DTE, got ${candidate.dte}`);
  assert(candidate.otmPct === 7.5, `Expected 7.5% OTM cushion, got ${candidate.otmPct}`);
  assert(candidate.premiumPerContract === 217, `Expected $217 premium, got ${candidate.premiumPerContract}`);
  assert(candidate.reasons.includes('delta in conservative income band'), 'Candidate should explain delta fit');
}

function testHighPremiumAssignmentRiskLosesToConservativeCandidate() {
  const ranked = rankCoveredCallCandidates([
    callQuote({ ticker: 'AAPL260717C00200000', strike: 200, mark: 8.5, bid: 8.3, ask: 8.7, delta: 0.64, spreadPct: 4.7 }),
    callQuote({ ticker: 'AAPL260717C00215000', strike: 215, mark: 2.17, bid: 2.1, ask: 2.24, delta: 0.28, spreadPct: 6.45 })
  ], 200, now);

  assert(ranked[0].ticker === 'AAPL260717C00215000', `Expected conservative OTM candidate first, got ${ranked[0].ticker}`);
  assert(ranked[0].eligible === true, 'Top conservative candidate should be eligible');
  assert(ranked[1].eligible === false, 'High-delta at-the-money candidate should be ineligible');
  assert(ranked[1].reasons.some((reason) => reason.includes('assignment risk') || reason.includes('too close')), 'Rejected candidate should explain assignment risk');
}

function testWideSpreadAndThinOiRejectsCandidate() {
  const candidate = scoreCoveredCallCandidate(callQuote({
    ticker: 'AAPL260717C00230000',
    strike: 230,
    mark: 0.75,
    bid: 0.6,
    ask: 0.9,
    spreadPct: 40,
    volume: 15,
    openInterest: 42,
    delta: 0.12
  }), 200, now);

  assert(candidate.eligible === false, 'Wide spread and thin liquidity should reject candidate');
  assert(candidate.reasons.some((reason) => reason.includes('wide spread')), 'Candidate should explain wide spread');
  assert(candidate.reasons.some((reason) => reason.includes('OI below')), 'Candidate should explain thin open interest');
}

function runTests() {
  console.log('Running CoveredCallService scorer tests...');
  testConservativeCoveredCallPasses();
  testHighPremiumAssignmentRiskLosesToConservativeCandidate();
  testWideSpreadAndThinOiRejectsCandidate();
  console.log('All CoveredCallService scorer tests passed!');
}

runTests();
