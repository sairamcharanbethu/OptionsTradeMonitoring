import '@fastify/postgres';
import { DiscordAlertService } from './discord-alert-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function withFetch<T>(impl: (url: any, init: any) => Promise<any>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as any).fetch = impl;
  try {
    return await run();
  } finally {
    (globalThis as any).fetch = original;
  }
}

// The alert path must survive a Postgres outage — that outage is often the
// thing being reported — by falling through to the env webhook.
async function testEnvWebhookIsUsedWhenSettingsAreUnavailable() {
  process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.test/hook/env';
  const warnings: string[] = [];
  const fastify = {
    log: { info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} },
    pg: { query: async () => { throw new Error('connection terminated unexpectedly'); } }
  } as any;
  const posted: string[] = [];
  const sent = await withFetch(async (url) => { posted.push(String(url)); return { ok: true, text: async () => '' }; }, () =>
    new DiscordAlertService(fastify).send({ userId: 1, title: 'Postgres unreachable', message: 'down', severity: 'critical', category: 'system-health:postgres_down' }));
  assert(sent === true, 'The alert is delivered despite the settings failure');
  assert(posted.length === 1 && posted[0] === 'https://discord.test/hook/env', 'The env webhook is used');
  assert(warnings.some((w) => w.includes('Settings unavailable')), 'The fallback is logged');
}

async function testNoWebhookAnywhereReturnsFalse() {
  delete process.env.DISCORD_ALERT_WEBHOOK_URL;
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: { query: async () => { throw new Error('db down'); } }
  } as any;
  let fetched = false;
  const sent = await withFetch(async () => { fetched = true; return { ok: true, text: async () => '' }; }, () =>
    new DiscordAlertService(fastify).send({ userId: 1, title: 't', message: 'm' }));
  assert(sent === false && fetched === false, 'Without any webhook nothing is posted');
}

async function testUserWebhookStillPreferredWhenSettingsLoad() {
  process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.test/hook/env';
  const fastify = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pg: { query: async () => ({ rows: [{ key: 'discord_webhook_url', value: 'https://discord.test/hook/user' }, { key: 'discord_alerts_enabled', value: 'true' }] }) }
  } as any;
  const posted: string[] = [];
  await withFetch(async (url) => { posted.push(String(url)); return { ok: true, text: async () => '' }; }, () =>
    new DiscordAlertService(fastify).send({ userId: 1, title: 't', message: 'm' }));
  assert(posted.length === 1 && posted[0] === 'https://discord.test/hook/user', 'A configured per-user webhook wins over the env one');
  delete process.env.DISCORD_ALERT_WEBHOOK_URL;
}

async function runTests() {
  console.log('Running DiscordAlertService tests...');
  await testEnvWebhookIsUsedWhenSettingsAreUnavailable();
  await testNoWebhookAnywhereReturnsFalse();
  await testUserWebhookStillPreferredWhenSettingsLoad();
  console.log('All DiscordAlertService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
