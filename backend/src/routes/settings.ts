import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';

export async function settingsRoutes(fastify: FastifyInstance) {
    fastify.addHook('onRequest', fastify.authenticate);

    // GET all settings
    fastify.get('/', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const CACHE_KEY = `USER_SETTINGS:${userId}`;

        // Try cache
        const cached = await redis.get(CACHE_KEY);
        if (cached) return JSON.parse(cached);

        try {
            const { rows } = await (fastify as any).pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
            const settings = rows.reduce((acc: any, row: any) => {
                acc[row.key] = row.value;
                return acc;
            }, {});

            // Cache for 5 minutes
            await redis.set(CACHE_KEY, JSON.stringify(settings), 300);

            return settings;
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch settings' });
        }
    });

    // UPDATE settings (Batch)
    fastify.post('/', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const updates = request.body as Record<string, string>;

        try {
            const client = await (fastify as any).pg.connect();
            try {
                await client.query('BEGIN');

                for (const [key, value] of Object.entries(updates)) {
                    await client.query(
                        `INSERT INTO settings (user_id, key, value, updated_at) 
                         VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
                         ON CONFLICT (user_id, key) DO UPDATE 
                         SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                        [userId, key, value]
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
}
