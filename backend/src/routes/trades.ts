import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SnaptradeService } from '../services/snaptrade-service';
import { TradeExecutionService } from '../services/trade-execution-service';
import { TradeLifecycleService } from '../services/trade-lifecycle-service';
import { TradeRedisService } from '../services/trade-redis-service';
import { DiscordAlertService } from '../services/discord-alert-service';
import { buildCommandReplayEventsQuery } from '../lib/trade-command-events';

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
    max_favorable_price: { type: 'number', nullable: true },
    max_adverse_price: { type: 'number', nullable: true },
    mfe_pct: { type: 'number', nullable: true },
    mae_pct: { type: 'number', nullable: true },
    underlying_price: { type: 'number', nullable: true },
    underlying_stop_price: { type: 'number', nullable: true },
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

function getTradeNextAction(trade: any) {
  const status = String(trade?.status || '');
  const executionStatus = String(trade?.execution_status || '');

  if (status === 'CLOSED') return { label: 'Closed', detail: 'No further action is expected for this trade.' };
  if (status === 'PENDING_ORDER') return { label: 'Waiting for entry fill', detail: 'Broker reconciliation is watching the entry order.' };
  if (executionStatus === 'PENDING_TRIM') return { label: 'Trim pending', detail: 'Waiting for broker confirmation of the partial profit-taking order.' };
  if (executionStatus === 'PENDING_EXIT') return { label: 'Close pending', detail: 'Waiting for broker confirmation of the exit order.' };
  if (executionStatus === 'EXIT_STALE') return { label: 'Verify broker', detail: 'Broker status must be checked before another close is submitted.' };
  if (executionStatus.startsWith('EXIT_')) return { label: 'Broker review required', detail: `Exit status is ${executionStatus}; sync Wealthsimple before retrying.` };
  if (trade?.profit_trim_status === 'DONE') return { label: 'Holding remainder', detail: 'Trim is complete; remaining contracts are managed by the active stop/exit plan.' };
  if (status === 'OPEN') return { label: 'Holding', detail: 'Monitoring active stop loss, take profit, trim, and signal supersession rules.' };
  return { label: 'Review state', detail: `Current state is ${status || 'unknown'}${executionStatus ? ` / ${executionStatus}` : ''}.` };
}

function getTradeRiskPlan(trade: any) {
  const entryPrice = Number(trade?.entry_price || 0);
  const quantity = Number(trade?.quantity || 0);
  const stopLoss = trade?.stop_loss_trigger == null ? null : Number(trade.stop_loss_trigger);
  const takeProfit = trade?.take_profit_trigger == null ? null : Number(trade.take_profit_trigger);
  return {
    entryPrice,
    currentPrice: trade?.current_price == null ? null : Number(trade.current_price),
    mfePct: trade?.mfe_pct == null ? null : Number(trade.mfe_pct),
    maePct: trade?.mae_pct == null ? null : Number(trade.mae_pct),
    quantity,
    stopLoss,
    takeProfit,
    trim: {
      status: trade?.profit_trim_status || null,
      quantity: trade?.profit_trim_quantity == null ? null : Number(trade.profit_trim_quantity),
      price: trade?.profit_trim_price == null ? null : Number(trade.profit_trim_price),
      orderId: trade?.profit_trim_order_id || null,
      filledAt: trade?.profit_trimmed_at || null
    },
    estimatedMaxLoss: stopLoss !== null && entryPrice > 0 ? Number(((entryPrice - stopLoss) * quantity * 100).toFixed(2)) : null,
    underlyingPlan: {
      stop: trade?.suggested_stop_loss == null ? null : Number(trade.suggested_stop_loss),
      target: trade?.suggested_take_profit_1 == null ? null : Number(trade.suggested_take_profit_1)
    }
  };
}

function getTradeBrokerProof(trade: any) {
  return {
    broker: trade?.execution_broker || trade?.account_id || 'unknown',
    accountId: trade?.execution_account_id || trade?.account_id || null,
    entryOrderId: trade?.broker_order_id || null,
    entryTradeId: trade?.broker_trade_id || null,
    exitOrderId: trade?.broker_exit_order_id || null,
    exitTradeId: trade?.broker_exit_trade_id || null,
    trimOrderId: trade?.profit_trim_order_id || null,
    trimTradeId: trade?.profit_trim_trade_id || null,
    lastBrokerStatus: trade?.last_broker_order_status || null,
    lastBrokerSyncAt: trade?.last_broker_sync_at || null,
    executionStatus: trade?.execution_status || null,
    executionError: trade?.execution_error || null
  };
}

function reportRangeToInterval(range?: string) {
  switch (String(range || '30d')) {
    case '7d': return '7 days';
    case '30d': return '30 days';
    case '90d': return '90 days';
    case 'ytd': return 'year';
    case '1y': return '1 year';
    default: return '30 days';
  }
}

function describeTradeOutcome(trade: any) {
  const pnl = Number(trade.realized_pnl || 0);
  const exitReason = String(trade.exit_reason || '').toUpperCase();
  const notes = String(trade.notes || '').toUpperCase();
  if (exitReason.includes('TAKE_PROFIT') || exitReason.includes('PROFIT') || notes.includes('TRIM')) return 'Profit logic';
  if (exitReason.includes('STOP') || pnl < 0) return 'Stop loss or adverse move';
  if (exitReason.includes('SUPERSEDED')) return 'Signal superseded';
  if (exitReason.includes('MANUAL')) return 'Manual exit';
  return pnl >= 0 ? 'Closed profitable' : 'Closed loss';
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
    return TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
  });

  fastify.get('/open/runtime', {
    schema: {
      tags: ['Trades'],
      summary: 'Get Redis-backed open Wealthsimple trades with freshness metadata',
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const cached = await TradeRedisService.getOpenTradesReadModel(userId);
    if (cached) return cached;
    const data = await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
    return {
      generatedAt: new Date().toISOString(),
      source: 'db',
      ageMs: 0,
      data
    };
  });

  fastify.get('/report', {
    schema: {
      tags: ['Trades'],
      summary: 'Get trade outcome report and failure review',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: ['today', '7d', '30d', '90d', 'ytd', '1y'] }
        }
      }
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const { range = '30d' } = request.query as { range?: string };
    const interval = reportRangeToInterval(range);
    const rangePredicate = range === 'today'
      ? "updated_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'"
      : range === 'ytd'
      ? "updated_at >= date_trunc('year', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'"
      : `updated_at >= now() - INTERVAL '${interval}'`;
    const signalRangePredicate = range === 'today'
      ? "sue.updated_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'"
      : range === 'ytd'
      ? "sue.updated_at >= date_trunc('year', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'"
      : `sue.updated_at >= now() - INTERVAL '${interval}'`;

    const { rows: summaryRows } = await fastify.pg.query(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(realized_pnl), 0)::float AS total_pnl,
         COALESCE(AVG(realized_pnl), 0)::float AS average_pnl,
         COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
         COUNT(*) FILTER (WHERE realized_pnl < 0)::int AS losses,
         COALESCE(AVG(realized_pnl) FILTER (WHERE realized_pnl > 0), 0)::float AS average_win,
         COALESCE(AVG(realized_pnl) FILTER (WHERE realized_pnl < 0), 0)::float AS average_loss,
         COALESCE(MAX(realized_pnl), 0)::float AS best_trade,
         COALESCE(MIN(realized_pnl), 0)::float AS worst_trade,
         COUNT(*) FILTER (WHERE exit_reason ILIKE '%TAKE%' OR exit_reason ILIKE '%PROFIT%')::int AS take_profit_exits,
         COUNT(*) FILTER (WHERE exit_reason ILIKE '%STOP%')::int AS stop_loss_exits,
         COUNT(*) FILTER (WHERE exit_reason ILIKE '%SUPERSEDED%')::int AS superseded_exits,
         COUNT(*) FILTER (WHERE exit_reason ILIKE '%MANUAL%')::int AS manual_exits,
         COUNT(*) FILTER (WHERE profit_trim_status = 'DONE')::int AS trimmed_trades
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status = 'CLOSED'
         AND ${rangePredicate}`,
      [userId]
    );

    const { rows: symbolRows } = await fastify.pg.query(
      `SELECT symbol,
              COUNT(*)::int AS total,
              COALESCE(SUM(realized_pnl), 0)::float AS total_pnl,
              COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
              COUNT(*) FILTER (WHERE realized_pnl < 0)::int AS losses,
              COALESCE(AVG(realized_pnl), 0)::float AS average_pnl
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status = 'CLOSED'
         AND ${rangePredicate}
       GROUP BY symbol
       ORDER BY total_pnl DESC`,
      [userId]
    );

    const { rows: recentClosedRows } = await fastify.pg.query(
      `SELECT id, symbol, option_type, strike_price, expiration_date, entry_price, exit_price,
              quantity, realized_pnl, exit_reason, execution_status, profit_trim_status,
              last_broker_order_status, broker_order_id, broker_exit_order_id, notes, created_at, updated_at
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status = 'CLOSED'
         AND ${rangePredicate}
       ORDER BY updated_at DESC
       LIMIT 25`,
      [userId]
    );

    const { rows: skippedRows } = await fastify.pg.query(
      `SELECT sue.signal_id,
              sue.status,
              sue.execution_status,
              sue.execution_error,
              sue.updated_at,
              s.symbol,
              s.signal_type,
              s.trade_bias,
              s.setup_grade,
              s.no_trade_reasons
       FROM signal_user_executions sue
       LEFT JOIN signals s ON s.id = sue.signal_id
       WHERE sue.user_id = $1
         AND ${signalRangePredicate}
         AND (
           sue.status = 'SKIPPED'
           OR sue.execution_status = 'SKIPPED'
           OR sue.execution_error ILIKE 'Entry skipped:%'
           OR sue.execution_error ILIKE 'Daily trade limit reached%'
         )
       ORDER BY sue.updated_at DESC
       LIMIT 25`,
      [userId]
    );

    const summary = summaryRows[0] || {};
    const total = Number(summary.total || 0);
    const wins = Number(summary.wins || 0);
    const losses = Number(summary.losses || 0);

    return {
      range,
      generatedAt: new Date().toISOString(),
      summary: {
        total,
        totalPnl: Number(summary.total_pnl || 0),
        averagePnl: Number(summary.average_pnl || 0),
        wins,
        losses,
        winRate: total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0,
        profitFactor: Math.abs(Number(summary.average_loss || 0) * losses) > 0
          ? Number(((Number(summary.average_win || 0) * wins) / Math.abs(Number(summary.average_loss || 0) * losses)).toFixed(2))
          : null,
        bestTrade: Number(summary.best_trade || 0),
        worstTrade: Number(summary.worst_trade || 0),
        averageWin: Number(summary.average_win || 0),
        averageLoss: Number(summary.average_loss || 0),
        takeProfitExits: Number(summary.take_profit_exits || 0),
        stopLossExits: Number(summary.stop_loss_exits || 0),
        supersededExits: Number(summary.superseded_exits || 0),
        manualExits: Number(summary.manual_exits || 0),
        trimmedTrades: Number(summary.trimmed_trades || 0)
      },
      bySymbol: symbolRows.map((row: any) => ({
        symbol: row.symbol,
        total: Number(row.total || 0),
        totalPnl: Number(row.total_pnl || 0),
        wins: Number(row.wins || 0),
        losses: Number(row.losses || 0),
        winRate: Number(row.total || 0) > 0 ? Number(((Number(row.wins || 0) / Number(row.total)) * 100).toFixed(1)) : 0,
        averagePnl: Number(row.average_pnl || 0)
      })),
      recentOutcomes: recentClosedRows.map((trade: any) => ({
        ...trade,
        outcomeDriver: describeTradeOutcome(trade)
      })),
      skippedExecutions: skippedRows
    };
  });

  fastify.get('/alerts', {
    schema: {
      tags: ['Trades'],
      summary: 'Get broker and trade lifecycle alerts',
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const alerts: any[] = [];

    const { rows: staleRows } = await fastify.pg.query(
      `SELECT id, symbol, option_type, strike_price, expiration_date, status, execution_status,
              execution_error, exit_requested_at, last_broker_sync_at, last_broker_order_status, updated_at
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status IN ('OPEN', 'PENDING_ORDER')
         AND (
           (execution_status IN ('PENDING_EXIT', 'PENDING_TRIM', 'EXIT_STALE') AND COALESCE(exit_requested_at, updated_at) < now() - INTERVAL '5 minutes')
           OR (status = 'PENDING_ORDER' AND updated_at < now() - INTERVAL '10 minutes')
           OR execution_status IN ('EXIT_REJECTED', 'EXIT_FAILED')
         )
       ORDER BY updated_at DESC
       LIMIT 20`,
      [userId]
    );

    staleRows.forEach((trade: any) => {
      const isPendingEntry = trade.status === 'PENDING_ORDER';
      alerts.push({
        id: `trade-${trade.id}-${trade.execution_status || trade.status}`,
        severity: trade.execution_status === 'EXIT_REJECTED' || trade.execution_status === 'EXIT_FAILED' ? 'critical' : 'warning',
        category: isPendingEntry ? 'stale-entry' : 'stale-exit',
        title: isPendingEntry ? 'Entry order has not reconciled' : 'Exit order needs broker verification',
        message: `${trade.symbol} ${trade.option_type} ${Number(trade.strike_price)} is ${trade.execution_status || trade.status}. Check Wealthsimple status before sending another order.`,
        tradeId: Number(trade.id),
        createdAt: trade.updated_at,
        metadata: trade
      });
    });

    const { rows: skippedRows } = await fastify.pg.query(
      `SELECT sue.signal_id, sue.execution_error, sue.execution_status, sue.updated_at,
              s.symbol, s.signal_type, s.setup_grade
       FROM signal_user_executions sue
       LEFT JOIN signals s ON s.id = sue.signal_id
       WHERE sue.user_id = $1
         AND sue.updated_at >= now() - INTERVAL '24 hours'
         AND (
           sue.status = 'SKIPPED'
           OR sue.execution_status = 'SKIPPED'
           OR sue.execution_error ILIKE 'Entry skipped:%'
           OR sue.execution_error ILIKE 'Daily trade limit reached%'
         )
       ORDER BY sue.updated_at DESC
       LIMIT 20`,
      [userId]
    );

    skippedRows.forEach((row: any) => {
      alerts.push({
        id: `signal-${row.signal_id}-skipped`,
        severity: String(row.execution_error || '').includes('Daily trade limit') ? 'info' : 'warning',
        category: 'skipped-entry',
        title: 'Entry skipped',
        message: row.execution_error || `Signal #${row.signal_id} was skipped by execution safeguards.`,
        signalId: Number(row.signal_id),
        createdAt: row.updated_at,
        metadata: row
      });
    });

    const { rows: brokerRows } = await fastify.pg.query(
      `SELECT COUNT(*)::int AS open_trades,
              COUNT(*) FILTER (WHERE last_broker_sync_at IS NULL OR last_broker_sync_at < now() - INTERVAL '15 minutes')::int AS stale_syncs
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status IN ('OPEN', 'PENDING_ORDER')`,
      [userId]
    );
    const broker = brokerRows[0] || {};
    if (Number(broker.open_trades || 0) > 0 && Number(broker.stale_syncs || 0) > 0) {
      alerts.push({
        id: 'broker-stale-sync',
        severity: 'warning',
        category: 'broker-degraded',
        title: 'Broker sync freshness degraded',
        message: `${broker.stale_syncs}/${broker.open_trades} open Wealthsimple trades have stale or missing broker sync timestamps.`,
        createdAt: new Date().toISOString(),
        metadata: broker
      });
    }

    const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        total: alerts.length,
        critical: alerts.filter((alert) => alert.severity === 'critical').length,
        warning: alerts.filter((alert) => alert.severity === 'warning').length,
        info: alerts.filter((alert) => alert.severity === 'info').length
      },
      alerts
    };
  });

  fastify.get('/:id/runtime', {
    schema: {
      tags: ['Trades'],
      summary: 'Get one Redis-backed Wealthsimple trade state',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const cached = await TradeRedisService.getTradeState(id);
    if (cached?.data && Number(cached.data.user_id) === Number(userId)) return cached;

    const { rows } = await fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE id = $1
         AND user_id = $2
         AND execution_broker = 'wealthsimple_snaptrade'`,
      [id, userId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Wealthsimple trade not found' });
    await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
    return {
      generatedAt: new Date().toISOString(),
      source: 'db',
      ageMs: 0,
      data: rows[0]
    };
  });

  fastify.get('/:id/events', {
    schema: {
      tags: ['Trades'],
      summary: 'Get Wealthsimple trade event timeline',
      security: [{ bearerAuth: [] }]
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

    const { rows } = await fastify.pg.query(
      `SELECT id, user_id, signal_id, position_id, event_type, message, metadata, created_at
       FROM trade_events
       WHERE user_id = $1
         AND position_id = $2
       ORDER BY created_at ASC, id ASC`,
      [userId, id]
    );
    return rows;
  });

  fastify.get('/:id/command', {
    schema: {
      tags: ['Trades'],
      summary: 'Get Wealthsimple trade command center replay',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const { rows } = await fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE id = $1
         AND user_id = $2
         AND execution_broker = 'wealthsimple_snaptrade'`,
      [id, userId]
    );
    const trade = rows[0];
    if (!trade) return reply.code(404).send({ error: 'Wealthsimple trade not found' });

    const { rows: signalRows } = await fastify.pg.query(
      `SELECT
         s.id,
         s.symbol,
         s.signal_type,
         s.trade_bias,
         s.current_price::double precision,
         s.entry_trigger::double precision,
         s.stop_loss::double precision,
         s.target_price::double precision,
         s.confidence_score,
         s.setup_grade,
         s.indicators,
         s.gex,
         s.volatility,
         s.no_trade_reasons,
         s.option_expiration_date,
         s.market_date,
         s.option_details,
         s.created_at,
         sue.status AS user_execution_status,
         sue.execution_broker,
         sue.execution_status,
         sue.execution_error,
         sue.contracts_requested
       FROM signal_user_executions sue
       JOIN signals s ON s.id = sue.signal_id
       WHERE sue.user_id = $1
         AND (
           (sue.broker_order_id IS NOT NULL AND sue.broker_order_id = $2)
           OR (sue.broker_trade_id IS NOT NULL AND sue.broker_trade_id = $3)
         )
       ORDER BY sue.updated_at DESC
       LIMIT 1`,
      [userId, trade.broker_order_id || '', trade.broker_trade_id || '']
    );
    const signalId = signalRows[0]?.id || null;

    const eventQuery = buildCommandReplayEventsQuery(userId, id, signalId);
    const { rows: eventRows } = await fastify.pg.query(eventQuery.text, eventQuery.values);

    return {
      trade,
      signal: signalRows[0] || null,
      nextAction: getTradeNextAction(trade),
      riskPlan: getTradeRiskPlan(trade),
      brokerProof: getTradeBrokerProof(trade),
      events: eventRows,
      generatedAt: new Date().toISOString()
    };
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
          const exitAction = TradeLifecycleService.getExitAction(trade);
          const order = await snaptradeService.placeOptionOrder(
            userId,
            accountId,
            optionSymbol,
            exitAction,
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
              note: ` [Manual Wealthsimple MARKET ${exitAction} exit submitted for ${closeQuantity} contract(s)${order.orderId ? `: ${order.orderId}` : ''}]`
            }
          );

          await TradeRedisService.recordEvent(client, {
            userId,
            positionId: id,
            eventType: 'EXIT_REQUESTED',
            message: 'Manual Wealthsimple close submitted',
            metadata: { orderId: order.orderId || null, tradeId: order.tradeId || null, quantity: closeQuantity, orderType: 'MARKET', action: exitAction }
          });
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
          await TradeRedisService.requestBrokerSync(userId);
          return updatedTrade;
        } catch (err: any) {
          await TradeLifecycleService.markExitSubmissionFailure(client, id, err.message || String(err), 'Manual Wealthsimple exit failed');
          await TradeRedisService.recordEvent(client, {
            userId,
            positionId: id,
            eventType: 'EXIT_SUBMISSION_FAILED',
            message: err.message || String(err),
            metadata: { source: 'manual-close' }
          });
          await new DiscordAlertService(fastify).send({
            userId,
            title: 'Manual close failed',
            message: `Position #${id} ${trade.symbol} ${trade.option_type} ${Number(trade.strike_price)} manual close failed: ${err.message || String(err)}`,
            severity: 'critical',
            category: 'exit-failure',
            tradeId: id,
            dedupeKey: `manual-close-failed:${id}:${String(err.message || err).slice(0, 120)}`,
            dedupeSeconds: 900
          });
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
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
        404: { type: 'object', properties: { error: { type: 'string' } } },
        409: { type: 'object', properties: { error: { type: 'string' } } }
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
    let sync: any;
    try {
      sync = await snaptradeService.syncPendingBrokerOrders(userId);
    } catch (err: any) {
      if (String(err.message || '').includes('already running')) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
    const brokerStatus = Array.isArray(sync.orders)
      ? sync.orders.find((order: any) => Number(order.positionId) === Number(id))?.status
      : null;

    await TradeLifecycleService.markBrokerSynced(fastify.pg, id, brokerStatus || null);
    await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);

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
          const exitAction = TradeLifecycleService.getExitAction(trade);
          const order = await snaptradeService.placeOptionOrder(
            userId,
            accountId,
            optionSymbol,
            exitAction,
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
              note: ` [Retry Wealthsimple MARKET ${exitAction} exit submitted for ${closeQuantity} contract(s) after broker status ${brokerStatus || trade.execution_status}${order.orderId ? `: ${order.orderId}` : ''}]`
            }
          );

          await TradeRedisService.recordEvent(client, {
            userId,
            positionId: id,
            eventType: 'EXIT_RETRY_REQUESTED',
            message: 'Retry Wealthsimple close submitted',
            metadata: { orderId: order.orderId || null, tradeId: order.tradeId || null, quantity: closeQuantity, brokerStatus, action: exitAction }
          });
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
          await TradeRedisService.requestBrokerSync(userId);
          return updatedTrade;
        } catch (err: any) {
          await TradeLifecycleService.markExitSubmissionFailure(client, id, err.message || String(err), 'Retry Wealthsimple exit failed');
          await TradeRedisService.recordEvent(client, {
            userId,
            positionId: id,
            eventType: 'EXIT_RETRY_FAILED',
            message: err.message || String(err),
            metadata: { brokerStatus }
          });
          await new DiscordAlertService(fastify).send({
            userId,
            title: 'Close retry failed',
            message: `Position #${id} ${trade.symbol} ${trade.option_type} ${Number(trade.strike_price)} close retry failed after broker status ${brokerStatus || trade.execution_status || 'unknown'}: ${err.message || String(err)}`,
            severity: 'critical',
            category: 'exit-failure',
            tradeId: id,
            dedupeKey: `retry-close-failed:${id}:${String(err.message || err).slice(0, 120)}`,
            dedupeSeconds: 900
          });
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades(fastify.pg, userId, fastify);
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
