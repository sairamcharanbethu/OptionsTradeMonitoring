"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.positionRoutes = positionRoutes;
const zod_1 = require("zod");
const PositionSchema = zod_1.z.object({
    symbol: zod_1.z.string(),
    option_type: zod_1.z.enum(['CALL', 'PUT']),
    strike_price: zod_1.z.number(),
    expiration_date: zod_1.z.string(), // Expecting ISO date string
    entry_price: zod_1.z.number(),
    quantity: zod_1.z.number().int(),
    stop_loss_trigger: zod_1.z.number().optional(),
    take_profit_trigger: zod_1.z.number().optional(),
    trailing_stop_loss_pct: zod_1.z.number().optional(),
});
async function positionRoutes(fastify, options) {
    // GET all positions (including analytics if closed)
    fastify.get('/', async (request, reply) => {
        const { rows } = await fastify.pg.query('SELECT * FROM positions ORDER BY created_at DESC');
        return rows;
    });
    // GET single position
    fastify.get('/:id', async (request, reply) => {
        const { id } = request.params;
        const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1', [id]);
        if (rows.length === 0) {
            return reply.code(404).send({ error: 'Position not found' });
        }
        return rows[0];
    });
    // CREATE position
    fastify.post('/', async (request, reply) => {
        const body = PositionSchema.parse(request.body);
        // Default trailing peak to entry price
        const trailingHigh = body.entry_price;
        let stopLossTrigger = body.stop_loss_trigger;
        // Auto-calculate initial stop loss if % is provided
        if (!stopLossTrigger && body.trailing_stop_loss_pct) {
            stopLossTrigger = body.entry_price * (1 - body.trailing_stop_loss_pct / 100);
        }
        const query = `
      INSERT INTO positions (
        symbol, option_type, strike_price, expiration_date, 
        entry_price, quantity, stop_loss_trigger, take_profit_trigger,
        trailing_high_price, trailing_stop_loss_pct
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
        const values = [
            body.symbol, body.option_type, body.strike_price, body.expiration_date,
            body.entry_price, body.quantity, stopLossTrigger, body.take_profit_trigger,
            trailingHigh, body.trailing_stop_loss_pct
        ];
        const { rows } = await fastify.pg.query(query, values);
        const newPosition = rows[0];
        // Trigger immediate sync for this symbol
        try {
            fastify.poller.syncPrice(body.symbol);
        }
        catch (err) {
            fastify.log.error({ err }, 'Failed to trigger immediate sync');
        }
        return reply.code(201).send(newPosition);
    });
    // UPDATE position status (CLOSE)
    fastify.patch('/:id/close', async (request, reply) => {
        const { id } = request.params;
        const { rows } = await fastify.pg.query('UPDATE positions SET status = \'CLOSED\', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *', [id]);
        if (rows.length === 0) {
            return reply.code(404).send({ error: 'Position not found' });
        }
        return rows[0];
    });
    // UPDATE position full
    fastify.put('/:id', async (request, reply) => {
        const { id } = request.params;
        const body = PositionSchema.parse(request.body);
        const query = `
      UPDATE positions 
      SET symbol = $1, option_type = $2, strike_price = $3, expiration_date = $4, 
          entry_price = $5, quantity = $6, stop_loss_trigger = $7, take_profit_trigger = $8,
          trailing_stop_loss_pct = $9, updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
    `;
        // Recalculate stop loss trigger if it wasn't provided but pct was
        let stopLossTrigger = body.stop_loss_trigger;
        if (!stopLossTrigger && body.trailing_stop_loss_pct) {
            stopLossTrigger = body.entry_price * (1 - body.trailing_stop_loss_pct / 100);
        }
        const values = [
            body.symbol, body.option_type, body.strike_price, body.expiration_date,
            body.entry_price, body.quantity, stopLossTrigger, body.take_profit_trigger,
            body.trailing_stop_loss_pct, id
        ];
        const { rows } = await fastify.pg.query(query, values);
        if (rows.length === 0) {
            return reply.code(404).send({ error: 'Position not found' });
        }
        return rows[0];
    });
    // DELETE position
    fastify.delete('/:id', async (request, reply) => {
        const { id } = request.params;
        const result = await fastify.pg.query('DELETE FROM positions WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return reply.code(404).send({ error: 'Position not found' });
        }
        return reply.code(204).send();
    });
}
//# sourceMappingURL=positions.js.map