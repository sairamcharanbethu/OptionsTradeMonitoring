"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRoutes = settingsRoutes;
async function settingsRoutes(fastify) {
    // GET all settings
    fastify.get('/', async (request, reply) => {
        try {
            const { rows } = await fastify.pg.query('SELECT key, value FROM settings');
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
        const updates = request.body;
        try {
            const client = await fastify.pg.connect();
            try {
                await client.query('BEGIN');
                for (const [key, value] of Object.entries(updates)) {
                    await client.query(`INSERT INTO settings (key, value, updated_at) 
                         VALUES ($1, $2, CURRENT_TIMESTAMP) 
                         ON CONFLICT (key) DO UPDATE 
                         SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`, [key, value]);
                }
                await client.query('COMMIT');
                return { status: 'ok', message: 'Settings updated' };
            }
            catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
            {
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