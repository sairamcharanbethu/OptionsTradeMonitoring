import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SHARED_PAPER_ACCOUNT_ID } from '../services/paper-account-constants';

type Scope = 'paper' | 'live';

// Closed-position filter for each scope. Live is the user's real (non-simulated)
// broker positions; paper is the shared paper account.
function scopeClause(scope: Scope): { where: string; params: (string | number)[] } {
  if (scope === 'paper') {
    return { where: `paper_account_id = $1 AND status = 'CLOSED'`, params: [SHARED_PAPER_ACCOUNT_ID] };
  }
  return {
    where: `user_id = $1 AND COALESCE(is_simulated, false) = false AND COALESCE(execution_broker,'') <> 'system_paper' AND status = 'CLOSED'`,
    params: []
  };
}

export async function metricsRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET performance metrics that change behavior: overall expectancy, win-rate by
  // time-of-day and by symbol, and realized entry slippage vs mid/limit (paper).
  // Read-only: computed from existing positions + paper_orders. No writes.
  fastify.get('/performance', {
    schema: {
      tags: ['Metrics'],
      summary: 'Trading performance metrics',
      description: 'Overall expectancy, win-rate by ET hour and by symbol, and realized entry slippage. scope=paper|live, days=lookback window.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['paper', 'live'], default: 'live' },
          days: { type: 'integer', minimum: 1, maximum: 365, default: 30 }
        }
      }
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const { scope = 'live', days = 30 } = request.query as { scope?: Scope; days?: number };
    const { where, params } = scopeClause(scope);
    const scopeParams = scope === 'paper' ? params : [userId];
    // $-index of the next positional parameter after the scope params. Window on
    // updated_at (the close time for CLOSED positions) so trades that closed inside
    // the window are counted regardless of when they were entered.
    const windowIdx = scopeParams.length + 1;
    const windowClause = `AND updated_at >= (NOW() - ($${windowIdx} || ' days')::interval)`;
    const baseParams = [...scopeParams, String(days)];

    const overallQ = fastify.pg.query(
      `SELECT
         COUNT(*)::int AS trades,
         COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
         COUNT(*) FILTER (WHERE realized_pnl < 0)::int AS losses,
         COALESCE(SUM(realized_pnl), 0)::float8 AS total_pnl,
         COALESCE(AVG(realized_pnl) FILTER (WHERE realized_pnl > 0), 0)::float8 AS avg_win,
         COALESCE(AVG(realized_pnl) FILTER (WHERE realized_pnl < 0), 0)::float8 AS avg_loss,
         COALESCE(SUM(realized_pnl) FILTER (WHERE realized_pnl > 0), 0)::float8 AS gross_win,
         COALESCE(SUM(realized_pnl) FILTER (WHERE realized_pnl < 0), 0)::float8 AS gross_loss
       FROM positions
       WHERE ${where} ${windowClause}`,
      baseParams
    );

    const byHourQ = fastify.pg.query(
      `SELECT
         EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/New_York'))::int AS hour_et,
         COUNT(*)::int AS trades,
         COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
         COALESCE(SUM(realized_pnl), 0)::float8 AS total_pnl,
         COALESCE(AVG(realized_pnl), 0)::float8 AS avg_pnl
       FROM positions
       WHERE ${where} ${windowClause}
       GROUP BY hour_et
       ORDER BY hour_et ASC`,
      baseParams
    );

    const bySymbolQ = fastify.pg.query(
      `SELECT
         symbol,
         option_type,
         COUNT(*)::int AS trades,
         COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
         COALESCE(SUM(realized_pnl), 0)::float8 AS total_pnl,
         COALESCE(AVG(realized_pnl), 0)::float8 AS avg_pnl
       FROM positions
       WHERE ${where} ${windowClause}
       GROUP BY symbol, option_type
       ORDER BY total_pnl ASC`,
      baseParams
    );

    // Entry slippage vs mid and vs limit (paper only — live has no paper_orders).
    const slippageQ = scope === 'paper'
      ? fastify.pg.query(
          `SELECT
             COUNT(*) FILTER (WHERE fill_price IS NOT NULL)::int AS fills,
             COALESCE(AVG(fill_price - NULLIF((quote_snapshot->>'mid'), '')::float8)
               FILTER (WHERE fill_price IS NOT NULL AND (quote_snapshot->>'mid') IS NOT NULL), 0)::float8 AS avg_vs_mid,
             COALESCE(AVG(fill_price - limit_price)
               FILTER (WHERE fill_price IS NOT NULL AND limit_price IS NOT NULL), 0)::float8 AS avg_vs_limit
           FROM paper_orders
           WHERE account_id = $1 AND intent = 'ENTRY' AND status = 'FILLED'
             AND created_at >= (NOW() - ($2 || ' days')::interval)`,
          [SHARED_PAPER_ACCOUNT_ID, String(days)]
        )
      : null;

    const [overall, byHour, bySymbol, slippage] = await Promise.all([
      overallQ, byHourQ, bySymbolQ, slippageQ
    ]);

    const o = overall.rows[0] || {};
    const trades = Number(o.trades || 0);
    const wins = Number(o.wins || 0);
    const losses = Number(o.losses || 0);
    const avgWin = Number(o.avg_win || 0);
    const avgLoss = Number(o.avg_loss || 0); // negative
    const grossWin = Number(o.gross_win || 0);
    const grossLoss = Math.abs(Number(o.gross_loss || 0));
    const winRate = trades > 0 ? wins / trades : 0;
    const lossRate = trades > 0 ? losses / trades : 0;
    // Expectancy per trade in dollars.
    const expectancy = winRate * avgWin + lossRate * avgLoss;

    return {
      scope,
      days,
      overall: {
        trades,
        wins,
        losses,
        winRate,
        avgWin,
        avgLoss,
        totalPnl: Number(o.total_pnl || 0),
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        expectancy
      },
      byHour: byHour.rows.map((r: any) => ({
        hourEt: Number(r.hour_et),
        trades: Number(r.trades),
        wins: Number(r.wins),
        winRate: Number(r.trades) > 0 ? Number(r.wins) / Number(r.trades) : 0,
        totalPnl: Number(r.total_pnl),
        avgPnl: Number(r.avg_pnl)
      })),
      bySymbol: bySymbol.rows.map((r: any) => ({
        symbol: r.symbol,
        optionType: r.option_type,
        trades: Number(r.trades),
        wins: Number(r.wins),
        winRate: Number(r.trades) > 0 ? Number(r.wins) / Number(r.trades) : 0,
        totalPnl: Number(r.total_pnl),
        avgPnl: Number(r.avg_pnl)
      })),
      slippage: slippage
        ? {
            fills: Number(slippage.rows[0]?.fills || 0),
            avgVsMid: Number(slippage.rows[0]?.avg_vs_mid || 0),
            avgVsLimit: Number(slippage.rows[0]?.avg_vs_limit || 0)
          }
        : null
    };
  });
}
