import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { AutoTraderService } from '../services/auto-trader-service';
import { OptionsBacktester } from '../services/options-backtester';

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
            "SELECT key, value FROM settings WHERE user_id = $1 AND key IN ('auto_trader_mode', 'auto_trader_max_contracts', 'auto_trader_symbols')",
            [userId]
        );

        const settings = rows.reduce((acc: any, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});

        return {
            mode: settings.auto_trader_mode || 'simulation',
            maxContracts: parseInt(settings.auto_trader_max_contracts, 10) || 5,
            symbols: settings.auto_trader_symbols || 'both'
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
                    maxContracts: { type: 'integer', minimum: 1, maximum: 10 },
                    symbols: { type: 'string', enum: ['SPY', 'QQQ', 'both'] }
                }
            },
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { id: userId } = (request as any).user;
        const { mode, maxContracts, symbols } = request.body as { mode: 'simulation' | 'live'; maxContracts: number; symbols?: string };

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

        if (symbols) {
            await fastify.pg.query(
                `INSERT INTO settings (user_id, key, value, updated_at) 
                 VALUES ($1, 'auto_trader_symbols', $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                [userId, symbols]
            );
        }

        return { success: true, mode, maxContracts, symbols: symbols || 'both' };
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

    // POST /backtest
    fastify.post('/backtest', {
        schema: {
            tags: ['AutoTrader'],
            summary: 'Run Options Trading Strategy Backtest',
            description: 'Executes backtest over historical candles using analytical Black-Scholes premium simulation.',
            body: {
                type: 'object',
                required: ['symbol', 'startDate', 'endDate', 'mode', 'contractSize'],
                properties: {
                    symbol: { type: 'string', enum: ['SPY', 'QQQ', 'spy', 'qqq'] },
                    startDate: { type: 'string', format: 'date' },
                    endDate: { type: 'string', format: 'date' },
                    mode: { type: 'string', enum: ['rule-based', 'ai'] },
                    contractSize: { type: 'integer', minimum: 1, maximum: 10 }
                }
            },
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { symbol, startDate, endDate, mode, contractSize } = request.body as {
            symbol: string;
            startDate: string;
            endDate: string;
            mode: 'rule-based' | 'ai';
            contractSize: number;
        };

        try {
            const backtester = new OptionsBacktester(fastify);
            const results = await backtester.runBacktest(
                symbol.toUpperCase(),
                startDate,
                endDate,
                mode,
                contractSize
            );
            return results;
        } catch (error: any) {
            fastify.log.error(`[AutoTrader Route] Backtest execution error: ${error.message}`);
            reply.code(400).send({ error: error.message || 'Backtest execution failed.' });
        }
    });

    // GET /health
    fastify.get('/health', {
        schema: {
            tags: ['AutoTrader'],
            summary: 'Get Auto Trader Health Status',
            description: 'Runs real-time latency and connectivity tests for Database, Redis, Questrade, and SnapTrade.',
            security: [{ bearerAuth: [] }]
        }
    }, async (request, reply) => {
        const { id: userId } = (request as any).user;
        const results: any = {};
        let systemStatus = 'HEALTHY';

        // 1. Database Check
        try {
            const dbStart = Date.now();
            await fastify.pg.query("SELECT 1");
            results.database = {
                status: 'HEALTHY',
                latencyMs: Date.now() - dbStart
            };
        } catch (err: any) {
            systemStatus = 'UNHEALTHY';
            results.database = {
                status: 'UNHEALTHY',
                error: err.message
            };
        }

        // 2. Redis Check
        try {
            const redisStart = Date.now();
            const { redis: redisClient } = require('../lib/redis');
            const isConnected = redisClient.isConnected;
            await redisClient.get('healthcheck_test');
            results.redis = {
                status: isConnected ? 'HEALTHY' : 'UNHEALTHY',
                latencyMs: Date.now() - redisStart
            };
            if (!isConnected && systemStatus === 'HEALTHY') {
                systemStatus = 'DEGRADED';
            }
        } catch (err: any) {
            if (systemStatus === 'HEALTHY') systemStatus = 'DEGRADED';
            results.redis = {
                status: 'UNHEALTHY',
                error: err.message
            };
        }

        // 3. Questrade Check
        const qtService = (fastify as any).questrade;
        if (qtService) {
            try {
                const isLinked = await qtService.isLinked();
                if (isLinked) {
                    const qtStart = Date.now();
                    const token = await qtService.getActiveToken();
                    if (token) {
                        const symbols = await qtService.getSymbols(['SPY']);
                        results.questrade = {
                            status: 'HEALTHY',
                            latencyMs: Date.now() - qtStart,
                            details: {
                                isLinked: true,
                                apiServer: token.api_server,
                                testQuote: symbols.length > 0 ? `SPY resolved to symbol ID ${symbols[0].symbolId}` : 'No symbols returned'
                            }
                        };
                    } else {
                        if (systemStatus === 'HEALTHY') systemStatus = 'DEGRADED';
                        results.questrade = {
                            status: 'UNHEALTHY',
                            details: { isLinked: true, error: 'Failed to retrieve active token' }
                        };
                    }
                } else {
                    results.questrade = {
                        status: 'UNCONFIGURED',
                        details: { isLinked: false, message: 'Questrade is not linked yet.' }
                    };
                }
            } catch (err: any) {
                if (systemStatus === 'HEALTHY') systemStatus = 'DEGRADED';
                results.questrade = {
                    status: 'UNHEALTHY',
                    details: { isLinked: true, error: err.message }
                };
            }
        } else {
            results.questrade = {
                status: 'UNAVAILABLE',
                error: 'Questrade service instance not decorated on Fastify.'
            };
        }

        // 4. SnapTrade Check
        try {
            const { SnaptradeService } = require('../services/snaptrade-service');
            const snaptradeService = new SnaptradeService(fastify);
            const stStart = Date.now();
            
            const { rows } = await fastify.pg.query(
                "SELECT key, value FROM settings WHERE user_id = $1 AND key IN ('snaptrade_client_id', 'snaptrade_consumer_key')", 
                [userId]
            );
            const settings = rows.reduce((acc: any, row: any) => {
                acc[row.key] = row.value;
                return acc;
            }, {});
            
            const hasCreds = settings.snaptrade_client_id?.trim() && settings.snaptrade_consumer_key?.trim();
            
            if (hasCreds) {
                const { snaptrade, userIdStr, userSecret } = await (snaptradeService as any).getSnaptradeClient(userId);
                const accountsRes = await snaptrade.accountInformation.listUserAccounts({
                    userId: userIdStr,
                    userSecret: userSecret,
                });
                results.snaptrade = {
                    status: 'HEALTHY',
                    latencyMs: Date.now() - stStart,
                    details: {
                        isConfigured: true,
                        accountsCount: accountsRes.data?.length || 0
                    }
                };
            } else {
                results.snaptrade = {
                    status: 'UNCONFIGURED',
                    details: { isConfigured: false, message: 'SnapTrade credentials not configured in settings.' }
                };
            }
        } catch (err: any) {
            if (systemStatus === 'HEALTHY') systemStatus = 'DEGRADED';
            results.snaptrade = {
                status: 'UNHEALTHY',
                details: { isConfigured: true, error: err.message }
            };
        }

        return {
            success: true,
            status: systemStatus,
            timestamp: new Date().toISOString(),
            services: results
        };
    });
}

