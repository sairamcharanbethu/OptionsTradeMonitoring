#!/usr/bin/env node
// Runs every backend test file and keeps going past failures, so one stale
// assertion can no longer hide the rest of the suite (the old `&&` chain
// stopped at the first red file). Exits non-zero if any file failed.
//
// Usage: node scripts/run-tests.js [--filter <substring>] [--list]
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// Order matters only for readability; each file is an independent process.
// TS_NODE_FILES=true entries need the ambient type declarations in src/.
const TESTS = [
  'src/lib/trading-events.test.ts',
  'src/lib/security-config.test.ts',
  'src/lib/secret-box.test.ts',
  'src/lib/adapter-health.test.ts',
  'src/lib/market-calendar.test.ts',
  'src/lib/realtime.test.ts',
  'src/lib/economic-calendar.test.ts',
  'src/lib/trading-readiness.test.ts',
  'src/lib/process-watchdog.test.ts',
  'src/services/flatten-live-service.test.ts',
  'src/services/trade-events-stream.test.ts',
  'src/services/kill-switch-cache.test.ts',
  'src/services/stop-loss-engine.test.ts',
  'src/services/kill-switch-service.test.ts',
  'src/services/ibkr-market-data-service.test.ts',
  'src/services/ibkr-market-data-stream-service.test.ts',
  'src/services/live-exit-monitor-service.test.ts',
  'src/services/market-data-write-buffer-service.test.ts',
  'src/services/market-poller.test.ts',
  'src/services/strategy-engine-adapter.test.ts',
  'src/services/paper-trading-service.test.ts',
  'src/services/manual-option-order-service.test.ts',
  'src/services/signal-replay-backtester.test.ts',
  'src/services/option-market-history-capture-service.test.ts',
  'src/services/trade-redis-service.test.ts',
  'src/services/trade-lifecycle-service.test.ts',
  'src/services/trade-execution-service.test.ts',
  'src/services/live-ai-gate-service.test.ts',
  'src/services/zerogex-archive-service.test.ts',
  'src/services/snaptrade-service.test.ts',
  'src/services/order-watchdog-service.test.ts',
  'src/services/broker-position-reconciler.test.ts',
  'src/services/system-health-evaluator.test.ts',
  'src/services/discord-alert-service.test.ts',
  'src/routes/settings.test.ts',
  'src/routes/paper-account.test.ts',
  { file: 'src/routes/manual-entry.test.ts', env: { TS_NODE_FILES: 'true' } },
  { file: 'src/routes/market-data.test.ts', env: { TS_NODE_FILES: 'true' } },
  { file: 'src/routes/signals.test.ts', env: { TS_NODE_FILES: 'true' } },
  'src/routes/trades.test.ts'
];

const args = process.argv.slice(2);
const filterIndex = args.indexOf('--filter');
const filter = filterIndex >= 0 ? String(args[filterIndex + 1] || '') : '';
const listOnly = args.includes('--list');

const backendDir = path.resolve(__dirname, '..');
const fs = require('fs');
const entries = TESTS
  .map((entry) => (typeof entry === 'string' ? { file: entry, env: {} } : entry))
  .filter((entry) => !filter || entry.file.includes(filter));

if (listOnly) {
  for (const entry of entries) console.log(entry.file);
  process.exit(0);
}

const results = [];
const startedAll = Date.now();
for (const entry of entries) {
  const abs = path.join(backendDir, entry.file);
  if (!fs.existsSync(abs)) {
    results.push({ file: entry.file, status: 'MISSING', ms: 0 });
    continue;
  }
  const started = Date.now();
  process.stdout.write(`\n=== ${entry.file} ===\n`);
  const run = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['ts-node', entry.file],
    {
      cwd: backendDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test', ...entry.env }
    }
  );
  const ms = Date.now() - started;
  const status = run.status === 0 ? 'PASS' : (run.error ? 'ERROR' : 'FAIL');
  results.push({ file: entry.file, status, ms, code: run.status, error: run.error ? String(run.error.message || run.error) : null });
}

const pad = (value, width) => String(value).padEnd(width);
const widest = results.reduce((max, r) => Math.max(max, r.file.length), 4);
console.log('\n' + '='.repeat(widest + 24));
console.log(`${pad('FILE', widest)}  ${pad('STATUS', 8)}  TIME`);
console.log('-'.repeat(widest + 24));
for (const r of results) {
  console.log(`${pad(r.file, widest)}  ${pad(r.status, 8)}  ${(r.ms / 1000).toFixed(1)}s`);
}
console.log('='.repeat(widest + 24));
const failed = results.filter((r) => r.status !== 'PASS' && r.status !== 'MISSING');
const missing = results.filter((r) => r.status === 'MISSING');
const passed = results.filter((r) => r.status === 'PASS');
console.log(
  `${passed.length} passed, ${failed.length} failed, ${missing.length} missing ` +
  `in ${((Date.now() - startedAll) / 1000).toFixed(1)}s`
);
if (missing.length) {
  console.log('Missing (listed but not on disk): ' + missing.map((r) => r.file).join(', '));
}
if (failed.length) {
  console.log('FAILED: ' + failed.map((r) => r.file).join(', '));
  process.exit(1);
}
process.exit(0);
