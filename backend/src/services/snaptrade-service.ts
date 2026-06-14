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
                userSecret: userSecret,
                connectionType: 'trade',
                connectionPortalVersion: 'v4'
            });
            return { redirectURI: response.data?.redirectURI, connectionType: 'trade' };
        } catch (err: any) {
            this.fastify.log.error(`[SnaptradeService] Failed to generate connection URL: ${err.message}`);
            if (err.responseBody) {
                this.fastify.log.error(`[SnaptradeService] API Response Body: ${JSON.stringify(err.responseBody)}`);
            }
            const detail = err.responseBody?.detail || err.message;
            throw new Error(`Failed to generate connection URL: ${detail}`);
        }
    }

    private normalizeAuthorization(auth: any) {
        const brokerage = auth?.brokerage || {};
        return {
            id: auth?.id || '',
            name: auth?.name || brokerage?.display_name || brokerage?.name || 'Brokerage connection',
            type: auth?.type || 'unknown',
            disabled: Boolean(auth?.disabled),
            brokerageSlug: brokerage?.slug || brokerage?.slug_id || brokerage?.id || '',
            brokerageName: brokerage?.display_name || brokerage?.name || '',
            allowsTrading: brokerage?.allows_trading ?? null
        };
    }

    private isWealthsimpleAuthorization(auth: any) {
        const normalized = this.normalizeAuthorization(auth);
        const haystack = `${normalized.brokerageSlug} ${normalized.brokerageName} ${normalized.name}`.toLowerCase();
        return haystack.includes('wealthsimple');
    }

    async getConnectionStatus(userId: number) {
        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        const authRes = await snaptrade.connections.listBrokerageAuthorizations({
            userId: userIdStr,
            userSecret
        });

        const authorizations = Array.isArray(authRes.data) ? authRes.data.map((auth: any) => this.normalizeAuthorization(auth)) : [];
        const selectedAccountRes = await this.fastify.pg.query(
            `SELECT s.value AS selected_account_id, a.raw_data
             FROM settings s
             LEFT JOIN snaptrade_accounts a ON a.id = s.value AND a.user_id = s.user_id
             WHERE s.user_id = $1 AND s.key = 'snaptrade_trading_account_id'
             LIMIT 1`,
            [userId]
        );
        const selectedAccountId = selectedAccountRes.rows[0]?.selected_account_id || '';
        const selectedAuthorizationId = selectedAccountRes.rows[0]?.raw_data?.brokerage_authorization || '';
        const selectedAuthorization = authorizations.find((auth: any) => auth.id === selectedAuthorizationId) || null;
        const wealthsimpleConnections = authorizations.filter((auth: any) => {
            const haystack = `${auth.brokerageSlug} ${auth.brokerageName} ${auth.name}`.toLowerCase();
            return haystack.includes('wealthsimple') || (selectedAuthorizationId && auth.id === selectedAuthorizationId);
        });

        return {
            success: true,
            selectedAccountId,
            selectedAuthorizationId,
            selectedAuthorization,
            connections: authorizations,
            wealthsimpleConnections,
            hasTradeConnection: wealthsimpleConnections.some((auth: any) => auth.type === 'trade' && !auth.disabled),
            hasReadOnlyConnection: wealthsimpleConnections.some((auth: any) => auth.type !== 'trade')
        };
    }

    async resetReadOnlyWealthsimpleConnections(userId: number) {
        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        const status = await this.getConnectionStatus(userId);
        const removeCandidates = status.connections.filter((auth: any) => {
            const isSelected = status.selectedAuthorizationId && auth.id === status.selectedAuthorizationId;
            const haystack = `${auth.brokerageSlug} ${auth.brokerageName} ${auth.name}`.toLowerCase();
            const isWealthsimple = haystack.includes('wealthsimple');
            return auth.id && auth.type !== 'trade' && (isSelected || isWealthsimple);
        });

        for (const auth of removeCandidates) {
            await snaptrade.connections.removeBrokerageAuthorization({
                authorizationId: auth.id,
                userId: userIdStr,
                userSecret
            });
        }

        if (removeCandidates.length > 0) {
            await this.fastify.pg.query(
                `UPDATE settings
                 SET value = '', updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND key = 'snaptrade_trading_account_id'`,
                [userId]
            );
            await this.fastify.pg.query('DELETE FROM snaptrade_positions WHERE user_id = $1', [userId]);
            await this.fastify.pg.query('DELETE FROM snaptrade_accounts WHERE user_id = $1', [userId]);
            await redis.del(`SNAPTRADE_PORTFOLIO:${userId}`);
            await redis.del(`USER_POSITIONS:${userId}`);
            await redis.del(`USER_STATS:${userId}`);
        }

        return {
            success: true,
            removedCount: removeCandidates.length,
            removedConnections: removeCandidates,
            message: removeCandidates.length
                ? 'Removed read-only Wealthsimple connection. Reconnect Wealthsimple trading, then sync accounts.'
                : 'No read-only Wealthsimple connection found to remove.'
        };
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

    async syncAllPendingBrokerOrders() {
        const { rows } = await this.fastify.pg.query(
            `SELECT DISTINCT user_id
             FROM positions
             WHERE execution_broker = 'wealthsimple_snaptrade'
               AND status = 'PENDING_ORDER'`
        );

        const summary = {
            success: true,
            usersChecked: rows.length,
            checked: 0,
            opened: 0,
            closed: 0,
            stillPending: 0,
            unmatched: 0,
            errors: [] as string[]
        };

        for (const row of rows) {
            try {
                const result = await this.syncPendingBrokerOrders(Number(row.user_id));
                summary.checked += result.checked;
                summary.opened += result.opened;
                summary.closed += result.closed;
                summary.stillPending += result.stillPending;
                summary.unmatched += result.unmatched;
                summary.errors.push(...result.errors);
            } catch (err: any) {
                const message = `User ${row.user_id}: ${err.message}`;
                summary.errors.push(message);
                this.fastify.log.warn(`[SnaptradeService] Pending order background sync failed: ${message}`);
            }
        }

        return summary;
    }

    async placeTrackedTestOptionOrder(userId: number, input: {
        symbol: string;
        optionType: 'CALL' | 'PUT';
        strike: number;
        expiration: string;
        quantity: number;
        orderType: 'LIMIT' | 'MARKET';
        limitPrice?: number;
        mark?: number;
    }) {
        const { rows } = await this.fastify.pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
        const settings = rows.reduce((acc: any, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});

        if (settings.live_trading_acknowledged !== 'true') {
            throw new Error('Wealthsimple live trading acknowledgement is required before placing a test order.');
        }

        const accountId = String(settings.snaptrade_trading_account_id || '').trim();
        if (!accountId) {
            throw new Error('No Wealthsimple/SnapTrade trading account selected in settings.');
        }

        const quantity = Math.max(1, Math.min(Number(input.quantity || 1), 10));
        const orderType = input.orderType === 'MARKET' ? 'MARKET' : 'LIMIT';
        const limitPrice = input.limitPrice !== undefined ? Number(input.limitPrice) : undefined;
        if (orderType === 'LIMIT' && (!Number.isFinite(limitPrice) || Number(limitPrice) <= 0)) {
            throw new Error('A positive limit price is required for LIMIT test orders.');
        }

        const optionSymbol = this.constructOSITicker(input.symbol, input.strike, input.optionType, input.expiration);
        const entryPrice = Math.max(Number(input.mark || limitPrice || 1), 0.01);
        const premiumStopLoss = Number((entryPrice * 0.8).toFixed(2));
        const premiumTakeProfit = Number((entryPrice * 1.4).toFixed(2));

        const order = await this.placeOptionOrder(
            userId,
            accountId,
            optionSymbol,
            'BUY_TO_OPEN',
            quantity,
            orderType,
            limitPrice !== undefined ? limitPrice.toFixed(2) : undefined
        );

        const insertRes = await this.fastify.pg.query(
            `INSERT INTO positions (
                user_id, symbol, option_type, strike_price, expiration_date,
                entry_price, quantity, stop_loss_trigger, take_profit_trigger,
                trailing_high_price, trailing_stop_loss_pct, current_price,
                status, is_simulated, account_id, notes, execution_broker,
                broker_order_id, broker_trade_id, execution_account_id, execution_status, contracts_requested,
                suggested_stop_loss, suggested_take_profit_1,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                'PENDING_ORDER', FALSE, $13, $14, 'wealthsimple_snaptrade',
                $15, $16, $13, 'PENDING', $7,
                $17, $18,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            RETURNING id, status, execution_status, broker_order_id, broker_trade_id`,
            [
                userId,
                input.symbol.toUpperCase(),
                input.optionType,
                input.strike,
                input.expiration,
                entryPrice,
                quantity,
                premiumStopLoss,
                premiumTakeProfit,
                entryPrice,
                null,
                entryPrice,
                accountId,
                `[Dev SnapTrade live option test ${order.orderId || order.tradeId || 'submitted'}] [Auto exits: premium SL $${premiumStopLoss}, premium TP $${premiumTakeProfit}]`,
                order.orderId || null,
                order.tradeId || null,
                premiumStopLoss,
                premiumTakeProfit
            ]
        );

        await redis.del(`USER_POSITIONS:${userId}`);
        await redis.del(`USER_STATS:${userId}`);

        return {
            success: true,
            optionSymbol,
            accountId,
            orderType,
            limitPrice: limitPrice ?? null,
            quantity,
            orderId: order.orderId,
            tradeId: order.tradeId,
            position: insertRes.rows[0],
            rawResponse: order.rawResponse
        };
    }

    async placeOptionOrder(
        userId: number,
        accountId: string,
        optionSymbol: string,
        action: 'BUY_TO_OPEN' | 'SELL_TO_CLOSE' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN',
        units: number,
        orderType: 'LIMIT' | 'MARKET' = 'MARKET',
        limitPrice?: string
    ) {
        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        const snaptradeOptionSymbol = this.toSnaptradeOccSymbol(optionSymbol);
        const priceEffect = action.startsWith('BUY') ? 'DEBIT' : 'CREDIT';

        this.fastify.log.info(`[SnaptradeService] Placing option order: ${action} ${units} contracts of ${snaptradeOptionSymbol} on account ${accountId} (Mode: ${orderType})`);

        try {
            const orderPayload: any = {
                userId: userIdStr,
                userSecret: userSecret,
                accountId: accountId,
                order_type: orderType,
                time_in_force: 'Day',
                limit_price: orderType === 'LIMIT' ? limitPrice : '',
                stop_price: '',
                price_effect: priceEffect,
                legs: [
                    {
                        instrument: {
                            symbol: snaptradeOptionSymbol,
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
            }

            let impactData: any = null;
            let impactWarning: string | null = null;
            try {
                this.fastify.log.info(`[SnaptradeService] Getting option impact for ${snaptradeOptionSymbol}...`);
                const impactRes = await snaptrade.trading.getOptionImpact(orderPayload);
                impactData = impactRes.data;
            } catch (impactErr: any) {
                const detail = impactErr.responseBody?.detail || impactErr.message || '';
                const unsupportedImpact = /impact is not supported|not supported for this brokerage/i.test(detail);
                if (!unsupportedImpact) {
                    throw impactErr;
                }
                impactWarning = detail;
                this.fastify.log.warn(`[SnaptradeService] Option impact preview skipped for ${snaptradeOptionSymbol}: ${detail}`);
            }

            this.fastify.log.info(`[SnaptradeService] Placing multi-leg option order for ${snaptradeOptionSymbol}...`);
            const placeRes = await snaptrade.trading.placeMlegOrder(orderPayload);
            const brokerageOrderId = placeRes.data?.brokerage_order_id
                || placeRes.data?.orders?.[0]?.brokerage_order_id
                || (placeRes.data as any)?.id
                || null;

            this.fastify.log.info(`[SnaptradeService] Order executed successfully: ${JSON.stringify(placeRes.data)}`);
            return {
                success: true,
                tradeId: null,
                orderId: brokerageOrderId,
                rawResponse: {
                    impact: impactData,
                    impactWarning,
                    order: placeRes.data
                }
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

    private toSnaptradeOccSymbol(optionSymbol: string): string {
        const compact = String(optionSymbol || '').replace(/\s+/g, '').toUpperCase();
        const match = compact.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!match) return optionSymbol;
        const [, root, expiry, side, strike] = match;
        return `${root.padEnd(6, ' ')}${expiry}${side}${strike}`;
    }

    private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
        const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : expiration.split('T')[0];
        const [year, month, day] = dateStr.split('-');
        const yy = year.slice(-2);
        const side = type === 'CALL' ? 'C' : 'P';
        const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
        return `${symbol.toUpperCase()}${yy}${month}${day}${side}${strikeValue}`;
    }
}
