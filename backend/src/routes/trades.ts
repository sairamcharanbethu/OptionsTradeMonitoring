import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SnaptradeService } from '../services/snaptrade-service';
import { TradeExecutionService } from '../services/trade-execution-service';
import { TradeLifecycleService } from '../services/trade-lifecycle-service';
import { TradeRedisService } from '../services/trade-redis-service';

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
    broker_exit_trade_id: { type: 'string', nullable: true },
    exit_requested_at: { type: 'string', nullable: true },
    exit_reason: { type: 'string', nullable: true },
    exit_order_type: { type: 'string', nullable: true },
    exit_retry_count: { type: 'integer', nullable: true },
    last_broker_sync_at: { type: 'string', nullable: true },
    last_broker_order_status: { type: 'string', nullable: true },
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
    const cached = await TradeRedisService.getOpenTrades(userId);
    if (cached) return cached;
    return TradeRedisService.rebuildOpenTrades(fastify.pg, userId);
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
      },
      response: {
        200: tradeResponseSchema,
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        409: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const body = request.body as { quantity?: number } | undefined;
    const snaptradeService = new SnaptradeService(fastify);
    const exitLock = await TradeRedisService.acquireLock(TradeRedisService.keys.exitLock(id));
    if (!exitLock.acquired) {
      return reply.code(409).send({ error: 'A close request is already in progress for this trade' });
    }

    try {
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

          const updatedTrade = await TradeLifecycleService.markExitSubmitted(
            client,
            id,
            order,
            {
              reason: 'MANUAL',
              orderType: 'MARKET',
              note: ` [Manual Wealthsimple MARKET exit submitted for ${closeQuantity} contract(s)${order.orderId ? `: ${order.orderId}` : ''}]`
            }
          );

          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId);
          return updatedTrade;
        } catch (err: any) {
          await TradeLifecycleService.markExitSubmissionFailure(client, id, err.message || String(err), 'Manual Wealthsimple exit failed');
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId);
          return reply.code(400).send({ error: err.message || 'Failed to submit Wealthsimple close order' });
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await TradeRedisService.releaseLock(exitLock);
    }
  });

  fastify.post('/:id/order-status', {
    schema: {
      tags: ['Trades'],
      summary: 'Refresh one Wealthsimple trade order status',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            trade: tradeResponseSchema,
            sync: { type: 'object' }
          }
        },
        404: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const owned = await fastify.pg.query(
      `SELECT id
       FROM positions
       WHERE id = $1
         AND user_id = $2
         AND execution_broker = 'wealthsimple_snaptrade'`,
      [id, userId]
    );
    if (!owned.rows[0]) return reply.code(404).send({ error: 'Wealthsimple trade not found' });

    const snaptradeService = new SnaptradeService(fastify);
    const sync = await snaptradeService.syncPendingBrokerOrders(userId);
    const brokerStatus = Array.isArray(sync.orders)
      ? sync.orders.find((order: any) => Number(order.positionId) === Number(id))?.status
      : null;

    await TradeLifecycleService.markBrokerSynced(fastify.pg, id, brokerStatus || null);
    await TradeRedisService.rebuildOpenTrades(fastify.pg, userId);

    const { rows } = await fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE id = $1
         AND user_id = $2
         AND execution_broker = 'wealthsimple_snaptrade'`,
      [id, userId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Wealthsimple trade not found' });
    return { trade: rows[0], sync };
  });

  fastify.post('/:id/retry-close', {
    schema: {
      tags: ['Trades'],
      summary: 'Retry a rejected Wealthsimple close after broker status refresh',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          quantity: { type: 'integer', minimum: 1 }
        }
      },
      response: {
        200: tradeResponseSchema,
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        409: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const body = request.body as { quantity?: number } | undefined;
    const snaptradeService = new SnaptradeService(fastify);
    const exitLock = await TradeRedisService.acquireLock(TradeRedisService.keys.exitLock(id));
    if (!exitLock.acquired) {
      return reply.code(409).send({ error: 'A close retry is already in progress for this trade' });
    }

    try {
    const owned = await fastify.pg.query(
      `SELECT id
       FROM positions
       WHERE id = $1
         AND user_id = $2
         AND execution_broker = 'wealthsimple_snaptrade'`,
      [id, userId]
    );
    if (!owned.rows[0]) return reply.code(404).send({ error: 'Wealthsimple trade not found' });

    let sync: any;
    try {
      sync = await snaptradeService.syncPendingBrokerOrders(userId);
    } catch (err: any) {
      fastify.log.warn(`[TradesRetryClose] Wealthsimple status check failed before retry for trade ${id}: ${err.message}`);
      return reply.code(409).send({ error: 'Could not verify latest Wealthsimple order status before retrying close.' });
    }

    const brokerStatus = Array.isArray(sync.orders)
      ? sync.orders.find((order: any) => Number(order.positionId) === Number(id))?.status
      : null;
    await TradeLifecycleService.markBrokerSynced(fastify.pg, id, brokerStatus || null);

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

        const trade = rows[0];
        if (!trade) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Wealthsimple trade not found' });
        }
        if (trade.status === 'CLOSED') {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Broker sync already closed this trade; retry was not submitted.' });
        }

        const retryDecision = TradeLifecycleService.canRetryExit(trade);
        if (!retryDecision.allowed) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: retryDecision.reason || 'Exit retry is not allowed' });
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

          const updatedTrade = await TradeLifecycleService.markExitSubmitted(
            client,
            id,
            order,
            {
              reason: trade.exit_reason || 'RETRY',
              orderType: 'MARKET',
              incrementRetry: true,
              note: ` [Retry Wealthsimple MARKET exit submitted for ${closeQuantity} contract(s) after broker status ${brokerStatus || trade.execution_status}${order.orderId ? `: ${order.orderId}` : ''}]`
            }
          );

          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId);
          return updatedTrade;
        } catch (err: any) {
          await TradeLifecycleService.markExitSubmissionFailure(client, id, err.message || String(err), 'Retry Wealthsimple exit failed');
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId);
          return reply.code(400).send({ error: err.message || 'Failed to retry Wealthsimple close order' });
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await TradeRedisService.releaseLock(exitLock);
    }
  });
}
