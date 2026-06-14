import { FastifyInstance } from 'fastify';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import { redis } from '../lib/redis';
import crypto from 'crypto';

export class SnaptradeService {
    private fastify: FastifyInstance;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
    }

    private async getSnaptradeClient(userId: number): Promise<{ snaptrade: Snaptrade, userIdStr: string, userSecret: string }> {
        const { rows } = await this.fastify.pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
        const settings = rows.reduce((acc: any, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});

        const clientId = settings.snaptrade_client_id?.trim();
        const consumerKey = settings.snaptrade_consumer_key?.trim();

        if (!clientId || !consumerKey) {
            throw new Error('SnapTrade Client ID or Consumer Key not configured in settings.');
        }

        const snaptrade = new Snaptrade({
            clientId,
            consumerKey
        });

        let userSecret = settings.snaptrade_user_secret;
        let snaptradeUserId = settings.snaptrade_user_id;

        if (!userSecret || !snaptradeUserId) {
            snaptradeUserId = snaptradeUserId || crypto.randomUUID();
            this.fastify.log.info(`[SnaptradeService] Registering new SnapTrade user: ${snaptradeUserId}`);
            try {
                const response = await snaptrade.authentication.registerSnapTradeUser({
                    userId: snaptradeUserId
                });
                userSecret = response.data.userSecret;

                await this.fastify.pg.query(
                    `INSERT INTO settings (user_id, key, value, updated_at) 
                     VALUES ($1, 'snaptrade_user_secret', $2, CURRENT_TIMESTAMP),
                            ($1, 'snaptrade_user_id', $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (user_id, key) DO UPDATE 
                     SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                    [userId, userSecret, snaptradeUserId]
                );
            } catch (err: any) {
                const isPersonalKeyLimit = err.responseBody?.code === '1012' || 
                                          err.responseBody?.code === 1012 || 
                                          (err.responseBody?.detail && err.responseBody.detail.includes('Personal keys can only register one user'));

                if (isPersonalKeyLimit) {
                    this.fastify.log.warn(`[SnaptradeService] Personal API key user limit reached (1012). Initiating automatic cleanup of orphaned users...`);
                    try {
                        // 1. List existing users
                        const usersRes = await snaptrade.authentication.listSnapTradeUsers();
                        this.fastify.log.info(`[SnaptradeService] Found ${usersRes.data?.length || 0} registered user(s) to clean up.`);
                        
                        // 2. Delete existing users to free up slot
                        if (usersRes.data && Array.isArray(usersRes.data)) {
                            for (const existingUser of usersRes.data) {
                                const idToDelete = typeof existingUser === 'string' ? existingUser : (existingUser.userId || existingUser.id || existingUser.user_id);
                                if (idToDelete) {
                                    this.fastify.log.info(`[SnaptradeService] Deleting orphaned user: ${idToDelete}`);
                                    await snaptrade.authentication.deleteSnapTradeUser({
                                        userId: idToDelete
                                    });
                                }
                            }
                        }

                        // 3. Retry registration
                        this.fastify.log.info(`[SnaptradeService] Retrying registration for new user: ${snaptradeUserId}`);
                        const retryRes = await snaptrade.authentication.registerSnapTradeUser({
                            userId: snaptradeUserId
                        });
                        userSecret = retryRes.data.userSecret;

                        await this.fastify.pg.query(
                            `INSERT INTO settings (user_id, key, value, updated_at) 
                             VALUES ($1, 'snaptrade_user_secret', $2, CURRENT_TIMESTAMP),
                                    ($1, 'snaptrade_user_id', $3, CURRENT_TIMESTAMP)
                             ON CONFLICT (user_id, key) DO UPDATE 
                             SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                            [userId, userSecret, snaptradeUserId]
                        );
                        this.fastify.log.info(`[SnaptradeService] Registration successful after automatic cleanup!`);
                        
                        // Successfully recovered and registered! Return early.
                        return { snaptrade, userIdStr: snaptradeUserId, userSecret };
                    } catch (cleanupErr: any) {
                        this.fastify.log.error(`[SnaptradeService] Failed during automatic user cleanup/retry: ${cleanupErr.message}`);
                        if (cleanupErr.responseBody) {
                            this.fastify.log.error(`[SnaptradeService] Cleanup API Response: ${JSON.stringify(cleanupErr.responseBody)}`);
                        }
                        throw new Error(`Failed to automatically resolve SnapTrade user limit: ${cleanupErr.responseBody?.detail || cleanupErr.message}`);
                    }
                }

                this.fastify.log.error(`[SnaptradeService] Failed to register user: ${err.message}`);
                if (err.responseBody) {
                    this.fastify.log.error(`[SnaptradeService] API Response Body: ${JSON.stringify(err.responseBody)}`);
                }
                const detail = err.responseBody?.detail || err.message;
                throw new Error(`Failed to register SnapTrade user: ${detail}`);
            }
        }

        return { snaptrade, userIdStr: snaptradeUserId, userSecret };
    }

    async generateConnectionUrl(userId: number) {
        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        try {
            const response = await snaptrade.authentication.loginSnapTradeUser({
                userId: userIdStr,
                userSecret: userSecret
            });
            return { redirectURI: response.data?.redirectURI };
        } catch (err: any) {
            this.fastify.log.error(`[SnaptradeService] Failed to generate connection URL: ${err.message}`);
            if (err.responseBody) {
                this.fastify.log.error(`[SnaptradeService] API Response Body: ${JSON.stringify(err.responseBody)}`);
            }
            const detail = err.responseBody?.detail || err.message;
            throw new Error(`Failed to generate connection URL: ${detail}`);
        }
    }

    async syncPortfolio(userId: number) {
        this.fastify.log.info(`Syncing Snaptrade portfolio for user ${userId}...`);
        
        const { snaptrade, userIdStr: snaptradeUserId, userSecret: snaptradeUserSecret } = await this.getSnaptradeClient(userId);

        try {
            // 1. Fetch Accounts
            const accountsRes = await snaptrade.accountInformation.listUserAccounts({
                userId: snaptradeUserId,
                userSecret: snaptradeUserSecret,
            });

            // 2. Filter open self-directed accounts
            const openAccounts = accountsRes.data.filter((account: any) => {
                const isStatusOpen = account.status?.toLowerCase() === "open" || account.meta?.status?.toLowerCase() === "open";
                const unifiedType = (account.meta?.unifiedAccountType || "").toLowerCase();
                const isSelfDirected = unifiedType.includes("self_directed") || unifiedType.includes("self directed");
                return isStatusOpen && isSelfDirected;
            });

            const client = await this.fastify.pg.connect();
            try {
                await client.query('BEGIN');

                // 1. Wipe previous SnapTrade sync data for this user to avoid stale/orphaned/duplicate records
                await client.query('DELETE FROM snaptrade_positions WHERE user_id = $1', [userId]);
                await client.query('DELETE FROM snaptrade_accounts WHERE user_id = $1', [userId]);

                // 2. Re-insert only the currently active accounts
                for (const account of openAccounts) {
                    const status = account.meta?.status || account.status || 'open';
                    const unifiedType = account.meta?.unifiedAccountType || '';
                    
                    await client.query(`
                        INSERT INTO snaptrade_accounts (id, user_id, name, number, status, unified_type, raw_data, last_synced_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                        ON CONFLICT (id) DO UPDATE SET
                            name = EXCLUDED.name,
                            number = EXCLUDED.number,
                            status = EXCLUDED.status,
                            unified_type = EXCLUDED.unified_type,
                            raw_data = EXCLUDED.raw_data,
                            last_synced_at = CURRENT_TIMESTAMP
                    `, [account.id, userId, account.name, account.number, status, unifiedType, account]);

                    // Fetch positions for this account
                    const positionsRes = await snaptrade.accountInformation.getUserAccountPositions({
                        userId: snaptradeUserId,
                        userSecret: snaptradeUserSecret,
                        accountId: account.id,
                    });

                    for (const pos of positionsRes.data) {
                        if (!pos.symbol || !pos.symbol.symbol) continue;
                        
                        const symbolData = pos.symbol.symbol;
                        const symbol = symbolData.symbol;
                        const description = symbolData.description;
                        const assetType = symbolData.type?.description || 'Unknown';
                        const currency = symbolData.currency?.code || 'USD';
                        const price = pos.price;
                        const units = pos.units;
                        const averagePrice = pos.average_purchase_price;
                        const openPnl = pos.open_pnl;

                        const posId = pos.symbol.id + '-' + account.id; // Unique ID

                        await client.query(`
                            INSERT INTO snaptrade_positions (id, account_id, user_id, symbol, description, asset_type, price, units, average_purchase_price, open_pnl, currency, raw_data, last_synced_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
                        `, [posId, account.id, userId, symbol, description, assetType, price, units, averagePrice, openPnl, currency, pos]);
                    }
                }

                await client.query('COMMIT');
                
                // Invalidate cache
                await redis.del(`SNAPTRADE_PORTFOLIO:${userId}`);
                
                this.fastify.log.info(`Snaptrade sync complete for user ${userId}.`);
                return { success: true, syncedAccounts: openAccounts.length };

            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }

        } catch (error: any) {
            this.fastify.log.error(`Snaptrade Sync Error: ${error.message}`);
            if (error.responseBody) {
                this.fastify.log.error(`[SnaptradeService] API Response Body: ${JSON.stringify(error.responseBody)}`);
            }
            const detail = error.responseBody?.detail || error.message;
            throw new Error(`Failed to sync SnapTrade portfolio: ${detail}`);
        }
    }

    async getPortfolio(userId: number) {
        const CACHE_KEY = `SNAPTRADE_PORTFOLIO:${userId}`;
        const cached = await redis.get(CACHE_KEY);
        if (cached) return JSON.parse(cached);

        const { rows: accounts } = await this.fastify.pg.query('SELECT * FROM snaptrade_accounts WHERE user_id = $1', [userId]);
        const { rows: positions } = await this.fastify.pg.query('SELECT * FROM snaptrade_positions WHERE user_id = $1', [userId]);

        // Enrich accounts with live cash balance
        const enrichedAccounts = await Promise.all(accounts.map(async (acc) => {
            const balance = await this.getAccountBalance(userId, acc.id);
            return {
                ...acc,
                cash_balance: balance.cash,
                cash_balance_currency: balance.currency,
                buying_power: balance.buyingPower,
                balances: balance.balances
            };
        }));

        const result = {
            accounts: enrichedAccounts,
            positions
        };

        await redis.set(CACHE_KEY, JSON.stringify(result), 300); // 5 min cache
        return result;
    }

    private pickPrimaryBalance(balances: any[]): any | null {
        if (!Array.isArray(balances) || balances.length === 0) return null;
        return (
            balances.find((balance: any) => balance?.currency?.code === 'CAD' && balance.cash !== null && balance.cash !== undefined)
            || balances.find((balance: any) => balance?.currency?.code === 'USD' && balance.cash !== null && balance.cash !== undefined)
            || balances.find((balance: any) => balance.cash !== null && balance.cash !== undefined)
            || balances[0]
        );
    }

    async getAccountBalance(userId: number, accountId: string): Promise<{ cash: number | null; currency: string | null; buyingPower: number | null; balances: any[] }> {
        try {
            const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
            const balanceRes = await snaptrade.accountInformation.getUserAccountBalance({
                userId: userIdStr,
                userSecret: userSecret,
                accountId: accountId
            });

            const balances = Array.isArray(balanceRes.data) ? balanceRes.data : [];
            const primaryBalance = this.pickPrimaryBalance(balances);
            if (primaryBalance) {
                return {
                    cash: primaryBalance.cash ?? null,
                    currency: primaryBalance.currency?.code || null,
                    buyingPower: primaryBalance.buying_power ?? null,
                    balances
                };
            }

            return { cash: null, currency: null, buyingPower: null, balances };
        } catch (err: any) {
            this.fastify.log.error(`[SnaptradeService] Failed to fetch account balance: ${err.message}`);
            return { cash: null, currency: null, buyingPower: null, balances: [] };
        }
    }

    private extractRecentOrders(payload: any): any[] {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.orders)) return payload.orders;
        return [];
    }

    private collectOrderIds(order: any): string[] {
        return [
            order?.id,
            order?.order_id,
            order?.orderId,
            order?.brokerage_order_id,
            order?.brokerageOrderId,
            order?.brokerage_order_id?.id,
            order?.brokerage_group_order_id,
            order?.brokerageGroupOrderId,
            order?.trade_id,
            order?.tradeId
        ]
            .filter((value) => value !== null && value !== undefined)
            .map((value) => String(value));
    }

    private findMatchingOrder(orders: any[], position: any) {
        const expectedIds = [
            position.broker_order_id,
            position.broker_trade_id
        ].filter(Boolean).map((value) => String(value));

        if (expectedIds.length === 0) return null;

        return orders.find((order) => {
            const orderIds = this.collectOrderIds(order);
            return expectedIds.some((id) => orderIds.includes(id));
        }) || null;
    }

    private normalizeOrderStatus(status: any): string {
        return String(status || 'UNKNOWN').trim().toUpperCase();
    }

    private getOrderFillPrice(order: any, fallback: number): number {
        const candidates = [
            order?.execution_price,
            order?.average_fill_price,
            order?.filled_avg_price,
            order?.avg_fill_price,
            order?.price,
            order?.limit_price
        ];
        for (const candidate of candidates) {
            const value = Number(candidate);
            if (Number.isFinite(value) && value > 0) return value;
        }
        return fallback;
    }

    async syncPendingBrokerOrders(userId: number) {
        const pendingRes = await this.fastify.pg.query(
            `SELECT *
             FROM positions
             WHERE user_id = $1
               AND execution_broker = 'wealthsimple_snaptrade'
               AND status = 'PENDING_ORDER'
             ORDER BY created_at DESC`,
            [userId]
        );

        const pendingPositions = pendingRes.rows || [];
        const summary = {
            success: true,
            checked: pendingPositions.length,
            opened: 0,
            closed: 0,
            stillPending: 0,
            unmatched: 0,
            errors: [] as string[],
            orders: [] as Array<{ positionId: number; status: string; action: string; brokerOrderId: string | null; brokerTradeId: string | null; fillPrice?: number }>
        };

        if (pendingPositions.length === 0) return summary;

        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        const ordersByAccount = new Map<string, any[]>();

        const getOrdersForAccount = async (accountId: string) => {
            if (ordersByAccount.has(accountId)) return ordersByAccount.get(accountId) || [];
            const response = await snaptrade.accountInformation.getUserAccountRecentOrders({
                userId: userIdStr,
                userSecret,
                accountId,
                onlyExecuted: false
            });
            const orders = this.extractRecentOrders(response.data);
            ordersByAccount.set(accountId, orders);
            return orders;
        };

        const openStatuses = new Set(['EXECUTED', 'PARTIAL', 'PARTIALLY_EXECUTED']);
        const closedStatuses = new Set(['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'PARTIAL_CANCELED', 'EXPIRED']);
        const pendingStatuses = new Set([
            'PENDING',
            'ACCEPTED',
            'QUEUED',
            'TRIGGERED',
            'ACTIVATED',
            'PENDING_RISK_REVIEW',
            'CONTINGENT_ORDER',
            'CANCEL_PENDING',
            'REPLACE_PENDING',
            'REPLACED',
            'STOPPED',
            'SUSPENDED',
            'NONE',
            'UNKNOWN'
        ]);

        for (const position of pendingPositions) {
            const accountId = String(position.execution_account_id || position.account_id || '').trim();
            if (!accountId) {
                summary.unmatched += 1;
                summary.errors.push(`Position ${position.id} has no SnapTrade account id.`);
                summary.orders.push({
                    positionId: position.id,
                    status: 'UNKNOWN',
                    action: 'unmatched',
                    brokerOrderId: position.broker_order_id,
                    brokerTradeId: position.broker_trade_id
                });
                continue;
            }

            try {
                const orders = await getOrdersForAccount(accountId);
                const order = this.findMatchingOrder(orders, position);

                if (!order) {
                    summary.unmatched += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status: 'UNKNOWN',
                        action: 'unmatched',
                        brokerOrderId: position.broker_order_id,
                        brokerTradeId: position.broker_trade_id
                    });
                    continue;
                }

                const status = this.normalizeOrderStatus(order.status);
                if (openStatuses.has(status)) {
                    const fillPrice = this.getOrderFillPrice(order, Number(position.entry_price || position.current_price || 0.01));
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET status = 'OPEN',
                             execution_status = $1,
                             entry_price = $2,
                             current_price = $2,
                             trailing_high_price = GREATEST(COALESCE(trailing_high_price, 0), $2),
                             notes = COALESCE(notes, '') || ' [SnapTrade fill confirmed: ' || $1 || ']',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $3`,
                        [status, fillPrice, position.id]
                    );
                    summary.opened += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status,
                        action: 'opened',
                        brokerOrderId: position.broker_order_id,
                        brokerTradeId: position.broker_trade_id,
                        fillPrice
                    });
                } else if (closedStatuses.has(status)) {
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET status = 'CLOSED',
                             execution_status = $1,
                             execution_error = COALESCE($2, execution_error),
                             notes = COALESCE(notes, '') || ' [SnapTrade order ' || $1 || ']',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $3`,
                        [status, order?.rejection_reason || order?.reason || null, position.id]
                    );
                    summary.closed += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status,
                        action: 'closed',
                        brokerOrderId: position.broker_order_id,
                        brokerTradeId: position.broker_trade_id
                    });
                } else {
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET execution_status = $1,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $2`,
                        [pendingStatuses.has(status) ? status : 'PENDING', position.id]
                    );
                    summary.stillPending += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status,
                        action: 'pending',
                        brokerOrderId: position.broker_order_id,
                        brokerTradeId: position.broker_trade_id
                    });
                }
            } catch (err: any) {
                summary.unmatched += 1;
                summary.errors.push(`Position ${position.id}: ${err.message}`);
                this.fastify.log.warn(`[SnaptradeService] Failed to sync pending order ${position.id}: ${err.message}`);
            }
        }

        if (summary.opened > 0 || summary.closed > 0 || summary.stillPending > 0) {
            await redis.del(`USER_POSITIONS:${userId}`);
            await redis.del(`USER_STATS:${userId}`);
            await redis.del(`SNAPTRADE_PORTFOLIO:${userId}`);

            const streamers = [
                (this.fastify as any).alpacaMarketDataStreamer,
                (this.fastify as any).streamer
            ];
            for (const streamer of streamers) {
                if (streamer?.syncSubscriptions) {
                    streamer.syncSubscriptions().catch((err: any) => {
                        this.fastify.log.warn(`[SnaptradeService] Failed to refresh stream subscriptions after pending sync: ${err.message}`);
                    });
                }
            }
        }

        return summary;
    }

    async placeOptionOrder(
        userId: number,
        accountId: string,
        optionSymbol: string, // OCC format: e.g. "AAPL 250718C00150000"
        action: 'BUY_TO_OPEN' | 'SELL_TO_CLOSE' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN',
        units: number,
        orderType: 'LIMIT' | 'MARKET' = 'MARKET',
        limitPrice?: string
    ) {
        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);

        this.fastify.log.info(`[SnaptradeService] Placing option order: ${action} ${units} contracts of ${optionSymbol} on account ${accountId} (Mode: ${orderType})`);

        try {
            const orderPayload: any = {
                userId: userIdStr,
                userSecret: userSecret,
                accountId: accountId,
                order_type: orderType,
                time_in_force: 'Day',
                legs: [
                    {
                        instrument: {
                            symbol: optionSymbol,
                            instrument_type: 'OPTION'
                        },
                        action: action,
                        units: units
                    }
                ]
            };

            if (orderType === 'LIMIT') {
                if (!limitPrice) {
                    throw new Error('Limit price is required for LIMIT orders.');
                }
                orderPayload.limit_price = limitPrice;
                orderPayload.price_effect = action.startsWith('BUY') ? 'DEBIT' : 'CREDIT';
            }

            // 1. Get Order Impact
            this.fastify.log.info(`[SnaptradeService] Getting order impact for ${optionSymbol}...`);
            const impactRes = await snaptrade.trading.getOrderImpact(orderPayload);
            
            const tradeId = impactRes.data?.id || (impactRes.data as any)?.tradeId;
            if (!tradeId) {
                throw new Error(`Failed to obtain tradeId from order impact: ${JSON.stringify(impactRes.data)}`);
            }

            // 2. Place Order
            this.fastify.log.info(`[SnaptradeService] Executing order for tradeId: ${tradeId}...`);
            const placeRes = await snaptrade.trading.placeOrder({
                userId: userIdStr,
                userSecret: userSecret,
                tradeId: tradeId
            });

            this.fastify.log.info(`[SnaptradeService] Order executed successfully: ${JSON.stringify(placeRes.data)}`);
            return {
                success: true,
                tradeId,
                orderId: placeRes.data?.id || (placeRes.data as any)?.orderId || tradeId,
                rawResponse: placeRes.data
            };
        } catch (err: any) {
            this.fastify.log.error(`[SnaptradeService] Option order execution failed: ${err.message}`);
            if (err.responseBody) {
                this.fastify.log.error(`[SnaptradeService] API response body: ${JSON.stringify(err.responseBody)}`);
            }
            const detail = err.responseBody?.detail || err.message;
            throw new Error(`Failed to place options trade via SnapTrade: ${detail}`);
        }
    }
}
