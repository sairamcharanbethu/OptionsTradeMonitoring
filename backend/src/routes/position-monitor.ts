import { FastifyInstance, FastifyPluginOptions } from 'fastify';

// The underlying take-profit target for a position is the same structure-derived
// level the market poller uses: prefer the second suggested target, fall back to
// the first. Null when the position has no derived underlying target.
function deriveUnderlyingTarget(row: any): number | null {
  const t2 = row.suggested_take_profit_2 != null ? Number(row.suggested_take_profit_2) : null;
  const t1 = row.suggested_take_profit_1 != null ? Number(row.suggested_take_profit_1) : null;
  const target = t2 ?? t1;
  return target != null && Number.isFinite(target) ? target : null;
}

function parseAnalysis(value: any): any {
  if (!value) return {};
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}

export async function positionMonitorRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET open positions with their derived underlying take-profit targets.
  // Drives the Position Monitor page; live spot updates arrive over the
  // WebSocket PRICE_UPDATE stream and POSITION_TARGET_HIT events.
  fastify.get('/', {
    schema: {
      tags: ['Position Monitor'],
      summary: 'Open positions with underlying take-profit targets',
      description: 'Returns each open position with its derived underlying take-profit target, current underlying spot, distance to target, and whether the target has already been hit.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const { rows } = await fastify.pg.query(
      `SELECT id, symbol, option_type, strike_price, expiration_date, quantity,
              entry_price, current_price, underlying_price,
              suggested_take_profit_1, suggested_take_profit_2,
              analysis_data
         FROM positions
        WHERE user_id = $1 AND status = 'OPEN'
        ORDER BY symbol ASC, expiration_date ASC`,
      [userId]
    );

    return rows.map((row: any) => {
      const target = deriveUnderlyingTarget(row);
      const underlyingPrice = row.underlying_price != null ? Number(row.underlying_price) : null;
      const op: 'ge' | 'le' = row.option_type === 'CALL' ? 'ge' : 'le';
      const alerted = parseAnalysis(row.analysis_data).positionTargetAlerted || null;

      let distancePct: number | null = null;
      if (target != null && underlyingPrice != null && underlyingPrice > 0) {
        distancePct = ((target - underlyingPrice) / underlyingPrice) * 100;
      }

      return {
        positionId: row.id,
        symbol: row.symbol,
        optionType: row.option_type,
        strike: Number(row.strike_price),
        expiration: row.expiration_date,
        quantity: Number(row.quantity || 0),
        entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
        underlyingPrice,
        target,
        op,
        distancePct,
        hit: Boolean(alerted),
        hitAt: alerted?.triggeredAt || null
      };
    });
  });
}
