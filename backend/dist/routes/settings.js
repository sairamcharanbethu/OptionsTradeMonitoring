"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRoutes = settingsRoutes;
const redis_1 = require("../lib/redis");
async function settingsRoutes(fastify) {
    fastify.addHook('onRequest', fastify.authenticate);
    // GET all settings
    fastify.get('/', async (request, reply) => {
        const { id: userId } = request.user;
        const CACHE_KEY = `USER_SETTINGS:${userId}`;
        // Try cache
        const cached = await redis_1.redis.get(CACHE_KEY);
        if (cached)
            return JSON.parse(cached);
        try {
            const { rows } = await fastify.pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
            const settings = rows.reduce((acc, row) => {
                acc[row.key] = row.value;
                return acc;
            }, {});
            // Cache for 5 minutes
            await redis_1.redis.set(CACHE_KEY, JSON.stringify(settings), 300);
            return settings;
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch settings' });
        }
    });
    // UPDATE settings (Batch)
    fastify.post('/', async (request, reply) => {
        const { id: userId } = request.user;
        const updates = request.body;
        try {
            const client = await fastify.pg.connect();
            try {
                await client.query('BEGIN');
                for (const [key, value] of Object.entries(updates)) {
                    await client.query(`INSERT INTO settings (user_id, key, value, updated_at) 
                         VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
                         ON CONFLICT (user_id, key) DO UPDATE 
                         SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`, [userId, key, value]);
                }
                await client.query('COMMIT');
                // Invalidate cache
                await redis_1.redis.set(`USER_SETTINGS:${userId}`, '', 1);
                // If poll interval was updated, notify the poller service
                if (updates.market_poll_interval) {
                    const newInterval = parseInt(updates.market_poll_interval, 10);
                    if (!isNaN(newInterval) && fastify.poller) {
                        fastify.poller.updateInterval(newInterval);
                    }
                }
                return { status: 'ok', message: 'Settings updated' };
            }
            catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
            finally {
                client.release();
            }
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update settings' });
        }
    });
    // QUESTRADE CONFIG
    fastify.get('/questrade/config', async (request, reply) => {
        try {
            const questrade = fastify.questrade;
            const clientId = await questrade.getClientId();
            const isLinked = await questrade.isLinked();
            return { clientId, isLinked };
        }
        catch (err) {
            return reply.code(500).send({ error: 'Failed to fetch Questrade config' });
        }
    });
    // QUESTRADE SAVE CLIENT ID
    fastify.post('/questrade/client', async (request, reply) => {
        const { clientId } = request.body;
        if (!clientId)
            return reply.code(400).send({ error: 'clientId required' });
        try {
            const questrade = fastify.questrade;
            await questrade.setClientId(clientId);
            return { status: 'ok' };
        }
        catch (err) {
            return reply.code(500).send({ error: 'Failed to save client ID' });
        }
    });
    // QUESTRADE SAVE MANUAL REFRESH TOKEN
    fastify.post('/questrade/manual-token', async (request, reply) => {
        const { refreshToken } = request.body;
        if (!refreshToken)
            return reply.code(400).send({ error: 'refreshToken required' });
        try {
            const questrade = fastify.questrade;
            // Save the refresh token directly to database
            await questrade.saveTokenToDb(refreshToken);
            // Reset in-memory cache and global Redis cache
            questrade.token = null;
            await redis_1.redis.del('QUESTRADE_ACTIVE_TOKEN');
            // Perform direct rotation refresh to verify token is valid and fetch access_token, etc.
            await questrade.refreshToken();
            return { status: 'ok', message: 'Manual token saved and verified successfully' };
        }
        catch (err) {
            fastify.log.error(err);
            const errMsg = err.response?.data?.error_description || err.response?.data?.message || err.message || 'Invalid token';
            return reply.code(400).send({
                error: `Failed to verify manual refresh token with Questrade: ${errMsg}`
            });
        }
    });
    // QUESTRADE TOKEN CALLBACK (from frontend hash)
    fastify.post('/questrade/token', async (request, reply) => {
        const data = request.body;
        if (!data.access_token || !data.refresh_token) {
            return reply.code(400).send({ error: 'Invalid token data' });
        }
        try {
            const questrade = fastify.questrade;
            await questrade.initializeWithToken({
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                api_server: data.api_server,
                token_type: data.token_type,
                expires_in: parseInt(data.expires_in, 10)
            });
            return { status: 'ok' };
        }
        catch (err) {
            return reply.code(500).send({ error: 'Failed to initialize Questrade token' });
        }
    });
}
//# sourceMappingURL=settings.js.map