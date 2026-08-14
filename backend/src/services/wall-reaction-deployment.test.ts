import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..');
const service = 'zerogex-prefetch-qqq';
for (const relative of ['.github/workflows/deploy.yml', '.github/workflows/deploy-optimized.yml']) {
  const workflow = readFileSync(path.join(root, relative), 'utf8');
  const deploymentCommands = workflow.split('\n').filter((line) => /docker compose .* (pull|up) /.test(line));
  assert.ok(deploymentCommands.length >= 3, `${relative} must contain pull and environment-specific up commands`);
  assert.match(workflow, new RegExp(`services=\\([^\\n]*\\b${service}\\b`), `${relative} must retain ${service} in its deploy service list`);
  for (const command of deploymentCommands) {
    assert.ok(command.includes('"${services[@]}"') || command.includes(service), `${relative} does not deploy its resolved service list: ${command.trim()}`);
  }
}

const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
assert.match(compose, /^  zerogex-prefetch-qqq:\s*$/m);
assert.match(compose, /\/data\/wall-reaction\/QQQ-zerogex\.json/);
console.log('All WallReaction deployment topology tests passed!');
