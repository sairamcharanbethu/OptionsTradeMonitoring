import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';

const PositionSchema = z.object({
  symbol: z.string(),
  option_type: z.enum(['CALL', 'PUT']),
  strike_price: z.number(),
  expiration_date: z.string(), // Expecting ISO date string
  entry_price: z.number(),
  quantity: z.number().int(),
  stop_loss_trigger: z.number().optional(),
  take_profit_trigger: z.number().optional(),
  trailing_stop_loss_pct: z.number().optional(),
});

export async function positionRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  // GET all positions (including analytics if closed)
  fastify.get('/', async (request, reply) => {
    const { rows } = await fastify.pg.query('SELECT * FROM positions ORDER BY created_at DESC');
    return rows;
  });

  // GET single position
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
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
      (fastify as any).poller.syncPrice(body.symbol);
    } catch (err: any) {
      fastify.log.error({ err }, 'Failed to trigger immediate sync');
    }

    return reply.code(201).send(newPosition);
  });

  // UPDATE position status (CLOSE)
  // CLOSE position (Manual)
  fastify.post('/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { price?: number } | undefined;
    
    // 1. Fetch Position
    const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1', [id]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }
    const position = rows[0];

    // 2. Determine Close Price (Manual override or current market price)
    const closePrice = body?.price !== undefined ? body.price : Number(position.current_price);
    
    // 3. Calculate Analytics
    const entryPrice = Number(position.entry_price);
    const quantity = Number(position.quantity);
    const realizedPnl = (closePrice - entryPrice) * quantity * 100; // Standard option multiplier
    
    // Calculate loss avoided if it was a stop loss scenario? 
    // For now, simpler is better. We just want realized PnL.
    
    // 4. Update Position
    const updateQuery = `
      UPDATE positions 
      SET status = 'CLOSED', 
          realized_pnl = $1, 
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *
    `;
    
    const { rows: updatedRows } = await fastify.pg.query(updateQuery, [realizedPnl, id]);
    return updatedRows[0];
  });

  // REOPEN position (Manual)
  fastify.patch('/:id/reopen', async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const { rows } = await fastify.pg.query(
      `UPDATE positions 
       SET status = 'OPEN', 
           realized_pnl = NULL, 
           loss_avoided = NULL,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }
    return rows[0];
  });

  // UPDATE position full
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = PositionSchema.partial().parse(request.body); // Allow partial updates

    // 1. Fetch existing to get current trailing high
    const { rows: existingRows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1', [id]);
    if (existingRows.length === 0) {
        return reply.code(404).send({ error: 'Position not found' });
    }
    const currentPos = existingRows[0];

    // 2. Logic to recalculate trigger if pct changed
    let newStopTrigger = body.stop_loss_trigger;
    
    // If user sent a new PCT, we MUST recalculate the trigger based on the HIGH water mark
    if (body.trailing_stop_loss_pct !== undefined) {
        const highPrice = Number(currentPos.trailing_high_price);
        // Calculate new trigger: High * (1 - pct/100)
        newStopTrigger = highPrice * (1 - body.trailing_stop_loss_pct / 100);
    }

    // 3. Reset status to OPEN if previously STOP_TRIGGERED and user is updating trailing stop
    // This gives the position another chance after the user adjusts their stop loss
    let newStatus: string | null = null; // null means don't change
    if (currentPos.status === 'STOP_TRIGGERED' && body.trailing_stop_loss_pct !== undefined) {
        newStatus = 'OPEN';
        fastify.log.info({ id, newStopTrigger, oldPct: currentPos.trailing_stop_loss_pct, newPct: body.trailing_stop_loss_pct }, 'Resetting status to OPEN - trailing stop updated');
    }

    const query = `
      UPDATE positions 
      SET symbol = COALESCE($1, symbol), 
          option_type = COALESCE($2, option_type), 
          strike_price = COALESCE($3, strike_price), 
          expiration_date = COALESCE($4, expiration_date), 
          entry_price = COALESCE($5, entry_price), 
          quantity = COALESCE($6, quantity), 
          stop_loss_trigger = COALESCE($7, stop_loss_trigger), 
          take_profit_trigger = COALESCE($8, take_profit_trigger),
          trailing_stop_loss_pct = COALESCE($9, trailing_stop_loss_pct), 
          status = CASE WHEN $10::text IS NOT NULL THEN $10::text ELSE status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *
    `;
    
    const values = [
      body.symbol, body.option_type, body.strike_price, body.expiration_date,
      body.entry_price, body.quantity, newStopTrigger, body.take_profit_trigger,
      body.trailing_stop_loss_pct, newStatus, id
    ];

    const { rows } = await fastify.pg.query(query, values);
    return rows[0];
  });

  // DELETE position
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    
    try {
      // Manually clean up dependencies just in case CASCADE isn't working/setup
      await fastify.pg.query('DELETE FROM alerts WHERE position_id = $1', [id]);
      await fastify.pg.query('DELETE FROM price_history WHERE position_id = $1', [id]);
      
      const result = await fastify.pg.query('DELETE FROM positions WHERE id = $1', [id]);
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Position not found' });
      }
      return reply.code(204).send();
    } catch (err: any) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete position' });
    }
  });
}
