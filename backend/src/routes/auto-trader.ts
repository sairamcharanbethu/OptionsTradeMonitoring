import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { AutoTraderService } from '../services/auto-trader-service';

export async function autoTraderRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.addHook('onRequest', fastify.authenticate);
    const traderService = new AutoTraderService(fastify);

    // GET /settings
    fastify.get('/settings', {
        schema: {
            tags: ['AutoTrader'],
            summary: 'Get Auto Trader Settings',
            description: 'Retrieves current mode (Paper/Simulation vs Live) and maximum contract size.',
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { id: userId } = (request as any).user;
        const { rows } = await fastify.pg.query(
            "SELECT key, value FROM settings WHERE user_id = $1 AND key IN ('auto_trader_mode', 'auto_trader_max_contracts')",
            [userId]
        );

        const settings = rows.reduce((acc: any, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});

        return {
            mode: settings.auto_trader_mode || 'simulation',
            maxContracts: parseInt(settings.auto_trader_max_contracts, 10) || 5
        };
    });

    // POST /settings
    fastify.post('/settings', {
        schema: {
            tags: ['AutoTrader'],
            summary: 'Update Auto Trader Settings',
            description: 'Updates trading mode and contract sizes with strict constraints (max contracts <= 10).',
            body: {
                type: 'object',
                required: ['mode', 'maxContracts'],
                properties: {
                    mode: { type: 'string', enum: ['simulation', 'live'] },
                    maxContracts: { type: 'integer', minimum: 1, maximum: 10 }
                }
            },
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { id: userId } = (request as any).user;
        const { mode, maxContracts } = request.body as { mode: 'simulation' | 'live'; maxContracts: number };

        await fastify.pg.query(
            `INSERT INTO settings (user_id, key, value, updated_at) 
             VALUES ($1, 'auto_trader_mode', $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
            [userId, mode]
        );

        await fastify.pg.query(
            `INSERT INTO settings (user_id, key, value, updated_at) 
             VALUES ($1, 'auto_trader_max_contracts', $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
            [userId, maxContracts.toString()]
        );

        return { success: true, mode, maxContracts };
    });

    // POST /trigger
    fastify.post('/trigger', {
        schema: {
            tags: ['AutoTrader'],
            summary: 'Trigger Option Day Trading Scan',
            description: 'Executes the market scanner immediately for the user and opens trades if setups align.',
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { id: userId } = (request as any).user;
        const result = await traderService.scanAndTrade(userId);
        return result;
    });

    // GET /status
    fastify.get('/status', {
        schema: {
            tags: ['AutoTrader'],
            summary: 'Get Auto Trader System Status',
            description: 'Retrieves current GEX exposure levels, price spot indicators, and today\'s trading activity.',
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { id: userId } = (request as any).user;

        // Fetch GEX data for SPY and QQQ
        const spyGex = await traderService.calculateGex('SPY');
        const qqqGex = await traderService.calculateGex('QQQ');

        // Fetch today's executed trades
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const { rows: trades } = await fastify.pg.query(
            `SELECT * FROM positions 
             WHERE user_id = $1 AND created_at >= $2 
             ORDER BY created_at DESC`,
            [userId, startOfDay]
        );

        // Check if market is open
        const poller = (fastify as any).poller;
        const isMarketOpen = poller ? poller.isMarketOpen() : false;

        return {
            status: isMarketOpen ? 'ACTIVE' : 'STANDBY',
            marketOpen: isMarketOpen,
            gex: {
                SPY: spyGex,
                QQQ: qqqGex
            },
            todayTradesCount: trades.length,
            trades: trades.map((t: any) => ({
                id: t.id,
                symbol: t.symbol,
                optionType: t.option_type,
                strikePrice: Number(t.strike_price),
                expirationDate: t.expiration_date,
                entryPrice: Number(t.entry_price),
                quantity: t.quantity,
                status: t.status,
                isSimulated: t.is_simulated,
                realizedPnl: t.realized_pnl ? Number(t.realized_pnl) : null,
                notes: t.notes,
                createdAt: t.created_at
            }))
        };
    });
}
