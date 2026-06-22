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

async function runTests() {
  console.log('Running SignalScannerService ThetaData candidate tests...');
  await testThetaDataMissingVolumeDoesNotRejectLiquidCandidate();
  await testThetaDataKnownLowVolumeStillRejectsCandidate();
  console.log('All SignalScannerService ThetaData candidate tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
