import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';
import { getSettingsWithGlobalFallback, isGlobalSettingKey } from '../lib/settings-utils';

function redactGlobalSettingsForUser(settings: Record<string, string>, role?: string) {
    if (role === 'ADMIN') return settings;

    const redacted = { ...settings };
    for (const key of Object.keys(redacted)) {
        if (isGlobalSettingKey(key)) {
            delete redacted[key];
        }
    }
    return redacted;
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

    // QUESTRADE CONFIG
    fastify.get('/questrade/config', async (request, reply) => {
        try {
            const questrade = (fastify as any).questrade;
            const clientId = await questrade.getClientId();
            const isLinked = await questrade.isLinked();
            return { clientId, isLinked };
        } catch (err) {
            return reply.code(500).send({ error: 'Failed to fetch Questrade config' });
        }
    });

    // QUESTRADE SAVE CLIENT ID
    fastify.post('/questrade/client', async (request, reply) => {
        const { clientId } = request.body as { clientId: string };
        if (!clientId) return reply.code(400).send({ error: 'clientId required' });

        try {
            const questrade = (fastify as any).questrade;
            await questrade.setClientId(clientId);
            return { status: 'ok' };
        } catch (err) {
            return reply.code(500).send({ error: 'Failed to save client ID' });
        }
    });

    // QUESTRADE SAVE MANUAL REFRESH TOKEN
    fastify.post('/questrade/manual-token', async (request, reply) => {
        const { refreshToken } = request.body as { refreshToken: string };
        if (!refreshToken) return reply.code(400).send({ error: 'refreshToken required' });

        try {
            const questrade = (fastify as any).questrade;
            
            // Save the refresh token directly to database
            await questrade.saveTokenToDb(refreshToken);
            
            // Reset in-memory cache and global Redis cache
            questrade.token = null;
            await redis.del('QUESTRADE_ACTIVE_TOKEN');
            
            // Perform direct rotation refresh to verify token is valid and fetch access_token, etc.
            await questrade.refreshToken();
            
            return { status: 'ok', message: 'Manual token saved and verified successfully' };
        } catch (err: any) {
            fastify.log.error(err);
            const errMsg = err.response?.data?.error_description || err.response?.data?.message || err.message || 'Invalid token';
            return reply.code(400).send({ 
                error: `Failed to verify manual refresh token with Questrade: ${errMsg}` 
            });
        }
    });

    // QUESTRADE TOKEN CALLBACK (from frontend hash)
    fastify.post('/questrade/token', async (request, reply) => {
        const data = request.body as any;
        if (!data.access_token || !data.refresh_token) {
            return reply.code(400).send({ error: 'Invalid token data' });
        }

        try {
            const questrade = (fastify as any).questrade;
            await questrade.initializeWithToken({
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                api_server: data.api_server,
                token_type: data.token_type,
                expires_in: parseInt(data.expires_in, 10)
            });
            return { status: 'ok' };
        } catch (err) {
            return reply.code(500).send({ error: 'Failed to initialize Questrade token' });
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
