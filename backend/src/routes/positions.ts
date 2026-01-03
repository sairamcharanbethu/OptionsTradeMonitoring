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
  fastify.addHook('onRequest', fastify.authenticate);

  // GET all positions (including analytics if closed)
  fastify.get('/', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return rows;
  });

  // GET symbol search
  fastify.get('/search', async (request, reply) => {
    const { q } = request.query as { q: string };
    if (!q) return [];

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      fastify.log.warn('ALPHA_VANTAGE_API_KEY not set, using mock/limited search');
      return [
        { symbol: 'AAPL', name: 'Apple Inc.' },
        { symbol: 'MSFT', name: 'Microsoft Corporation' },
        { symbol: 'GOOGL', name: 'Alphabet Inc.' },
        { symbol: 'AMZN', name: 'Amazon.com Inc.' },
        { symbol: 'TSLA', name: 'Tesla Inc.' },
        { symbol: 'NVDA', name: 'NVIDIA Corporation' },
        { symbol: 'META', name: 'Meta Platforms Inc.' },
      ].filter(s => s.symbol.toLowerCase().includes(q.toLowerCase()));
    }

    try {
      const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${q}&apikey=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.bestMatches) {
        return data.bestMatches.map((m: any) => ({
          symbol: m['1. symbol'],
          name: m['2. name'],
          type: m['3. type'],
          region: m['4. region']
        })).filter((m: any) => m.type === 'Equity' || m.type === 'ETF');
      }
      return [];
    } catch (err: any) {
      fastify.log.error(err);
      return [];
    }
  });

  // GET single position
  fastify.get('/:id', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }
    return rows[0];
  });

  // GET price history
  fastify.get('/:id/history', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };

    // Verify ownership first
    const { rows: check } = await fastify.pg.query('SELECT id FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (check.length === 0) return reply.code(404).send({ error: 'Position not found' });

    const { rows } = await fastify.pg.query(
      'SELECT price, recorded_at FROM price_history WHERE position_id = $1 ORDER BY recorded_at ASC',
      [id]
    );
    return rows;
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

    const { id: userId } = (request as any).user;

    const query = `
      INSERT INTO positions (
        user_id, symbol, option_type, strike_price, expiration_date, 
        entry_price, quantity, stop_loss_trigger, take_profit_trigger,
        trailing_high_price, trailing_stop_loss_pct
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const values = [
      userId, body.symbol, body.option_type, body.strike_price, body.expiration_date,
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
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const body = request.body as { price?: number } | undefined;

    // 1. Fetch Position and Verify Ownership
    const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
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
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };

    // 1. Fetch current position to get entry price and trailing pct
    const { rows: existing } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }
    const pos = existing[0];

    // 2. Reset high water mark to entry price (or current price?)
    // Entry price is safer to prevent immediate re-trigger if current price is low
    const newHigh = Number(pos.entry_price);
    let newStopTrigger = pos.stop_loss_trigger;

    // 3. Recalculate stop loss if trailing % exists
    if (pos.trailing_stop_loss_pct) {
      newStopTrigger = newHigh * (1 - Number(pos.trailing_stop_loss_pct) / 100);
    }

    const { rows } = await fastify.pg.query(
      `UPDATE positions 
       SET status = 'OPEN', 
           realized_pnl = NULL, 
           loss_avoided = NULL,
           trailing_high_price = $1,
           stop_loss_trigger = $2,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 
       RETURNING *`,
      [newHigh, newStopTrigger, id]
    );

    // 4. Trigger immediate sync
    try {
      (fastify as any).poller.syncPrice(pos.symbol);
    } catch (err: any) {
      fastify.log.error({ err }, 'Failed to trigger immediate sync on reopen');
    }

    return rows[0];
  });

  // UPDATE position full
  fastify.put('/:id', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const body = PositionSchema.partial().parse(request.body); // Allow partial updates

    // 1. Fetch existing to get current trailing high and verify ownership
    const { rows: existingRows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
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

  // SYNC single position
  fastify.post('/:id/sync', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const { rows } = await fastify.pg.query('SELECT symbol FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }

    const symbol = rows[0].symbol;
    const poller = (fastify as any).poller;
    if (poller) {
      await poller.syncPrice(symbol);
    }

    return { status: 'ok', symbol };
  });

  // DELETE position
  fastify.delete('/:id', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };

    try {
      // Verify ownership
      const { rows: check } = await fastify.pg.query('SELECT id FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
      if (check.length === 0) return reply.code(404).send({ error: 'Position not found' });

      // Manually clean up dependencies just in case CASCADE isn't working/setup
      await fastify.pg.query('DELETE FROM alerts WHERE position_id = $1', [id]);
      await fastify.pg.query('DELETE FROM price_history WHERE position_id = $1', [id]);

      const result = await fastify.pg.query('DELETE FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
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
