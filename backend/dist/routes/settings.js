"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRoutes = settingsRoutes;
async function settingsRoutes(fastify) {
    fastify.addHook('onRequest', fastify.authenticate);
    // GET all settings
    fastify.get('/', async (request, reply) => {
        const { id: userId } = request.user;
        try {
            const { rows } = await fastify.pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
            const settings = rows.reduce((acc, row) => {
                acc[row.key] = row.value;
                return acc;
            }, {});
            // Mask keys for security if needed (simpler to just return for now as it's local)
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
}
//# sourceMappingURL=settings.js.map