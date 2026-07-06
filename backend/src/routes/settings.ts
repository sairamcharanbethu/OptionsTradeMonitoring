import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';
import { getSettingsWithGlobalFallback, isGlobalSettingKey, isPublicGlobalSettingKey } from '../lib/settings-utils';
import { defaultIbkrPort } from '../lib/ibkr-config';

type RuntimeConfigSource = 'env' | 'settings' | 'default' | 'runtime';
type RuntimeConfigStatus = 'configured' | 'missing' | 'default' | 'attention';

type RuntimeConfigItem = {
    id: string;
    group: 'Deployment' | 'Market Data' | 'AI Service' | 'Broker Execution' | 'Alerts';
    label: string;
    source: RuntimeConfigSource;
    status: RuntimeConfigStatus;
    secret: boolean;
    value: string | null;
    detail: string;
};

function redactGlobalSettingsForUser(settings: Record<string, string>, role?: string) {
    if (role === 'ADMIN') return settings;

    const redacted = { ...settings };
    for (const key of Object.keys(redacted)) {
        if (isGlobalSettingKey(key) && !isPublicGlobalSettingKey(key)) {
            delete redacted[key];
        }
    }
    return redacted;
}

function requireAdmin(request: any, reply: any) {
    const { role } = request.user || {};
    if (role !== 'ADMIN') {
        return reply.code(403).send({ error: 'Admin access required' });
    }
}

function configured(value?: string | null) {
    return Boolean(String(value || '').trim());
}

function safeValue(value?: string | null) {
    const trimmed = String(value || '').trim();
    return trimmed || null;
}

function secretStatus(value?: string | null) {
    return configured(value) ? 'configured' as const : 'missing' as const;
}

function secretValue(value?: string | null) {
    return configured(value) ? 'Configured' : 'Missing';
}

function sourceFor(settingValue?: string | null, envValue?: string | null, defaultValue?: string | null): RuntimeConfigSource {
    if (configured(settingValue)) return 'settings';
    if (configured(envValue)) return 'env';
    if (configured(defaultValue)) return 'default';
    return 'default';
}

function valueFor(settingValue?: string | null, envValue?: string | null, defaultValue?: string | null) {
    return safeValue(settingValue) || safeValue(envValue) || safeValue(defaultValue);
}

function runtimeItem(item: RuntimeConfigItem) {
    return item;
}

export async function settingsRoutes(fastify: FastifyInstance) {
    fastify.addHook('onRequest', fastify.authenticate);

    // GET all settings
    fastify.get('/', async (request, reply) => {
        const { id: userId, role } = (request as any).user;

        try {
            const settings = await getSettingsWithGlobalFallback((fastify as any).pg, userId);
            return redactGlobalSettingsForUser(settings, role);
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch settings' });
        }
    });

    fastify.get('/runtime-config', async (request, reply) => {
        const adminCheck = requireAdmin(request, reply);
        if (adminCheck) return adminCheck;

        const { id: userId } = (request as any).user;

        try {
            const settings = await getSettingsWithGlobalFallback((fastify as any).pg, userId);
            const ibkrGatewayModeSetting = safeValue(settings.ibkr_gateway_mode);
            const ibkrGatewayMode = String(valueFor(settings.ibkr_gateway_mode, process.env.IBKR_GATEWAY_MODE, 'live') || 'live').toLowerCase() === 'paper' ? 'paper' : 'live';
            const ibkrHost = valueFor(settings.ibkr_host, process.env.IBKR_HOST, 'ib_gateway');
            const ibkrPort = safeValue(settings.ibkr_port)
                || (ibkrGatewayModeSetting ? String(defaultIbkrPort(ibkrGatewayMode)) : safeValue(process.env.IBKR_PORT))
                || String(defaultIbkrPort(ibkrGatewayMode));
            const ibkrMarketDataType = valueFor(undefined, process.env.IBKR_MARKET_DATA_TYPE, '1');
            const aiProvider = valueFor(settings.ai_provider, undefined, 'openrouter');
            const aiModel = valueFor(settings.ai_model, process.env.AI_MODEL, 'deepseek/deepseek-chat');
            const buildSha = process.env.BUILD_SHA || process.env.GITHUB_SHA || process.env.VITE_APP_BUILD_SHA || '';
            const appVersion = process.env.APP_VERSION || process.env.npm_package_version || '1.4.1';

            const items: RuntimeConfigItem[] = [
                runtimeItem({
                    id: 'deployment:node-env',
                    group: 'Deployment',
                    label: 'Node environment',
                    source: process.env.NODE_ENV ? 'env' : 'default',
                    status: process.env.NODE_ENV ? 'configured' : 'default',
                    secret: false,
                    value: process.env.NODE_ENV || 'development',
                    detail: 'Backend runtime mode.'
                }),
                runtimeItem({
                    id: 'deployment:version',
                    group: 'Deployment',
                    label: 'App version',
                    source: 'runtime',
                    status: 'configured',
                    secret: false,
                    value: appVersion,
                    detail: 'Backend package/runtime version.'
                }),
                runtimeItem({
                    id: 'deployment:build-sha',
                    group: 'Deployment',
                    label: 'Build SHA',
                    source: buildSha ? 'env' : 'default',
                    status: buildSha ? 'configured' : 'default',
                    secret: false,
                    value: buildSha ? buildSha.slice(0, 12) : null,
                    detail: 'Optional deployment revision for tracing.'
                }),
                runtimeItem({
                    id: 'market:ibkr-mode',
                    group: 'Market Data',
                    label: 'Market data provider',
                    source: sourceFor(settings.ibkr_gateway_mode, process.env.IBKR_GATEWAY_MODE, 'live'),
                    status: 'configured',
                    secret: false,
                    value: `IBKR Gateway (${ibkrGatewayMode === 'paper' ? 'Paper' : 'Live'})`,
                    detail: 'Backend talks to IBKR Gateway over the Docker network.'
                }),
                runtimeItem({
                    id: 'market:ibkr-host',
                    group: 'Market Data',
                    label: 'IBKR host',
                    source: sourceFor(settings.ibkr_host, process.env.IBKR_HOST, 'ib_gateway'),
                    status: ibkrHost ? 'configured' : 'missing',
                    secret: false,
                    value: ibkrHost,
                    detail: 'Used for stock bars, option chain, option quotes, and service health.'
                }),
                runtimeItem({
                    id: 'market:ibkr-port',
                    group: 'Market Data',
                    label: 'IBKR API port',
                    source: safeValue(settings.ibkr_port) ? 'settings' : ibkrGatewayModeSetting ? 'default' : sourceFor(undefined, process.env.IBKR_PORT, String(defaultIbkrPort(ibkrGatewayMode))),
                    status: ibkrPort ? 'configured' : 'missing',
                    secret: false,
                    value: ibkrPort,
                    detail: 'Use 4003 for live Gateway inside Docker; 4004 is paper.'
                }),
                runtimeItem({
                    id: 'market:ibkr-market-data-type',
                    group: 'Market Data',
                    label: 'IBKR market data type',
                    source: sourceFor(undefined, process.env.IBKR_MARKET_DATA_TYPE, '1'),
                    status: ibkrMarketDataType === '1' ? 'configured' : 'attention',
                    secret: false,
                    value: ibkrMarketDataType,
                    detail: '1 means live data. Delayed or frozen data should not be used for auto-entry.'
                }),
                runtimeItem({
                    id: 'ai:provider',
                    group: 'AI Service',
                    label: 'AI provider',
                    source: sourceFor(settings.ai_provider, undefined, 'openrouter'),
                    status: 'configured',
                    secret: false,
                    value: aiProvider,
                    detail: 'Shared by scanner, coach, news classification, and analysis.'
                }),
                runtimeItem({
                    id: 'ai:model',
                    group: 'AI Service',
                    label: 'AI model',
                    source: sourceFor(settings.ai_model, process.env.AI_MODEL, 'deepseek/deepseek-chat'),
                    status: 'configured',
                    secret: false,
                    value: aiModel,
                    detail: 'Primary model slug used by the app AI service.'
                }),
                runtimeItem({
                    id: 'ai:openrouter-key',
                    group: 'AI Service',
                    label: 'OpenRouter key',
                    source: configured(settings.openrouter_key) ? 'settings' : 'default',
                    status: aiProvider === 'openrouter' ? secretStatus(settings.openrouter_key) : 'default',
                    secret: true,
                    value: aiProvider === 'openrouter' ? secretValue(settings.openrouter_key) : 'Not required',
                    detail: 'Required when OpenRouter is selected.'
                }),
                runtimeItem({
                    id: 'ai:ollama-url',
                    group: 'AI Service',
                    label: 'Ollama URL',
                    source: process.env.OLLAMA_URL ? 'env' : 'default',
                    status: aiProvider === 'ollama' && !process.env.OLLAMA_URL ? 'attention' : 'configured',
                    secret: false,
                    value: process.env.OLLAMA_URL || 'http://host.docker.internal:11434',
                    detail: 'Only used when local Ollama is selected.'
                }),
                runtimeItem({
                    id: 'broker:snaptrade-client-id',
                    group: 'Broker Execution',
                    label: 'SnapTrade client ID',
                    source: configured(settings.snaptrade_client_id) ? 'settings' : 'default',
                    status: secretStatus(settings.snaptrade_client_id),
                    secret: true,
                    value: secretValue(settings.snaptrade_client_id),
                    detail: 'Required to connect Wealthsimple through SnapTrade.'
                }),
                runtimeItem({
                    id: 'broker:snaptrade-consumer-key',
                    group: 'Broker Execution',
                    label: 'SnapTrade consumer key',
                    source: configured(settings.snaptrade_consumer_key) ? 'settings' : 'default',
                    status: secretStatus(settings.snaptrade_consumer_key),
                    secret: true,
                    value: secretValue(settings.snaptrade_consumer_key),
                    detail: 'Required to place and sync broker orders.'
                }),
                runtimeItem({
                    id: 'broker:selected-account',
                    group: 'Broker Execution',
                    label: 'Trading account',
                    source: configured(settings.snaptrade_trading_account_id) ? 'settings' : 'default',
                    status: configured(settings.snaptrade_trading_account_id) ? 'configured' : 'missing',
                    secret: false,
                    value: configured(settings.snaptrade_trading_account_id) ? 'Selected' : 'Missing',
                    detail: 'Selected account used for live Wealthsimple execution.'
                }),
                runtimeItem({
                    id: 'broker:live-ack',
                    group: 'Broker Execution',
                    label: 'Live trading acknowledgement',
                    source: configured(settings.live_trading_acknowledged) ? 'settings' : 'default',
                    status: settings.live_trading_acknowledged === 'true' ? 'configured' : 'attention',
                    secret: false,
                    value: settings.live_trading_acknowledged === 'true' ? 'Accepted' : 'Missing',
                    detail: 'Required before live broker execution is allowed.'
                }),
                runtimeItem({
                    id: 'alerts:discord-webhook',
                    group: 'Alerts',
                    label: 'Discord webhook',
                    source: configured(settings.discord_webhook_url) ? 'settings' : configured(process.env.DISCORD_ALERT_WEBHOOK_URL) ? 'env' : 'default',
                    status: secretStatus(settings.discord_webhook_url || process.env.DISCORD_ALERT_WEBHOOK_URL),
                    secret: true,
                    value: secretValue(settings.discord_webhook_url || process.env.DISCORD_ALERT_WEBHOOK_URL),
                    detail: 'Used for day-trading and fallback alert notifications.'
                }),
                runtimeItem({
                    id: 'alerts:n8n-webhook',
                    group: 'Alerts',
                    label: 'N8N alert webhook',
                    source: configured(process.env.N8N_ALERT_WEBHOOK_URL) ? 'env' : 'default',
                    status: secretStatus(process.env.N8N_ALERT_WEBHOOK_URL),
                    secret: true,
                    value: secretValue(process.env.N8N_ALERT_WEBHOOK_URL),
                    detail: 'Deployment-level automation webhook.'
                })
            ];

            return {
                generatedAt: new Date().toISOString(),
                items
            };
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch runtime config' });
        }
    });

    // UPDATE settings (Batch)
    fastify.post('/', async (request, reply) => {
        const { id: userId, role } = (request as any).user;
        const updates = request.body as Record<string, string>;

        try {
            const client = await (fastify as any).pg.connect();
            try {
                await client.query('BEGIN');

                for (const [key, value] of Object.entries(updates)) {
                    if (role !== 'ADMIN' && isGlobalSettingKey(key)) {
                        continue;
                    }

                    const trimmedValue = typeof value === 'string' ? value.trim() : value;
                    await client.query(
                        `INSERT INTO settings (user_id, key, value, updated_at) 
                         VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
                         ON CONFLICT (user_id, key) DO UPDATE 
                         SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                        [userId, key, trimmedValue]
                    );
                }

                await client.query('COMMIT');

                // Invalidate cache
                await redis.set(`USER_SETTINGS:${userId}`, '', 1);

                // If poll interval was updated, notify the poller service
                if (updates.market_poll_interval) {
                    const newInterval = parseInt(updates.market_poll_interval, 10);
                    if (!isNaN(newInterval) && (fastify as any).poller) {
                        (fastify as any).poller.updateInterval(newInterval);
                    }
                }

                // If polling toggle was updated, stop/resume the poller
                if (updates.polling_enabled !== undefined && (fastify as any).poller) {
                    if (updates.polling_enabled === 'true') {
                        (fastify as any).poller.resume();
                    } else {
                        (fastify as any).poller.stop();
                    }
                }

                if (role === 'ADMIN' && (updates.ibkr_gateway_mode !== undefined || updates.ibkr_host !== undefined || updates.ibkr_port !== undefined) && (fastify as any).ibkrMarketDataStreamer?.restart) {
                    (fastify as any).ibkrMarketDataStreamer.restart().catch((err: any) => {
                        fastify.log.warn(`[Settings] Failed to restart IBKR stream after config change: ${err.message || String(err)}`);
                    });
                }

                return { status: 'ok', message: 'Settings updated' };
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update settings' });
        }
    });

    // TEST DISCORD WEBHOOK
    fastify.post('/test-discord', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const { webhookUrl } = request.body as { webhookUrl: string };
        if (!webhookUrl) return reply.code(400).send({ error: 'webhookUrl required' });

        try {
            const embedMessage = {
                content: `⚡ **Options Trade Monitoring — Discord Integration Test** ⚡\n\nThis is a test notification confirming that your Discord Webhook URL is configured correctly!\n\n🕒 **Timestamp**: ${new Date().toISOString()}`
            };
            const axios = require('axios');
            await axios.post(webhookUrl, embedMessage, { timeout: 8000 });
            return { status: 'ok', message: 'Test message sent successfully' };
        } catch (err: any) {
            fastify.log.error(`[Settings] Discord test failed: ${err.message}`);
            return reply.code(400).send({ error: `Discord webhook test failed: ${err.message}` });
        }
    });
}
