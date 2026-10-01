import fs from 'fs';
import path from 'path';
import { SWING_EXIT_POLICY, SWING_MAX_HOLD_DAYS, SWING_TRAIL_MULT, resolvePremiumStopPct } from './swing-exit-policy';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function run() {
  console.log('Running swing-exit-policy parity tests...');
  const jsonPath = path.resolve(__dirname, '../../../shared/swing-exit-policy.json');
  assert(fs.existsSync(jsonPath), `shared/swing-exit-policy.json must exist at ${jsonPath}`);
  const shared = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  delete shared.$comment;
  const mirror = JSON.parse(JSON.stringify(SWING_EXIT_POLICY));
  const sharedText = JSON.stringify(shared, Object.keys(shared).sort());
  const mirrorText = JSON.stringify(mirror, Object.keys(mirror).sort());
  assert(sharedText === mirrorText, `TS mirror drifted from shared/swing-exit-policy.json:\n  shared: ${sharedText}\n  mirror: ${mirrorText}`);

  assert(Math.abs(SWING_TRAIL_MULT - 0.85) < 1e-12, 'Trail multiplier derives from trailPct');
  assert(SWING_MAX_HOLD_DAYS === 7, 'Max hold is 7 days');
  assert(resolvePremiumStopPct({ paper_policy: { premium_stop_pct: 30 } }) === 30, 'A sane engine premium stop wins');
  assert(resolvePremiumStopPct({ paper_policy: { premium_stop_pct: 0 } }) === 20, 'Zero falls back to the policy default');
  assert(resolvePremiumStopPct({ paper_policy: { premium_stop_pct: 150 } }) === 20, '>=100 falls back');
  assert(resolvePremiumStopPct(null) === 20 && resolvePremiumStopPct({}) === 20, 'Missing policy falls back');
  console.log('All swing-exit-policy parity tests passed!');
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
