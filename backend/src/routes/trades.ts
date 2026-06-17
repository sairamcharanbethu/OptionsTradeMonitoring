import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { redis } from '../lib/redis';
import { SnaptradeService } from '../services/snaptrade-service';
import { TradeExecutionService } from '../services/trade-execution-service';
import { TradeLifecycleService } from '../services/trade-lifecycle-service';

const tradeResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    symbol: { type: 'string' },
    option_type: { type: 'string' },
    strike_price: { type: 'number' },
    expiration_date: { type: 'string' },
    entry_price: { type: 'number' },
    exit_price: { type: 'number', nullable: true },
    quantity: { type: 'integer' },
    current_price: { type: 'number', nullable: true },
    underlying_price: { type: 'number', nullable: true },
    stop_loss_trigger: { type: 'number', nullable: true },
    take_profit_trigger: { type: 'number', nullable: true },
    status: { type: 'string' },
    realized_pnl: { type: 'number', nullable: true },
    execution_status: { type: 'string', nullable: true },
    execution_error: { type: 'string', nullable: true },
    account_id: { type: 'string', nullable: true },
    broker_order_id: { type: 'string', nullable: true },
    broker_exit_order_id: { type: 'string', nullable: true },
    exit_requested_at: { type: 'string', nullable: true },
    exit_reason: { type: 'string', nullable: true },
    exit_order_type: { type: 'string', nullable: true },
    profit_trim_status: { type: 'string', nullable: true },
    profit_trim_quantity: { type: 'integer', nullable: true },
    profit_trim_price: { type: 'number', nullable: true },
    profit_trim_order_id: { type: 'string', nullable: true },
    profit_trim_trade_id: { type: 'string', nullable: true },
    profit_trimmed_at: { type: 'string', nullable: true },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    notes: { type: 'string', nullable: true }
  }
};

function constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
  const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
  const [year, month, day] = dateStr.split('-');
  const side = type === 'CALL' ? 'C' : 'P';
  return `${symbol.toUpperCase()}${year.slice(-2)}${month}${day}${side}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
}

export async function tradeRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/usage', {
    schema: {
      tags: ['Trades'],
      summary: 'Get current day trade usage for the authenticated user',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            used: { type: 'integer' },
            max: { type: 'integer' },
            remaining: { type: 'integer' }
          },
          required: ['used', 'max', 'remaining']
        }
      }
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const executionService = new TradeExecutionService(fastify);
    return executionService.getDailyTradeUsage(userId);
  });

  fastify.get('/open', {
    schema: {
      tags: ['Trades'],
      summary: 'Get open Wealthsimple trades',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: tradeResponseSchema
        }
      }
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    try {
      const snaptradeService = new SnaptradeService(fastify);
      await snaptradeService.syncPendingBrokerOrders(userId);
    } catch (err: any) {
      fastify.log.warn(`[TradesOpen] Wealthsimple pending-order sync failed before listing trades: ${err.message}`);
    }

    const { rows } = await fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status IN ('PENDING_ORDER', 'OPEN')
       ORDER BY
         CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END,
         created_at DESC`,
      [userId]
    );
    return rows;
  });

  fastify.get('/closed', {
    schema: {
      tags: ['Trades'],
      summary: 'Get closed Wealthsimple trades',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          symbol: { type: 'string' },
          result: { type: 'string', enum: ['all', 'win', 'loss'] },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const query = request.query as {
      from?: string;
      to?: string;
      symbol?: string;
      result?: 'all' | 'win' | 'loss';
      page?: number;
      limit?: number;
    };
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
    const offset = (page - 1) * limit;
    const where = [
      'user_id = $1',
      "execution_broker = 'wealthsimple_snaptrade'",
      "status = 'CLOSED'"
    ];
    const values: any[] = [userId];

    if (query.from) {
      values.push(query.from);
      where.push(`updated_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      where.push(`updated_at < ($${values.length}::date + INTERVAL '1 day')`);
    }
    if (query.symbol) {
      values.push(query.symbol.toUpperCase());
      where.push(`symbol = $${values.length}`);
    }
    if (query.result === 'win') {
      where.push('realized_pnl > 0');
    } else if (query.result === 'loss') {
      where.push('realized_pnl < 0');
    }

    const whereSql = where.join(' AND ');
    const { rows: countRows } = await fastify.pg.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(realized_pnl), 0)::float AS total_pnl,
              COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
              COUNT(*) FILTER (WHERE realized_pnl < 0)::int AS losses,
              COALESCE(AVG(realized_pnl), 0)::float AS average_pnl
       FROM positions
       WHERE ${whereSql}`,
      values
    );

    const listValues = [...values, limit, offset];
    const { rows } = await fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE ${whereSql}
       ORDER BY updated_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      listValues
    );

    const summary = countRows[0] || { total: 0, total_pnl: 0, wins: 0, losses: 0, average_pnl: 0 };
    return {
      trades: rows,
      summary: {
        total: Number(summary.total || 0),
        totalPnl: Number(summary.total_pnl || 0),
        wins: Number(summary.wins || 0),
        losses: Number(summary.losses || 0),
        averagePnl: Number(summary.average_pnl || 0),
        winRate: Number(summary.total || 0) > 0 ? Number(((Number(summary.wins || 0) / Number(summary.total)) * 100).toFixed(1)) : 0
      },
      page,
      limit,
      totalPages: Math.ceil(Number(summary.total || 0) / limit)
    };
  });

  fastify.post('/:id/close', {
    schema: {
      tags: ['Trades'],
      summary: 'Submit manual Wealthsimple trade close',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          quantity: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const body = request.body as { quantity?: number } | undefined;
    const snaptradeService = new SnaptradeService(fastify);

    try {
      await snaptradeService.syncPendingBrokerOrders(userId);
    } catch (err: any) {
      fastify.log.warn(`[TradesClose] Wealthsimple status check failed before close for trade ${id}: ${err.message}`);
      return reply.code(409).send({ error: 'Could not verify latest Wealthsimple order status before submitting another close. Try again after sync completes.' });
    }

    const client = await fastify.pg.connect();

    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT *
         FROM positions
         WHERE id = $1
           AND user_id = $2
           AND execution_broker = 'wealthsimple_snaptrade'
         FOR UPDATE`,
        [id, userId]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Wealthsimple trade not found' });
      }

      const trade = rows[0];
      try {
        TradeLifecycleService.assertCanRequestExit(trade);
      } catch (err: any) {
        await client.query('ROLLBACK');
        return reply.code(TradeLifecycleService.isBrokerExitReviewStatus(trade.execution_status) ? 409 : 400).send({ error: err.message });
      }

      const closeQuantity = Number(body?.quantity || trade.quantity || 1);
      if (!Number.isFinite(closeQuantity) || closeQuantity <= 0 || closeQuantity > Number(trade.quantity)) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'Invalid close quantity' });
      }

      const accountId = String(trade.execution_account_id || trade.account_id || '').trim();
      if (!accountId) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'No Wealthsimple account id is attached to this trade' });
      }

      try {
        const optionSymbol = constructOSITicker(trade.symbol, Number(trade.strike_price), trade.option_type, trade.expiration_date);
        const order = await snaptradeService.placeOptionOrder(
          userId,
          accountId,
          optionSymbol,
          'SELL_TO_CLOSE',
          closeQuantity,
          'MARKET'
        );

        const { rows: updatedRows } = await client.query(
          `UPDATE positions
           SET execution_status = 'PENDING_EXIT',
               execution_error = NULL,
               broker_exit_order_id = $1,
               broker_exit_trade_id = $2,
               exit_reason = 'MANUAL',
               exit_order_type = 'MARKET',
               exit_requested_at = CURRENT_TIMESTAMP,
               notes = COALESCE(notes, '') || $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4
           RETURNING *`,
          [
            order.orderId || null,
            order.tradeId || null,
            ` [Manual Wealthsimple MARKET exit submitted for ${closeQuantity} contract(s)${order.orderId ? `: ${order.orderId}` : ''}]`,
            id
          ]
        );

        await client.query('COMMIT');
        await redis.del(`USER_POSITIONS:${userId}`);
        await redis.del(`USER_STATS:${userId}`);
        return updatedRows[0];
      } catch (err: any) {
        await TradeLifecycleService.markExitSubmissionFailure(client, id, err.message || String(err), 'Manual Wealthsimple exit failed');
        await client.query('COMMIT');
        await redis.del(`USER_POSITIONS:${userId}`);
        await redis.del(`USER_STATS:${userId}`);
        return reply.code(400).send({ error: err.message || 'Failed to submit Wealthsimple close order' });
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
