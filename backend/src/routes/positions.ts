import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { redis } from '../lib/redis';
import { AnalysisService } from '../services/analysis-service';

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

// OpenAPI schemas for documentation
const positionBodySchema = {
  type: 'object',
  required: ['symbol', 'option_type', 'strike_price', 'expiration_date', 'entry_price', 'quantity'],
  properties: {
    symbol: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL, TSLA)' },
    option_type: { type: 'string', enum: ['CALL', 'PUT'], description: 'Type of option' },
    strike_price: { type: 'number', description: 'Strike price of the option' },
    expiration_date: { type: 'string', format: 'date', description: 'Expiration date (YYYY-MM-DD)' },
    entry_price: { type: 'number', description: 'Price paid per contract' },
    quantity: { type: 'integer', minimum: 1, description: 'Number of contracts' },
    stop_loss_trigger: { type: 'number', description: 'Optional fixed stop loss price' },
    take_profit_trigger: { type: 'number', description: 'Optional take profit price' },
    trailing_stop_loss_pct: { type: 'number', description: 'Trailing stop loss percentage (e.g., 10 for 10%)' }
  }
};

const positionResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    user_id: { type: 'integer' },
    symbol: { type: 'string' },
    option_type: { type: 'string', enum: ['CALL', 'PUT'] },
    strike_price: { type: 'number' },
    expiration_date: { type: 'string' },
    entry_price: { type: 'number' },
    quantity: { type: 'integer' },
    stop_loss_trigger: { type: 'number', nullable: true },
    take_profit_trigger: { type: 'number', nullable: true },
    trailing_stop_loss_pct: { type: 'number', nullable: true },
    trailing_high_price: { type: 'number', nullable: true },
    current_price: { type: 'number', nullable: true },
    status: { type: 'string', enum: ['OPEN', 'CLOSED', 'STOP_TRIGGERED', 'PROFIT_TRIGGERED'] },
    realized_pnl: { type: 'number', nullable: true },
    delta: { type: 'number', nullable: true },
    theta: { type: 'number', nullable: true },
    gamma: { type: 'number', nullable: true },
    vega: { type: 'number', nullable: true },
    iv: { type: 'number', nullable: true },
    underlying_price: { type: 'number', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    analyzed_support: { type: 'number', nullable: true },
    analyzed_resistance: { type: 'number', nullable: true },
    suggested_stop_loss: { type: 'number', nullable: true },
    suggested_take_profit_1: { type: 'number', nullable: true },
    suggested_take_profit_2: { type: 'number', nullable: true },
    analysis_data: { type: 'object', nullable: true, additionalProperties: true }
  }
};

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' }
  }
};

const statsResponseSchema = {
  type: 'object',
  properties: {
    totalTrades: { type: 'integer' },
    closedTrades: { type: 'integer' },
    winRate: { type: 'number', description: 'Win rate percentage' },
    profitFactor: { type: 'number' },
    totalRealizedPnl: { type: 'number' },
    equityCurve: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date-time' },
          pnl: { type: 'number' }
        }
      }
    }
  }
};

export async function positionRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);
  const analysisService = new AnalysisService(fastify);

  // GET all positions (including analytics if closed)
  fastify.get('/', {
    schema: {
      tags: ['Positions'],
      summary: 'Get all positions',
      description: 'Retrieve all option positions for the authenticated user.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: positionResponseSchema
        }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const CACHE_KEY = `USER_POSITIONS:${userId}`;

    // Try cache
    const cached = await redis.get(CACHE_KEY);
    if (cached) return JSON.parse(cached);

    const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);

    // Set cache (60 seconds)
    await redis.set(CACHE_KEY, JSON.stringify(rows), 60);

    return rows;
  });

  // GET paginated closed positions (history)
  fastify.get('/history', {
    schema: {
      tags: ['Positions'],
      summary: 'Get closed positions (paginated)',
      description: 'Retrieve closed positions with pagination support. More efficient for large history.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1, description: 'Page number (1-indexed)' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Items per page' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            positions: { type: 'array', items: positionResponseSchema },
            total: { type: 'integer', description: 'Total number of closed positions' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalPages: { type: 'integer' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { page = 1, limit = 10 } = request.query as { page?: number; limit?: number };
    const offset = (page - 1) * limit;

    // Get total count
    const { rows: countRows } = await fastify.pg.query(
      'SELECT COUNT(*) as total FROM positions WHERE user_id = $1 AND status = $2',
      [userId, 'CLOSED']
    );
    const total = parseInt(countRows[0].total);
    const totalPages = Math.ceil(total / limit);

    // Get paginated data
    const { rows } = await fastify.pg.query(
      'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY updated_at DESC LIMIT $3 OFFSET $4',
      [userId, 'CLOSED', limit, offset]
    );

    return {
      positions: rows,
      total,
      page,
      limit,
      totalPages
    };
  });

  // GET lightweight price/greek updates for active positions
  fastify.get('/updates', {
    schema: {
      tags: ['Positions'],
      summary: 'Get lightweight position updates',
      description: 'Returns only prices, greeks, and status for open positions to minimize payload.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;

    // We don't cache this as much or at all because it's for real-time updates
    const query = `
      SELECT 
        id, current_price, delta, theta, gamma, vega, iv, 
        underlying_price, status, realized_pnl, updated_at,
        trailing_high_price, stop_loss_trigger
      FROM positions 
      WHERE user_id = $1 AND status != 'CLOSED'
    `;

    const { rows } = await fastify.pg.query(query, [userId]);

    // Transform to a map/dictionary for easier frontend patching
    const updates = rows.reduce((acc: any, row: any) => {
      acc[row.id] = row;
      return acc;
    }, {});

    return updates;
  });

  // GET portfolio stats
  fastify.get('/stats', {
    schema: {
      tags: ['Positions'],
      summary: 'Get portfolio statistics',
      description: 'Returns portfolio analytics including win rate, profit factor, and equity curve.',
      security: [{ bearerAuth: [] }],
      response: {
        200: statsResponseSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const CACHE_KEY = `USER_STATS:${userId}`;

    // Try cache
    const cached = await redis.get(CACHE_KEY);
    if (cached) return JSON.parse(cached);

    // 1. Basic counts and PnL
    const statsQuery = `
      SELECT 
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE status = 'CLOSED') as closed_trades,
        COUNT(*) FILTER (WHERE status = 'CLOSED' AND realized_pnl > 0) as win_count,
        SUM(realized_pnl) FILTER (WHERE status = 'CLOSED') as total_realized_pnl,
        SUM(realized_pnl) FILTER (WHERE status = 'CLOSED' AND realized_pnl > 0) as gross_profit,
        SUM(realized_pnl) FILTER (WHERE status = 'CLOSED' AND realized_pnl < 0) as gross_loss
      FROM positions 
      WHERE user_id = $1
    `;

    const { rows: statsRows } = await fastify.pg.query(statsQuery, [userId]);
    const mainStats = statsRows[0];

    // 2. Win Rate
    const closedCount = parseInt(mainStats.closed_trades || '0');
    const winRate = closedCount > 0 ? (parseInt(mainStats.win_count || '0') / closedCount) * 100 : 0;

    // 3. Profit Factor
    const grossProfit = parseFloat(mainStats.gross_profit || '0');
    const grossLoss = Math.abs(parseFloat(mainStats.gross_loss || '0'));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);

    // 4. Equity Curve (Daily realized PnL)
    const curveQuery = `
      SELECT 
        date, 
        SUM(daily_pnl) OVER (ORDER BY date) as total_pnl
      FROM (
        SELECT 
          date_trunc('day', updated_at) as date, 
          SUM(realized_pnl) as daily_pnl 
        FROM positions 
        WHERE status = 'CLOSED' AND user_id = $1 
        GROUP BY 1
      ) subquery
      ORDER BY date
    `;
    const { rows: curveRows } = await fastify.pg.query(curveQuery, [userId]);

    const result = {
      totalTrades: parseInt(mainStats.total_trades || '0'),
      closedTrades: closedCount,
      winRate: parseFloat(winRate.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      totalRealizedPnl: parseFloat(mainStats.total_realized_pnl || '0'),
      equityCurve: curveRows.map(r => ({
        date: r.date,
        pnl: parseFloat(r.total_pnl)
      }))
    };

    // Cache for 2 minutes
    await redis.set(CACHE_KEY, JSON.stringify(result), 120);

    return result;
  });

  // GET symbol search
  fastify.get('/search', {
    schema: {
      tags: ['Positions'],
      summary: 'Search for stock symbols',
      description: 'Search for stock/ETF symbols by keyword.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', description: 'Search query' }
        }
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              name: { type: 'string' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
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
  fastify.get('/:id', {
    schema: {
      tags: ['Positions'],
      summary: 'Get a single position',
      description: 'Retrieve a specific position by ID.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      response: {
        200: positionResponseSchema,
        404: errorSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const { rows } = await fastify.pg.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }
    return rows[0];
  });

  // GET price history
  fastify.get('/:id/history', {
    schema: {
      tags: ['Positions'],
      summary: 'Get price history',
      description: 'Retrieve historical price data for a position.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              price: { type: 'number' },
              recorded_at: { type: 'string', format: 'date-time' }
            }
          }
        },
        404: errorSchema
      }
    }
  }, async (request, reply) => {
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
  fastify.post('/', {
    schema: {
      tags: ['Positions'],
      summary: 'Create a new position',
      description: 'Create a new options position to track. This is the API equivalent of the UI form.',
      security: [{ bearerAuth: [] }],
      body: positionBodySchema,
      response: {
        201: positionResponseSchema,
        400: errorSchema
      }
    }
  }, async (request, reply) => {
    const body = PositionSchema.parse(request.body);

    // Default trailing peak to entry price
    const trailingHigh = body.entry_price;
    let stopLossTrigger = body.stop_loss_trigger;

    // Auto-calculate initial stop loss if % is provided
    if (!stopLossTrigger && body.trailing_stop_loss_pct) {
      stopLossTrigger = body.entry_price * (1 - body.trailing_stop_loss_pct / 100);
    }

    const { id: userId } = (request as any).user;



    // Perform Analysis
    let analysis: any = {};
    try {
      analysis = await analysisService.analyzePosition(body);
      // If suggested Stop Loss found and user didn't provide one, maybe we could use it?
      // But for now we just store it.
    } catch (err: any) {
      fastify.log.error(`Analysis failed during create: ${err.message}`);
    }

    const query = `
      INSERT INTO positions (
        user_id, symbol, option_type, strike_price, expiration_date, 
        entry_price, quantity, stop_loss_trigger, take_profit_trigger,
        trailing_high_price, trailing_stop_loss_pct,
        analyzed_support, analyzed_resistance, suggested_stop_loss, 
        suggested_take_profit_1, suggested_take_profit_2, analysis_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `;
    const values = [
      userId, body.symbol, body.option_type, body.strike_price, body.expiration_date,
      body.entry_price, body.quantity, stopLossTrigger, body.take_profit_trigger,
      trailingHigh, body.trailing_stop_loss_pct,
      analysis.support || null, analysis.resistance || null, analysis.stopLoss || null,
      analysis.takeProfit1 || null, analysis.takeProfit2 || null, JSON.stringify(analysis.confidences || {})
    ];

    const { rows } = await fastify.pg.query(query, values);
    const newPosition = rows[0];

    // Trigger immediate sync for this symbol
    try {
      (fastify as any).poller.syncPrice(body.symbol);
    } catch (err: any) {
      fastify.log.error({ err }, 'Failed to trigger immediate sync');
    }

    // Invalidate cache
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);

    return reply.code(201).send(newPosition);
  });


  // UPDATE position status (CLOSE)
  // CLOSE position (Manual)
  fastify.post('/:id/close', {
    schema: {
      tags: ['Positions'],
      summary: 'Close a position',
      description: 'Close a position fully or partially. If quantity is less than current quantity, a partial close is performed.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      body: {
        type: 'object',
        properties: {
          price: { type: 'number', description: 'Close price (defaults to current price if not specified)' },
          quantity: { type: 'integer', description: 'Quantity to close (defaults to full position)' }
        }
      },
      response: {
        200: positionResponseSchema,
        400: errorSchema,
        404: errorSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const body = request.body as { price?: number, quantity?: number } | undefined;

    const client = await fastify.pg.connect();
    try {
      // START TRANSACTION
      await client.query('BEGIN');

      // 1. Fetch Position and Verify Ownership (Lock row for update)
      const { rows } = await client.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Position not found' });
      }
      const position = rows[0];

      // 2. Determine Close Price and Quantity
      const closePrice = body?.price !== undefined ? body.price : Number(position.current_price);
      const closeQty = body?.quantity !== undefined ? body.quantity : Number(position.quantity);
      const currentQty = Number(position.quantity);

      if (closeQty <= 0 || closeQty > currentQty) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'Invalid quantity' });
      }

      // 3. Calculate Analytics for the closed portion
      const entryPrice = Number(position.entry_price);
      const realizedPnl = (closePrice - entryPrice) * closeQty * 100;

      let resultPosition;

      if (closeQty < currentQty) {
        // PARTIAL CLOSE
        // Update existing position to reflect remaining quantity
        await client.query(
          'UPDATE positions SET quantity = quantity - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [closeQty, id]
        );

        // Create a NEW closed position record for the sold portion
        const insertQuery = `
          INSERT INTO positions (
            user_id, symbol, option_type, strike_price, expiration_date, 
            entry_price, quantity, stop_loss_trigger, take_profit_trigger,
            trailing_high_price, trailing_stop_loss_pct, current_price,
            status, realized_pnl, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'CLOSED', $13, $14, CURRENT_TIMESTAMP)
          RETURNING *
        `;
        const values = [
          userId, position.symbol, position.option_type, position.strike_price, position.expiration_date,
          position.entry_price, closeQty, position.stop_loss_trigger, position.take_profit_trigger,
          position.trailing_high_price, position.trailing_stop_loss_pct, closePrice, realizedPnl, position.created_at
        ];

        const { rows: newRows } = await client.query(insertQuery, values);
        resultPosition = newRows[0];
      } else {
        // FULL CLOSE
        const updateQuery = `
          UPDATE positions 
          SET status = 'CLOSED', 
              realized_pnl = $1, 
              current_price = $2,
              updated_at = CURRENT_TIMESTAMP 
          WHERE id = $3 
          RETURNING *
        `;

        const { rows: updatedRows } = await client.query(updateQuery, [realizedPnl, closePrice, id]);
        resultPosition = updatedRows[0];
      }

      // COMMIT
      await client.query('COMMIT');

      // Invalidate cache
      await redis.set(`USER_POSITIONS:${userId}`, '', 1);

      return resultPosition;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // REOPEN position (Manual)
  fastify.patch('/:id/reopen', {
    schema: {
      tags: ['Positions'],
      summary: 'Reopen a closed position',
      description: 'Reopen a previously closed or triggered position, resetting stop loss and status.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      response: {
        200: positionResponseSchema,
        404: errorSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };

    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');

      // 1. Fetch current position to get entry price and trailing pct
      const { rows: existing } = await client.query('SELECT * FROM positions WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
      if (existing.length === 0) {
        await client.query('ROLLBACK');
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

      const { rows } = await client.query(
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

      await client.query('COMMIT');

      // 4. Trigger immediate sync
      try {
        (fastify as any).poller.syncPrice(pos.symbol);
      } catch (err: any) {
        fastify.log.error({ err }, 'Failed to trigger immediate sync on reopen');
      }

      // Invalidate cache
      await redis.set(`USER_POSITIONS:${userId}`, '', 1);

      return rows[0];

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // UPDATE position full
  fastify.put('/:id', {
    schema: {
      tags: ['Positions'],
      summary: 'Update a position',
      description: 'Update position fields. If trailing stop % is changed on a triggered position, it will be reopened.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      body: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          option_type: { type: 'string', enum: ['CALL', 'PUT'] },
          strike_price: { type: 'number' },
          expiration_date: { type: 'string', format: 'date' },
          entry_price: { type: 'number' },
          quantity: { type: 'integer' },
          stop_loss_trigger: { type: 'number' },
          take_profit_trigger: { type: 'number' },
          trailing_stop_loss_pct: { type: 'number' }
        }
      },
      response: {
        200: positionResponseSchema,
        404: errorSchema
      }
    }
  }, async (request, reply) => {
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

    // Invalidate cache
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);

    return rows[0];
  });

  // SYNC single position
  fastify.post('/:id/sync', {
    schema: {
      tags: ['Positions'],
      summary: 'Sync position price',
      description: 'Trigger an immediate price sync for this position\'s underlying symbol.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            symbol: { type: 'string' }
          }
        },
        404: errorSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const { rows } = await fastify.pg.query('SELECT symbol FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Position not found' });
    }

    const symbol = rows[0].symbol;
    const poller = (fastify as any).poller;
    if (poller) {
      await poller.syncPrice(symbol, true);
    }

    // Invalidate user cache to ensure fresh data on next GET
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);

    return { status: 'ok', symbol };
  });

  // BULK DELETE positions
  fastify.post('/bulk-delete', {
    schema: {
      tags: ['Positions'],
      summary: 'Bulk delete positions',
      description: 'Delete multiple positions by ID.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'integer' } }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            count: { type: 'integer' }
          }
        },
        500: errorSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { ids } = request.body as { ids: number[] };

    if (!ids || ids.length === 0) {
      return { success: true, count: 0 };
    }

    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');

      // Manually clean up dependencies 
      console.log(`[Bulk Delete] Deleting IDs: ${ids.join(', ')} for user ${userId}`);
      await client.query('DELETE FROM alerts WHERE position_id = ANY($1)', [ids]);
      await client.query('DELETE FROM price_history WHERE position_id = ANY($1)', [ids]);

      const result = await client.query(
        'DELETE FROM positions WHERE id = ANY($1) AND user_id = $2',
        [ids, userId]
      );

      await client.query('COMMIT');

      // Invalidate cache
      await redis.del(`USER_POSITIONS:${userId}`);
      await redis.del(`USER_STATS:${userId}`);

      return { success: true, count: result.rowCount };
    } catch (err: any) {
      await client.query('ROLLBACK');
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to bulk delete positions' });
    } finally {
      client.release();
    }
  });

  // DELETE position
  fastify.delete('/:id', {
    schema: {
      tags: ['Positions'],
      summary: 'Delete a position',
      description: 'Permanently delete a position and its associated price history and alerts.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Position ID' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' }
          }
        },
        404: errorSchema,
        500: errorSchema
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };

    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');

      // Verify ownership & Existence first
      const { rows: check } = await client.query('SELECT id FROM positions WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
      if (check.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Position not found' });
      }

      // Manual Cascade
      await client.query('DELETE FROM alerts WHERE position_id = $1', [id]);
      await client.query('DELETE FROM price_history WHERE position_id = $1', [id]);

      await client.query('DELETE FROM positions WHERE id = $1 AND user_id = $2', [id, userId]);

      await client.query('COMMIT');

      // Invalidate cache
      await redis.del(`USER_POSITIONS:${userId}`);
      await redis.del(`USER_STATS:${userId}`);

      return { success: true };
    } catch (err: any) {
      await client.query('ROLLBACK');
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to delete position' });
    } finally {
      client.release();
    }
  });
}
