import { FastifyInstance } from 'fastify';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import { redis } from '../lib/redis';
import crypto from 'crypto';
import { TradeRedisService } from './trade-redis-service';
import { DiscordAlertService } from './discord-alert-service';
import { TradeLifecycleService } from './trade-lifecycle-service';
import { MarketDataWriteBufferService } from './market-data-write-buffer-service';
import { roundProtectiveStop } from './stop-loss-engine';
import { getSettingsWithGlobalFallback, invalidateSettingsCache } from '../lib/settings-utils';

const SNAPTRADE_API_TIMEOUT_MS = Number(process.env.SNAPTRADE_API_TIMEOUT_MS || 15000);
const SNAPTRADE_ORDER_RATE_LIMIT_COOLDOWN_SECONDS = Math.min(
    300,
    Math.max(15, Number(process.env.SNAPTRADE_ORDER_RATE_LIMIT_COOLDOWN_SECONDS || 60))
);

export class SnapTradeRateLimitError extends Error {
    readonly code = 'SNAPTRADE_RATE_LIMITED';
    readonly statusCode = 429;
    readonly retryAfterSeconds: number;

    constructor(message: string, retryAfterSeconds = SNAPTRADE_ORDER_RATE_LIMIT_COOLDOWN_SECONDS) {
        super(message);
        this.name = 'SnapTradeRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export class SnapTradeOrderSubmissionError extends Error {
    readonly code = 'SNAPTRADE_ORDER_SUBMISSION_FAILED';

    constructor(message: string, readonly ambiguous: boolean) {
        super(message);
        this.name = 'SnapTradeOrderSubmissionError';
    }
}

export function isAmbiguousSnapTradeOrderError(error: unknown): boolean {
    return error instanceof SnapTradeOrderSubmissionError && error.ambiguous;
}

export class SnaptradeService {
    private fastify: FastifyInstance;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
    }

    private toLocalAccountId(userId: number, snaptradeAccountId: string): string {
        return `${userId}:${snaptradeAccountId}`;
    }

    private toSnaptradeAccountId(accountId: string): string {
        const parts = String(accountId || '').split(':');
        return parts.length > 1 ? parts.slice(1).join(':') : accountId;
    }

    private async getSnaptradeClient(userId: number): Promise<{ snaptrade: Snaptrade, userIdStr: string, userSecret: string }> {
        const settings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);

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
                await invalidateSettingsCache(userId, ['snaptrade_user_secret', 'snaptrade_user_id']);
            } catch (err: any) {
                const isPersonalKeyLimit = err.responseBody?.code === '1012' || 
                                          err.responseBody?.code === 1012 || 
                                          (err.responseBody?.detail && err.responseBody.detail.includes('Personal keys can only register one user'));

                if (isPersonalKeyLimit) {
                    throw new Error('This SnapTrade personal key already has a registered user. Use unique SnapTrade credentials for this app user, or reset that SnapTrade user in the SnapTrade dashboard before reconnecting.');
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

    private snaptradeRequestOptions(timeoutMs = SNAPTRADE_API_TIMEOUT_MS) {
        return { timeout: timeoutMs };
    }

    private orderRateLimitKey(userId: number) {
        return `snaptrade:order-rate-limit:user:${userId}`;
    }

    private isRateLimitError(err: any) {
        const status = Number(err?.statusCode || err?.status || err?.response?.status || err?.responseBody?.status);
        const detail = String(err?.responseBody?.detail || err?.message || '').toLowerCase();
        return status === 429 || detail.includes('429') || detail.includes('rate limit');
    }

    private isAmbiguousOrderSubmissionError(err: any): boolean {
        if (String(err?.message || '').includes('Limit price is required')) return false;
        const status = Number(err?.statusCode || err?.status || err?.response?.status || err?.responseBody?.status);
        const code = String(err?.code || '').toUpperCase();
        if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)) return true;
        return !Number.isFinite(status) || status <= 0 || status === 408 || status >= 500;
    }

    private rateLimitMessage(isOpeningOrder: boolean, retryAfterSeconds = SNAPTRADE_ORDER_RATE_LIMIT_COOLDOWN_SECONDS) {
        const retryGuidance = isOpeningOrder
            ? `then wait ${retryAfterSeconds} seconds before submitting this entry again`
            : 'before retrying this exit';
        return `SnapTrade rate limit reached; no accepted order was returned. Check Wealthsimple for an existing order ${retryGuidance}.`;
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
             LEFT JOIN snaptrade_accounts a
               ON a.user_id = s.user_id
              AND (a.id = s.value OR a.id = CONCAT(s.user_id::text, ':', s.value))
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
                const { rows: selectedRows } = await client.query(
                    "SELECT value FROM settings WHERE user_id = $1 AND key = 'snaptrade_trading_account_id' LIMIT 1",
                    [userId]
                );
                const selectedAccountId = String(selectedRows[0]?.value || '');

                // 2. Re-insert only the currently active accounts
                for (const account of openAccounts) {
                    const localAccountId = this.toLocalAccountId(userId, account.id);
                    const status = account.meta?.status || account.status || 'open';
                    const unifiedType = account.meta?.unifiedAccountType || '';
                    
                    await client.query(`
                        INSERT INTO snaptrade_accounts (id, user_id, name, number, status, unified_type, raw_data, last_synced_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                        ON CONFLICT (id) DO UPDATE SET
                            user_id = EXCLUDED.user_id,
                            name = EXCLUDED.name,
                            number = EXCLUDED.number,
                            status = EXCLUDED.status,
                            unified_type = EXCLUDED.unified_type,
                            raw_data = EXCLUDED.raw_data,
                            last_synced_at = CURRENT_TIMESTAMP
                    `, [localAccountId, userId, account.name, account.number, status, unifiedType, account]);

                    if (selectedAccountId === account.id) {
                        await client.query(
                            `UPDATE settings
                             SET value = $1, updated_at = CURRENT_TIMESTAMP
                             WHERE user_id = $2 AND key = 'snaptrade_trading_account_id'`,
                            [localAccountId, userId]
                        );
                    }

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

                        const posId = `${userId}:${pos.symbol.id}-${account.id}`; // Unique per app user/account

                        await client.query(`
                            INSERT INTO snaptrade_positions (id, account_id, user_id, symbol, description, asset_type, price, units, average_purchase_price, open_pnl, currency, raw_data, last_synced_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
                        `, [posId, localAccountId, userId, symbol, description, assetType, price, units, averagePrice, openPnl, currency, pos]);
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
            const snaptradeAccountId = this.toSnaptradeAccountId(accountId);
            const balanceRes = await snaptrade.accountInformation.getUserAccountBalance({
                userId: userIdStr,
                userSecret: userSecret,
                accountId: snaptradeAccountId
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
        const ids = new Set<string>();
        this.collectOrderIdsRecursive(order, ids);
        return [...ids];
    }

    private collectOrderIdsRecursive(value: any, ids: Set<string>, depth = 0) {
        if (value === null || value === undefined || depth > 8) return;

        if (typeof value === 'string' || typeof value === 'number') {
            const text = String(value).trim();
            if (text) ids.add(text);
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                this.collectOrderIdsRecursive(item, ids, depth + 1);
            }
            return;
        }

        if (typeof value !== 'object') return;

        for (const [key, child] of Object.entries(value)) {
            const lowerKey = key.toLowerCase();
            if (
                child !== null
                && child !== undefined
                && (lowerKey.includes('id') || lowerKey.includes('order') || lowerKey.includes('trade'))
            ) {
                this.collectOrderIdsRecursive(child, ids, depth + 1);
            }
        }
    }

    private findMatchingOrder(orders: any[], position: any, phase: 'ENTRY' | 'EXIT' = 'ENTRY') {
        const expectedIds = phase === 'EXIT'
            ? [
                position.broker_exit_order_id,
                position.broker_exit_trade_id
            ].filter(Boolean).map((value) => String(value))
            : [
                position.broker_order_id,
                position.broker_trade_id
            ].filter(Boolean).map((value) => String(value));

        if (expectedIds.length > 0) {
            return orders.find((order) => {
                const orderIds = this.collectOrderIds(order);
                return expectedIds.some((id) => orderIds.includes(id));
            }) || null;
        }

        const expectedTicker = this.canonicalOccTicker(this.constructOSITicker(
            position.symbol,
            Number(position.strike_price),
            position.option_type,
            position.expiration_date
        ));
        const expectedAction = this.normalizeOrderAction(
            phase === 'EXIT' ? TradeLifecycleService.getExitAction(position) : position.entry_action || 'BUY_TO_OPEN'
        );
        const expectedQuantity = Math.max(1, Number(
            phase === 'EXIT' ? position.profit_trim_quantity || position.quantity : position.contracts_requested || position.quantity
        ));
        const requestedAt = new Date(
            phase === 'EXIT' ? position.exit_requested_at || position.updated_at : position.created_at || position.updated_at
        ).getTime();
        if (!expectedTicker || !Number.isFinite(requestedAt)) return null;

        const candidates = orders.filter((order) => {
            const ticker = this.canonicalOccTicker(order?.option_symbol?.ticker || '');
            const action = this.normalizeOrderAction(order?.action);
            const quantity = Number(order?.total_quantity || 0);
            const placedAt = new Date(order?.time_placed || '').getTime();
            return ticker === expectedTicker
                && action === expectedAction
                && Number.isFinite(quantity)
                && Math.abs(quantity - expectedQuantity) < 0.0001
                && Number.isFinite(placedAt)
                && placedAt >= requestedAt - 30_000
                && placedAt <= requestedAt + 5 * 60_000;
        });
        return candidates.length === 1 ? candidates[0] : null;
    }

    private canonicalOccTicker(value: any): string {
        return String(value || '').replace(/\s+/g, '').toUpperCase();
    }

    private normalizeOrderAction(value: any): string {
        return String(value || '').trim().toUpperCase().replace(/_TO_/g, '_');
    }

    private getBrokerageOrderId(order: any): string | null {
        const value = order?.brokerage_order_id || order?.id || null;
        return value ? String(value) : null;
    }

    async getRecentOrderStatusById(userId: number, orderId: string) {
        const requestedOrderId = String(orderId || '').trim();
        if (!requestedOrderId) throw new Error('orderId is required.');

        const { rows: localRows } = await this.fastify.pg.query(
            `SELECT id, symbol, option_type, strike_price, expiration_date, status, execution_status,
                    broker_order_id, broker_trade_id, broker_exit_order_id, broker_exit_trade_id,
                    account_id, execution_account_id, last_broker_order_status, last_broker_sync_at
             FROM positions
             WHERE user_id = $1
               AND execution_broker = 'wealthsimple_snaptrade'
               AND (
                 broker_order_id = $2
                 OR broker_trade_id = $2
                 OR broker_exit_order_id = $2
                 OR broker_exit_trade_id = $2
               )
             ORDER BY updated_at DESC
             LIMIT 1`,
            [userId, requestedOrderId]
        );
        const localPosition = localRows[0] || null;

        const accountIds = new Set<string>();
        if (localPosition?.execution_account_id || localPosition?.account_id) {
            accountIds.add(String(localPosition.execution_account_id || localPosition.account_id));
        }

        const { rows: selectedRows } = await this.fastify.pg.query(
            `SELECT value FROM settings
             WHERE user_id = $1
               AND key = 'snaptrade_trading_account_id'
               AND value IS NOT NULL
               AND value != ''`,
            [userId]
        );
        for (const row of selectedRows) accountIds.add(String(row.value));

        const { rows: accountRows } = await this.fastify.pg.query(
            'SELECT id FROM snaptrade_accounts WHERE user_id = $1',
            [userId]
        );
        for (const row of accountRows) accountIds.add(String(row.id));

        if (accountIds.size === 0) {
            return {
                found: false,
                orderId: requestedOrderId,
                status: localPosition?.last_broker_order_status || 'UNKNOWN',
                localPosition,
                reason: 'No SnapTrade accounts are synced for this user.'
            };
        }

        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        for (const accountId of accountIds) {
            const snaptradeAccountId = this.toSnaptradeAccountId(accountId);
            const response = await snaptrade.accountInformation.getUserAccountRecentOrders({
                userId: userIdStr,
                userSecret,
                accountId: snaptradeAccountId,
                onlyExecuted: false
            }, this.snaptradeRequestOptions());
            const orders = this.extractRecentOrders(response.data);
            const order = orders.find((candidate) => this.collectOrderIds(candidate).includes(requestedOrderId));
            if (!order) continue;

            const rawStatus = this.normalizeOrderStatus(order.status);
            const terminalStatuses = ['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'PARTIAL_CANCELED', 'EXPIRED'];
            const partialStatuses = ['PARTIAL', 'PARTIALLY_EXECUTED', 'PARTIALLY_FILLED'];
            const pendingStatuses = ['PENDING', 'ACCEPTED', 'QUEUED', 'TRIGGERED', 'ACTIVATED', 'PENDING_RISK_REVIEW', 'CONTINGENT_ORDER', 'CANCEL_PENDING', 'REPLACE_PENDING', 'REPLACED', 'STOPPED', 'SUSPENDED', 'NONE', 'UNKNOWN'];
            const status = this.hasFillEvidence(order) && !terminalStatuses.includes(rawStatus) && !partialStatuses.includes(rawStatus)
                ? 'FILLED'
                : rawStatus;
            let repairedLocalPosition = localPosition;
            const matchedEntryOrder = localPosition
                && [localPosition.broker_order_id, localPosition.broker_trade_id].filter(Boolean).map((value) => String(value)).includes(requestedOrderId);
            if (matchedEntryOrder && localPosition.status === 'CLOSED' && pendingStatuses.includes(status)) {
                const { rows: repairedRows } = await this.fastify.pg.query(
                    `UPDATE positions
                     SET status = 'PENDING_ORDER',
                         execution_status = $1,
                         execution_error = NULL,
                         last_broker_order_status = $1,
                         last_broker_sync_at = CURRENT_TIMESTAMP,
                         notes = COALESCE(notes, '') || $2,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3
                       AND user_id = $4
                       AND status = 'CLOSED'
                     RETURNING id, symbol, option_type, strike_price, expiration_date, status, execution_status,
                               broker_order_id, broker_trade_id, broker_exit_order_id, broker_exit_trade_id,
                               account_id, execution_account_id, last_broker_order_status, last_broker_sync_at`,
                    [
                        status,
                        ` [SnapTrade order status repair: broker order ${requestedOrderId} is ${status} with no fill evidence; restored to pending.]`,
                        localPosition.id,
                        userId
                    ]
                );
                repairedLocalPosition = repairedRows[0] || localPosition;
            }
            return {
                found: true,
                orderId: requestedOrderId,
                accountId,
                status,
                fillPrice: this.getOrderFillPrice(order, 0) || null,
                filledQuantity: this.getFilledQuantity(order) || null,
                localPosition: repairedLocalPosition,
                repairedLocalStatus: repairedLocalPosition !== localPosition,
                rawOrder: order
            };
        }

        return {
            found: false,
            orderId: requestedOrderId,
            status: localPosition?.last_broker_order_status || 'UNKNOWN',
            localPosition,
            reason: 'Order was not found in recent SnapTrade orders.'
        };
    }

    private normalizeOrderStatus(status: any): string {
        return String(status || 'UNKNOWN').trim().toUpperCase();
    }

    private hasFillEvidence(order: any): boolean {
        const filledQuantity = this.getActualFilledQuantity(order);
        const executionMarkers = [
            order?.time_executed,
            order?.executed_at,
            order?.filled_at,
            order?.last_fill_at
        ];
        const fillPrices = [
            order?.execution_price,
            order?.average_fill_price,
            order?.filled_avg_price,
            order?.avg_fill_price
        ];

        return filledQuantity > 0
            || executionMarkers.some((value) => Boolean(value))
            || fillPrices.some((value) => Number(value) > 0)
            || (Array.isArray(order?.orders) && order.orders.some((childOrder: any) => this.hasFillEvidence(childOrder)));
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
        if (Array.isArray(order?.orders)) {
            for (const childOrder of order.orders) {
                const childPrice = this.getOrderFillPrice(childOrder, 0);
                if (childPrice > 0) return childPrice;
            }
        }
        return fallback;
    }

    private getFilledQuantity(order: any): number {
        const candidates = [
            order?.filled_quantity,
            order?.filledQuantity,
            order?.total_quantity,
            order?.totalQuantity,
            order?.units
        ];
        for (const candidate of candidates) {
            const value = Number(candidate);
            if (Number.isFinite(value) && value > 0) return value;
        }
        if (Array.isArray(order?.orders)) {
            for (const childOrder of order.orders) {
                const childQuantity = this.getActualFilledQuantity(childOrder);
                if (childQuantity > 0) return childQuantity;
            }
        }
        return 0;
    }

    private getActualFilledQuantity(order: any): number {
        const candidates = [
            order?.filled_quantity,
            order?.filledQuantity,
            order?.filled,
            order?.quantity_filled,
            order?.filled_units
        ];
        for (const candidate of candidates) {
            const value = Number(candidate);
            if (Number.isFinite(value) && value > 0) return value;
        }
        return 0;
    }

    private async getTakeProfitPct(userId: number): Promise<number | null> {
        const { rows } = await this.fastify.pg.query(
            "SELECT value FROM settings WHERE user_id = $1 AND key = 'take_profit_pct' LIMIT 1",
            [userId]
        );
        const raw = String(rows[0]?.value || '').trim();
        if (!raw) return null;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return Math.min(parsed, 500);
    }

    async syncPendingBrokerOrders(userId: number) {
        const brokerSyncLock = await TradeRedisService.acquireLock(TradeRedisService.keys.brokerSyncLock(userId), 20);
        if (!brokerSyncLock.acquired) {
            throw new Error('Broker order reconciliation is already running for this user.');
        }

        try {
        const pendingRes = await this.fastify.pg.query(
            `SELECT *
             FROM positions
             WHERE user_id = $1
               AND execution_broker = 'wealthsimple_snaptrade'
               AND (
                 status = 'PENDING_ORDER'
                 OR (status = 'OPEN' AND execution_status = 'PARTIALLY_FILLED')
                 OR (status = 'OPEN' AND execution_status = 'PENDING_EXIT')
                 OR (status = 'OPEN' AND execution_status = 'PENDING_TRIM')
                 OR (status = 'OPEN' AND execution_status LIKE 'EXIT_%')
               )
             ORDER BY created_at DESC`,
            [userId]
        );

        const pendingPositions = pendingRes.rows || [];
        const summary = {
            success: true,
            checked: pendingPositions.length,
            opened: 0,
            closed: 0,
            trimmed: 0,
            stillPending: 0,
            unmatched: 0,
            errors: [] as string[],
            orders: [] as Array<{ positionId: number; status: string; action: string; brokerOrderId: string | null; brokerTradeId: string | null; fillPrice?: number }>
        };

        if (pendingPositions.length === 0) {
            await TradeRedisService.rebuildOpenTrades(this.fastify.pg, userId, this.fastify);
            return summary;
        }

        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        const takeProfitPct = await this.getTakeProfitPct(userId);
        const ordersByAccount = new Map<string, any[]>();

        const getOrdersForAccount = async (accountId: string) => {
            if (ordersByAccount.has(accountId)) return ordersByAccount.get(accountId) || [];
            const snaptradeAccountId = this.toSnaptradeAccountId(accountId);
            const response = await snaptrade.accountInformation.getUserAccountRecentOrders({
                userId: userIdStr,
                userSecret,
                accountId: snaptradeAccountId,
                onlyExecuted: false
            }, this.snaptradeRequestOptions());
            const orders = this.extractRecentOrders(response.data);
            ordersByAccount.set(accountId, orders);
            return orders;
        };

        const openStatuses = new Set(['EXECUTED', 'FILLED', 'FILLED_FULLY', 'COMPLETE', 'COMPLETED', 'PARTIAL', 'PARTIALLY_EXECUTED', 'PARTIALLY_FILLED']);
        const partialStatuses = new Set(['PARTIAL', 'PARTIALLY_EXECUTED', 'PARTIALLY_FILLED']);
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
            const executionStatus = String(position.execution_status || '');
            const phase: 'ENTRY' | 'EXIT' = ['PENDING_EXIT', 'PENDING_TRIM'].includes(executionStatus) || executionStatus.startsWith('EXIT_')
                ? 'EXIT'
                : 'ENTRY';
            const accountId = String(position.execution_account_id || position.account_id || '').trim();
            if (!accountId) {
                summary.unmatched += 1;
                summary.errors.push(`Position ${position.id} has no SnapTrade account id.`);
                summary.orders.push({
                    positionId: position.id,
                    status: 'UNKNOWN',
                    action: 'unmatched',
                    brokerOrderId: phase === 'EXIT' ? position.broker_exit_order_id : position.broker_order_id,
                    brokerTradeId: phase === 'EXIT' ? position.broker_exit_trade_id : position.broker_trade_id
                });
                continue;
            }

            try {
                const orders = await getOrdersForAccount(accountId);
                const order = this.findMatchingOrder(orders, position, phase);

                if (!order) {
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET last_broker_sync_at = CURRENT_TIMESTAMP,
                             last_broker_order_status = 'UNKNOWN',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1`,
                        [position.id]
                    );
                    summary.unmatched += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status: 'UNKNOWN',
                        action: 'unmatched',
                        brokerOrderId: phase === 'EXIT' ? position.broker_exit_order_id : position.broker_order_id,
                        brokerTradeId: phase === 'EXIT' ? position.broker_exit_trade_id : position.broker_trade_id
                    });
                    continue;
                }

                const inferredOrderId = this.getBrokerageOrderId(order);
                const missingLocalOrderId = phase === 'EXIT'
                    ? !position.broker_exit_order_id && !position.broker_exit_trade_id
                    : !position.broker_order_id && !position.broker_trade_id;
                if (missingLocalOrderId && inferredOrderId) {
                    const orderColumn = phase === 'EXIT' ? 'broker_exit_order_id' : 'broker_order_id';
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET ${orderColumn} = $1,
                             notes = COALESCE(notes, '') || $2,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $3`,
                        [inferredOrderId, ` [SnapTrade order linked by exact contract/action/quantity/time reconciliation: ${inferredOrderId}]`, position.id]
                    );
                    if (phase === 'EXIT') position.broker_exit_order_id = inferredOrderId;
                    else {
                        position.broker_order_id = inferredOrderId;
                        if (position.signal_id) {
                            await this.fastify.pg.query(
                                `UPDATE signal_user_executions
                                 SET broker_order_id = $1,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE signal_id = $2 AND user_id = $3`,
                                [inferredOrderId, position.signal_id, userId]
                            );
                        }
                    }
                    await TradeRedisService.recordEvent(this.fastify.pg, {
                        userId,
                        positionId: position.id,
                        eventType: phase === 'EXIT' ? 'EXIT_ORDER_RECONCILED' : 'ENTRY_ORDER_RECONCILED',
                        message: `SnapTrade ${phase.toLowerCase()} order linked after an ambiguous submission response`,
                        metadata: { brokerOrderId: inferredOrderId }
                    });
                }

                const rawStatus = this.normalizeOrderStatus(order.status);
                const status = this.hasFillEvidence(order) && !closedStatuses.has(rawStatus) && !partialStatuses.has(rawStatus)
                    ? 'FILLED'
                    : rawStatus;
                await this.fastify.pg.query(
                    `UPDATE positions
                     SET last_broker_sync_at = CURRENT_TIMESTAMP,
                         last_broker_order_status = $1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [status, position.id]
                );
                const actualFilledQuantity = this.getActualFilledQuantity(order);
                if (phase === 'ENTRY' && partialStatuses.has(status)) {
                    const requestedQuantity = Math.max(1, Number(position.contracts_requested || position.quantity || 1));
                    const filledQuantity = Math.min(Math.floor(actualFilledQuantity), requestedQuantity);
                    const fillPrice = this.getOrderFillPrice(order, Number(position.entry_price || position.current_price || 0.01));
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET status = 'PENDING_ORDER',
                             execution_status = 'PARTIALLY_FILLED',
                             quantity = CASE WHEN $1 > 0 THEN $1 ELSE quantity END,
                             entry_price = CASE WHEN $1 > 0 THEN $2 ELSE entry_price END,
                             current_price = CASE WHEN $1 > 0 THEN $2 ELSE current_price END,
                             execution_error = 'Entry is partially filled; wait for completion or cancel the remainder at Wealthsimple before managing an exit.',
                             notes = COALESCE(notes, '') || $3,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $4`,
                        [filledQuantity, fillPrice, ` [SnapTrade partial entry: ${filledQuantity}/${requestedQuantity} filled; remainder still working]`, position.id]
                    );
                    await this.syncSignalExecutionFromOrder(position, 'EXECUTED', 'PARTIALLY_FILLED');
                    summary.stillPending += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status: 'PARTIALLY_FILLED',
                        action: 'partially_filled',
                        brokerOrderId: position.broker_order_id,
                        brokerTradeId: position.broker_trade_id,
                        fillPrice
                    });
                    if (String(position.execution_status) !== 'PARTIALLY_FILLED' || Number(position.quantity || 0) !== filledQuantity) {
                        await TradeRedisService.recordEvent(this.fastify.pg, {
                            userId,
                            positionId: position.id,
                            eventType: 'ENTRY_PARTIALLY_FILLED',
                            message: `SnapTrade entry partially filled ${filledQuantity}/${requestedQuantity}`,
                            metadata: { status, filledQuantity, requestedQuantity, fillPrice }
                        });
                    }
                    continue;
                }

                if (phase === 'EXIT' && partialStatuses.has(status)) {
                    const requestedQuantity = Math.max(1, Number(position.profit_trim_quantity || position.quantity || 1));
                    const filledQuantity = Math.min(Math.floor(actualFilledQuantity), requestedQuantity);
                    const isTrim = requestedQuantity < Number(position.quantity || 1)
                        || executionStatus === 'PENDING_TRIM'
                        || String(position.exit_reason || '').includes('TRIM');
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET execution_status = $1,
                             execution_error = $2,
                             notes = COALESCE(notes, '') || $3,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $4`,
                        [isTrim ? 'PENDING_TRIM' : 'PENDING_EXIT',
                            `Exit is partially filled (${filledQuantity}/${requestedQuantity}); the broker remainder is still working.`,
                            ` [SnapTrade partial exit: ${filledQuantity}/${requestedQuantity} filled; remainder still working]`, position.id]
                    );
                    summary.stillPending += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status: 'PARTIALLY_FILLED',
                        action: 'exit_partially_filled',
                        brokerOrderId: position.broker_exit_order_id,
                        brokerTradeId: position.broker_exit_trade_id,
                        fillPrice: this.getOrderFillPrice(order, Number(position.current_price || position.entry_price || 0.01))
                    });
                    continue;
                }

                const terminalExitWithFill = phase === 'EXIT' && closedStatuses.has(status) && actualFilledQuantity > 0;
                if (terminalExitWithFill) {
                    const terminalReviewStatus = ['CANCELED', 'CANCELLED', 'PARTIAL_CANCELED'].includes(status)
                        ? 'EXIT_CANCELED'
                        : `EXIT_${status}`;
                    const currentQuantity = Math.max(1, Number(position.quantity || 1));
                    const filledQuantity = Math.min(Math.floor(actualFilledQuantity), currentQuantity);
                    const isTrim = Number(position.profit_trim_quantity || currentQuantity) < currentQuantity
                        || executionStatus === 'PENDING_TRIM'
                        || String(position.exit_reason || '').includes('TRIM');
                    const fillPrice = this.getOrderFillPrice(order, Number(position.current_price || position.entry_price || 0.01));
                    if (executionStatus === terminalReviewStatus && String(position.last_broker_order_status || '') === status) {
                        summary.stillPending += 1;
                        summary.orders.push({
                            positionId: position.id,
                            status: terminalReviewStatus,
                            action: 'exit_partial_review',
                            brokerOrderId: position.broker_exit_order_id,
                            brokerTradeId: position.broker_exit_trade_id,
                            fillPrice
                        });
                        continue;
                    }
                    const realizedPnl = TradeLifecycleService.calculateRealizedPnl(position, fillPrice, filledQuantity);
                    const remainingQuantity = currentQuantity - filledQuantity;
                    if (remainingQuantity > 0) {
                        await this.fastify.pg.query(
                            `UPDATE positions
                             SET quantity = $1,
                                 execution_status = $2,
                                 current_price = $3,
                                 realized_pnl = COALESCE(realized_pnl, 0) + $4,
                                 execution_error = $5,
                                 profit_trim_status = CASE WHEN $6::boolean THEN 'DONE' ELSE profit_trim_status END,
                                 profit_trim_quantity = CASE WHEN $6::boolean THEN $7 ELSE profit_trim_quantity END,
                                 profit_trim_price = CASE WHEN $6::boolean THEN $3 ELSE profit_trim_price END,
                                 profit_trimmed_at = CASE WHEN $6::boolean THEN CURRENT_TIMESTAMP ELSE profit_trimmed_at END,
                                 notes = COALESCE(notes, '') || $8,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $9`,
                            [remainingQuantity, terminalReviewStatus, fillPrice, realizedPnl,
                                `Broker exit ended after a partial fill; ${remainingQuantity} contract(s) remain and require reconciliation.`,
                                isTrim, filledQuantity,
                                ` [SnapTrade terminal partial exit: sold ${filledQuantity}/${currentQuantity} @ $${fillPrice}; ${remainingQuantity} remain]`, position.id]
                        );
                        summary.trimmed += 1;
                        summary.stillPending += 1;
                        summary.orders.push({
                            positionId: position.id,
                            status: terminalReviewStatus,
                            action: 'exit_partial_review',
                            brokerOrderId: position.broker_exit_order_id,
                            brokerTradeId: position.broker_exit_trade_id,
                            fillPrice
                        });
                        await TradeRedisService.recordEvent(this.fastify.pg, {
                            userId,
                            positionId: position.id,
                            eventType: 'EXIT_PARTIAL_REVIEW',
                            message: `SnapTrade exit ended after filling ${filledQuantity}/${currentQuantity}; ${remainingQuantity} remain`,
                            metadata: { status, filledQuantity, remainingQuantity, fillPrice }
                        });
                        continue;
                    }
                }

                const terminalEntryWithFill = phase === 'ENTRY' && closedStatuses.has(status) && actualFilledQuantity > 0;
                if (openStatuses.has(status) || terminalEntryWithFill || terminalExitWithFill) {
                    const fillPrice = this.getOrderFillPrice(order, Number(position.entry_price || position.current_price || 0.01));
                    let orderAction = phase === 'EXIT' ? 'closed' : 'opened';
                    if (phase === 'EXIT') {
                        const requestedQty = Number(position.profit_trim_quantity || position.quantity || 1);
                        const currentQty = Number(position.quantity || 1);
                        const isTrim = requestedQty < currentQty
                            || executionStatus === 'PENDING_TRIM'
                            || String(position.exit_reason || '').includes('TRIM');
                        const filledQty = Math.min(this.getFilledQuantity(order) || requestedQty, currentQty);
                        const realizedPnl = TradeLifecycleService.calculateRealizedPnl(position, fillPrice, filledQty);
                        if (isTrim && filledQty < currentQty) {
                            const isManualTrim = String(position.exit_reason || '').startsWith('MANUAL_TRIM');
                            const trimLabel = isManualTrim ? 'manual trim' : 'profit trim';
                            const completedTrimAnalysis = this.markSyntheticTrimComplete(position.analysis_data);
                            await this.fastify.pg.query(
                                `UPDATE positions
                                 SET quantity = quantity - $1,
                                     execution_status = $2,
                                     current_price = $3,
                                     realized_pnl = COALESCE(realized_pnl, 0) + $4,
                                     execution_error = NULL,
                                     broker_exit_order_id = NULL,
                                     broker_exit_trade_id = NULL,
                                     profit_trim_status = 'DONE',
                                     profit_trim_quantity = $1,
                                     profit_trim_price = $3,
                                     profit_trimmed_at = CURRENT_TIMESTAMP,
                                     stop_loss_trigger = GREATEST(COALESCE(stop_loss_trigger, 0), entry_price),
                                     take_profit_trigger = NULL,
                                     analysis_data = COALESCE($6::jsonb, analysis_data),
                                     notes = COALESCE(notes, '') || $5,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE id = $7`,
                                [filledQty, status, fillPrice, realizedPnl, ` [SnapTrade ${trimLabel} fill confirmed: sold ${filledQty}/${currentQty} @ $${fillPrice}]`,
                                    completedTrimAnalysis, position.id]
                            );
                            if (completedTrimAnalysis) {
                                await redis.hset(`${MarketDataWriteBufferService.currentPrefix}:${position.id}`, {
                                    analysisData: completedTrimAnalysis,
                                    updatedAt: new Date().toISOString()
                                });
                            }
                            summary.trimmed += 1;
                            orderAction = 'trimmed';
                            await TradeRedisService.recordEvent(this.fastify.pg, {
                                userId,
                                positionId: position.id,
                                eventType: isManualTrim ? 'MANUAL_ENTRY_TRIM_CONFIRMED' : 'PROFIT_TRIM_CONFIRMED',
                                message: `SnapTrade ${trimLabel} fill confirmed at $${fillPrice}`,
                                metadata: { status, filledQty, currentQty, fillPrice }
                            });
                        } else {
                            await this.fastify.pg.query(
                                `UPDATE positions
                                 SET status = 'CLOSED',
                                     execution_status = $1,
                                     current_price = $2,
                                     exit_price = $2,
                                     realized_pnl = COALESCE(realized_pnl, 0) + $3,
                                     execution_error = NULL,
                                     exit_reason = COALESCE(exit_reason, 'BROKER_CONFIRMED'),
                                     notes = COALESCE(notes, '') || $4,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE id = $5`,
                                [status, fillPrice, realizedPnl, ` [SnapTrade exit fill confirmed: ${status}]`, position.id]
                            );
                            summary.closed += 1;
                            await TradeRedisService.recordEvent(this.fastify.pg, {
                                userId,
                                positionId: position.id,
                                eventType: 'POSITION_CLOSED',
                                message: `SnapTrade exit fill confirmed: ${status}`,
                                metadata: { status, fillPrice, filledQty }
                            });
                        }
                    } else {
                        const requestedQuantity = Math.max(1, Number(position.contracts_requested || position.quantity || 1));
                        const filledQuantity = Math.min(
                            Math.floor(actualFilledQuantity || requestedQuantity),
                            requestedQuantity
                        );
                        const finalEntryStatus = terminalEntryWithFill ? `${status}_WITH_FILL` : status;
                        const manualEntry = this.getManualEntryConfig(position);
                        const isShortOpen = TradeLifecycleService.isShortPremiumPosition(position);
                        const syntheticTrailingPct = !isShortOpen
                            ? Number(position.trailing_stop_loss_pct || 0)
                            : 0;
                        const strategySyntheticTrailing = Boolean(position.strategy_managed)
                            && syntheticTrailingPct >= 1
                            && syntheticTrailingPct <= 50;
                        const syntheticManualStop = manualEntry && syntheticTrailingPct >= 1 && syntheticTrailingPct <= 50
                            ? roundProtectiveStop(fillPrice * (1 - syntheticTrailingPct / 100))
                            : null;
                        const stopLoss = syntheticManualStop ?? (manualEntry || isShortOpen ? null : Number((fillPrice * 0.8).toFixed(2)));
                        const takeProfit = !strategySyntheticTrailing && !isShortOpen && manualEntry?.takeProfitPct
                            ? Number((fillPrice * (1 + manualEntry.takeProfitPct / 100)).toFixed(2))
                            : !strategySyntheticTrailing && !isShortOpen && takeProfitPct !== null
                            ? Number((fillPrice * (1 + takeProfitPct / 100)).toFixed(2))
                            : null;
                        await this.fastify.pg.query(
                            `UPDATE positions
                             SET status = 'OPEN',
                                 execution_status = $1,
                                 quantity = $2,
                                 entry_price = $3,
                                 current_price = $3,
                                 stop_loss_trigger = $4,
                                 take_profit_trigger = $5,
                                 trailing_high_price = CASE
                                   WHEN trailing_stop_loss_pct IS NOT NULL THEN $3
                                   ELSE GREATEST(COALESCE(trailing_high_price, 0), $3)
                                 END,
                                 execution_error = NULL,
                                 notes = COALESCE(notes, '') || $6,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $7`,
                            [finalEntryStatus, filledQuantity, fillPrice, stopLoss, takeProfit,
                                ` [SnapTrade fill confirmed: ${finalEntryStatus}; ${filledQuantity}/${requestedQuantity} contracts; auto exits recalculated from fill]`, position.id]
                        );
                        summary.opened += 1;
                        await this.syncSignalExecutionFromOrder(position, 'EXECUTED', finalEntryStatus);
                        await TradeRedisService.recordEvent(this.fastify.pg, {
                            userId,
                            positionId: position.id,
                            eventType: 'ENTRY_FILLED',
                            message: `SnapTrade entry fill confirmed: ${finalEntryStatus}`,
                            metadata: { status: finalEntryStatus, fillPrice, filledQuantity, requestedQuantity }
                        });
                        if (!isShortOpen && manualEntry?.takeProfitPct && takeProfit) {
                            if (syntheticTrailingPct >= 1 && syntheticTrailingPct <= 50) {
                                await TradeRedisService.recordEvent(this.fastify.pg, {
                                    userId,
                                    positionId: position.id,
                                    eventType: 'SYNTHETIC_TAKE_PROFIT_ARMED',
                                    message: `App-managed take-profit armed at $${takeProfit.toFixed(2)} while synthetic trailing is enabled`,
                                    metadata: { takeProfit, trailingStopPct: syntheticTrailingPct, fillStatus: finalEntryStatus }
                                });
                            } else {
                                await this.submitManualTakeProfit({ ...position, quantity: filledQuantity }, accountId, takeProfit, finalEntryStatus);
                            }
                        }
                    }
                    summary.orders.push({
                        positionId: position.id,
                        status,
                        action: orderAction,
                        brokerOrderId: phase === 'EXIT' ? position.broker_exit_order_id : position.broker_order_id,
                        brokerTradeId: phase === 'EXIT' ? position.broker_exit_trade_id : position.broker_trade_id,
                        fillPrice
                    });
                } else if (closedStatuses.has(status)) {
                    if (phase === 'EXIT') {
                        await this.fastify.pg.query(
                            `UPDATE positions
                             SET execution_status = $1,
                                 execution_error = COALESCE($2, execution_error),
                                 notes = COALESCE(notes, '') || $3,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $4`,
                            [`EXIT_${status}`, order?.rejection_reason || order?.reason || null, ` [SnapTrade exit order EXIT_${status}]`, position.id]
                        );
                        summary.stillPending += 1;
                        await TradeRedisService.recordEvent(this.fastify.pg, {
                            userId,
                            positionId: position.id,
                            eventType: 'EXIT_BROKER_TERMINAL',
                            message: `SnapTrade exit order ${status}`,
                            metadata: { status, reason: order?.rejection_reason || order?.reason || null }
                        });
                    } else {
                        await this.fastify.pg.query(
                            `UPDATE positions
                             SET status = 'CLOSED',
                                 execution_status = $1,
                                 execution_error = COALESCE($2, execution_error),
                                 notes = COALESCE(notes, '') || $3,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $4`,
                            [status, order?.rejection_reason || order?.reason || null, ` [SnapTrade order ${status}]`, position.id]
                        );
                        summary.closed += 1;
                        await this.syncSignalExecutionFromOrder(position, 'CANCELLED', status, order?.rejection_reason || order?.reason || null);
                        await TradeRedisService.recordEvent(this.fastify.pg, {
                            userId,
                            positionId: position.id,
                            eventType: 'ENTRY_BROKER_TERMINAL',
                            message: `SnapTrade entry order ${status}`,
                            metadata: { status, reason: order?.rejection_reason || order?.reason || null }
                        });
                    }
                    summary.orders.push({
                        positionId: position.id,
                        status,
                        action: phase === 'EXIT' ? 'exit_failed' : 'closed',
                        brokerOrderId: phase === 'EXIT' ? position.broker_exit_order_id : position.broker_order_id,
                        brokerTradeId: phase === 'EXIT' ? position.broker_exit_trade_id : position.broker_trade_id
                    });
                } else {
                    const requestedAtMs = position.exit_requested_at ? new Date(position.exit_requested_at).getTime() : NaN;
                    const limitExitStale = phase === 'EXIT'
                        && executionStatus !== 'EXIT_STALE'
                        && String(position.exit_order_type || '').toUpperCase() === 'LIMIT'
                        && Number.isFinite(requestedAtMs)
                        && Date.now() - requestedAtMs > 120_000;

                    if (limitExitStale) {
                        await this.fastify.pg.query(
                            `UPDATE positions
                             SET execution_status = 'EXIT_STALE',
                                 execution_error = 'Limit exit order is still pending after 120 seconds; verify/cancel at broker before retrying.',
                                 notes = COALESCE(notes, '') || $1,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $2`,
                            [` [SnapTrade limit exit marked stale while broker status is ${status}]`, position.id]
                        );
                        summary.stillPending += 1;
                        summary.orders.push({
                            positionId: position.id,
                            status: 'EXIT_STALE',
                            action: 'exit_stale',
                            brokerOrderId: position.broker_exit_order_id,
                            brokerTradeId: position.broker_exit_trade_id
                        });
                        await TradeRedisService.recordEvent(this.fastify.pg, {
                            userId,
                            positionId: position.id,
                            eventType: 'EXIT_STALE',
                            message: `SnapTrade limit exit marked stale while broker status is ${status}`,
                            metadata: { status, brokerOrderId: position.broker_exit_order_id }
                        });
                        await new DiscordAlertService(this.fastify).send({
                            userId,
                            title: 'Exit order stale',
                            message: `Position #${position.id} ${position.symbol} ${position.option_type} ${Number(position.strike_price)} limit exit is still pending after 120 seconds. Broker status: ${status || 'unknown'}. Verify Wealthsimple before retrying.`,
                            severity: 'warning',
                            category: 'stale-exit',
                            tradeId: position.id,
                            dedupeKey: `exit-stale:${position.id}:${position.broker_exit_order_id || ''}`,
                            dedupeSeconds: 3600
                        });
                        continue;
                    }

                    const nextExecutionStatus = phase === 'EXIT'
                        ? (executionStatus === 'PENDING_TRIM'
                            ? 'PENDING_TRIM'
                            : executionStatus.startsWith('EXIT_')
                                ? executionStatus
                                : 'PENDING_EXIT')
                        : (pendingStatuses.has(status) ? status : 'PENDING');
                    await this.fastify.pg.query(
                        `UPDATE positions
                         SET execution_status = $1,
                             updated_at = CURRENT_TIMESTAMP
                        WHERE id = $2`,
                        [nextExecutionStatus, position.id]
                    );
                    if (phase === 'ENTRY') {
                        await this.syncSignalExecutionFromOrder(position, 'EXECUTED', pendingStatuses.has(status) ? status : 'PENDING');
                    }
                    summary.stillPending += 1;
                    summary.orders.push({
                        positionId: position.id,
                        status,
                        action: 'pending',
                        brokerOrderId: phase === 'EXIT' ? position.broker_exit_order_id : position.broker_order_id,
                        brokerTradeId: phase === 'EXIT' ? position.broker_exit_trade_id : position.broker_trade_id
                    });
                }
            } catch (err: any) {
                summary.unmatched += 1;
                summary.errors.push(`Position ${position.id}: ${err.message}`);
                this.fastify.log.warn(`[SnaptradeService] Failed to sync pending order ${position.id}: ${err.message}`);
            }
        }

        if (summary.opened > 0 || summary.closed > 0 || summary.trimmed > 0 || summary.stillPending > 0) {
            await redis.del(`USER_POSITIONS:${userId}`);
            await redis.del(`USER_STATS:${userId}`);
            await redis.del(`SNAPTRADE_PORTFOLIO:${userId}`);

            const streamer = (this.fastify as any).ibkrMarketDataStreamer;
            if (streamer?.syncSubscriptions) {
                streamer.syncSubscriptions().catch((err: any) => {
                    this.fastify.log.warn(`[SnaptradeService] Failed to refresh stream subscriptions after pending sync: ${err.message}`);
                });
            }
        }

        if (summary.unmatched > 0 || summary.checked > 0) {
            await TradeRedisService.rebuildOpenTrades(this.fastify.pg, userId, this.fastify);
        }

        return summary;
        } finally {
            await TradeRedisService.releaseLock(brokerSyncLock);
        }
    }

    private getManualEntryConfig(position: any): { takeProfitPct: number | null; stopLossPct: number | null } | null {
        const raw = position?.analysis_data;
        const analysisData = typeof raw === 'string'
            ? (() => {
                try { return JSON.parse(raw); } catch { return null; }
            })()
            : raw;
        const manualEntry = analysisData?.manualEntry;
        if (!manualEntry?.enabled) return null;
        const takeProfitPct = Number(manualEntry.takeProfitPct || 0);
        const stopLossPct = Number(manualEntry.stopLossPct || 0);
        return {
            takeProfitPct: Number.isFinite(takeProfitPct) && takeProfitPct > 0 ? takeProfitPct : null,
            stopLossPct: Number.isFinite(stopLossPct) && stopLossPct > 0 ? stopLossPct : null
        };
    }

    private markSyntheticTrimComplete(rawAnalysis: any): string | null {
        let analysis: any = rawAnalysis;
        if (typeof rawAnalysis === 'string') {
            try { analysis = JSON.parse(rawAnalysis); } catch { return null; }
        }
        if (!analysis?.syntheticTrailing) return null;
        return JSON.stringify({
            ...analysis,
            syntheticTrailing: {
                ...analysis.syntheticTrailing,
                tp1TrimPending: false,
                trimCompletedAt: new Date().toISOString()
            }
        });
    }

    private async submitManualTakeProfit(position: any, accountId: string, takeProfit: number, fillStatus: string) {
        const userId = Number(position.user_id);
        const quantity = Number(position.quantity || 1);
        if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;

        let acceptedOrder: { orderId?: string | null; tradeId?: string | null } | null = null;
        try {
            const optionSymbol = this.constructOSITicker(position.symbol, Number(position.strike_price), position.option_type, position.expiration_date);
            const exitAction = TradeLifecycleService.getExitAction(position);
            const order = await this.placeOptionOrder(
                userId,
                accountId,
                optionSymbol,
                exitAction,
                quantity,
                'LIMIT',
                takeProfit.toFixed(2)
            );
            acceptedOrder = order;
            await TradeLifecycleService.markExitSubmitted(this.fastify.pg, position.id, order, {
                reason: 'MANUAL_TAKE_PROFIT',
                orderType: 'LIMIT',
                note: ` [Manual Entry take-profit LIMIT ${exitAction} submitted at $${takeProfit}${order.orderId ? `: ${order.orderId}` : ''}]`
            });
            await TradeRedisService.recordEvent(this.fastify.pg, {
                userId,
                positionId: position.id,
                eventType: 'MANUAL_TAKE_PROFIT_SUBMITTED',
                message: `Manual Entry take-profit limit submitted at $${takeProfit}`,
                metadata: { orderId: order.orderId || null, tradeId: order.tradeId || null, quantity, limitPrice: takeProfit, fillStatus, action: exitAction }
            });
        } catch (err: any) {
            const ambiguous = Boolean(acceptedOrder) || isAmbiguousSnapTradeOrderError(err);
            if (ambiguous) {
                await TradeLifecycleService.markExitSubmissionFailure(
                    this.fastify.pg,
                    position.id,
                    err.message || String(err),
                    'Manual Entry take-profit submission requires reconciliation',
                    {
                        ambiguous: true,
                        orderId: acceptedOrder?.orderId || null,
                        tradeId: acceptedOrder?.tradeId || null,
                        requestedQuantity: quantity
                    }
                );
                await TradeRedisService.requestBrokerSync(userId);
            } else {
                await this.fastify.pg.query(
                    `UPDATE positions
                     SET execution_error = $1,
                         notes = COALESCE(notes, '') || $2,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [err.message || String(err), ` [Manual Entry take-profit submit failed: ${err.message || String(err)}]`, position.id]
                );
            }
            await TradeRedisService.recordEvent(this.fastify.pg, {
                userId,
                positionId: position.id,
                eventType: ambiguous ? 'MANUAL_TAKE_PROFIT_RECONCILE_REQUIRED' : 'MANUAL_TAKE_PROFIT_FAILED',
                message: err.message || String(err),
                metadata: { limitPrice: takeProfit, fillStatus }
            });
            if (ambiguous) {
                await new DiscordAlertService(this.fastify).send({
                    userId,
                    title: 'Take-profit order requires broker verification',
                    message: `Position #${position.id} may have a Wealthsimple take-profit order. Do not submit another exit until reconciliation completes.`,
                    severity: 'critical',
                    category: 'exit-failure',
                    tradeId: position.id,
                    dedupeKey: `manual-take-profit-reconcile:${position.id}`,
                    dedupeSeconds: 900
                });
            }
        }
    }

    private async syncSignalExecutionFromOrder(
        position: any,
        signalStatus: 'EXECUTED' | 'CANCELLED',
        executionStatus: string,
        executionError: string | null = null
    ) {
        const orderId = String(position.broker_order_id || '').trim();
        if (!orderId) return;

        await this.fastify.pg.query(
            `UPDATE signal_user_executions
             SET status = $1,
                 execution_status = $2,
                 execution_error = $3,
                 broker_trade_id = COALESCE(broker_trade_id, $4),
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $5
               AND broker_order_id = $6`,
            [
                signalStatus,
                executionStatus,
                executionError,
                position.broker_trade_id || null,
                position.user_id,
                orderId
            ]
        );
    }

    async syncAllPendingBrokerOrders() {
        const { rows } = await this.fastify.pg.query(
            `SELECT DISTINCT user_id
             FROM positions
             WHERE execution_broker = 'wealthsimple_snaptrade'
               AND (
                 status = 'PENDING_ORDER'
                 OR (status = 'OPEN' AND execution_status = 'PENDING_EXIT')
                 OR (status = 'OPEN' AND execution_status = 'PENDING_TRIM')
                 OR (status = 'OPEN' AND execution_status LIKE 'EXIT_%')
               )`
        );

        const summary = {
            success: true,
            usersChecked: rows.length,
            checked: 0,
            opened: 0,
            closed: 0,
            trimmed: 0,
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
                summary.trimmed += result.trimmed || 0;
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
        const settings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);

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
        const configuredSyntheticPct = Number(settings.synthetic_trailing_stop_pct || 15);
        const syntheticTrailingPct = settings.synthetic_trailing_stop_enabled === 'true'
            && Number.isFinite(configuredSyntheticPct)
            && configuredSyntheticPct >= 1
            && configuredSyntheticPct <= 50
            ? configuredSyntheticPct
            : null;
        const premiumStopLoss = roundProtectiveStop(entryPrice * (1 - (syntheticTrailingPct ?? 20) / 100));
        const takeProfitPct = await this.getTakeProfitPct(userId);
        const premiumTakeProfit = takeProfitPct !== null
            ? Number((entryPrice * (1 + takeProfitPct / 100)).toFixed(2))
            : null;

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
                syntheticTrailingPct,
                entryPrice,
                accountId,
                `[Dev SnapTrade live option test ${order.orderId || order.tradeId || 'submitted'}] [Auto exits: premium SL $${premiumStopLoss}, premium TP ${premiumTakeProfit === null ? 'suggested TP only' : `$${premiumTakeProfit}`}, synthetic trail ${syntheticTrailingPct === null ? 'off' : `${syntheticTrailingPct}%`}]`,
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
        limitPrice?: string,
        options: { skipImpact?: boolean } = {}
    ) {
        const isOpeningOrder = action === 'BUY_TO_OPEN' || action === 'SELL_TO_OPEN';
        if (isOpeningOrder) {
            const cooldownUntil = await redis.get(this.orderRateLimitKey(userId));
            const remainingSeconds = cooldownUntil
                ? Math.max(1, Math.ceil((new Date(cooldownUntil).getTime() - Date.now()) / 1000))
                : 0;
            if (remainingSeconds > 0) {
                throw new SnapTradeRateLimitError(this.rateLimitMessage(true, remainingSeconds), remainingSeconds);
            }
        }

        const { snaptrade, userIdStr, userSecret } = await this.getSnaptradeClient(userId);
        const snaptradeOptionSymbol = this.toSnaptradeOccSymbol(optionSymbol);
        const snaptradeAccountId = this.toSnaptradeAccountId(accountId);
        const snaptradeOrderType = orderType === 'LIMIT' ? 'Limit' : 'Market';

        this.fastify.log.info(`[SnaptradeService] Placing option order: ${action} ${units} contracts of ${snaptradeOptionSymbol} on account ${accountId} (Mode: ${orderType})`);

        try {
            const orderPayload: any = {
                userId: userIdStr,
                userSecret: userSecret,
                account_id: snaptradeAccountId,
                action,
                universal_symbol_id: null,
                symbol: snaptradeOptionSymbol,
                order_type: snaptradeOrderType,
                time_in_force: 'Day',
                trading_session: 'REGULAR',
                units
            };

            if (orderType === 'LIMIT') {
                const parsedLimitPrice = Number(limitPrice);
                if (!Number.isFinite(parsedLimitPrice) || parsedLimitPrice <= 0) {
                    throw new Error('Limit price is required for LIMIT orders.');
                }
                orderPayload.price = parsedLimitPrice;
            }

            const impactData = null;
            const impactWarning = options.skipImpact
                ? 'Impact preview skipped for speed-sensitive manual entry.'
                : 'Impact preview skipped for single-leg OCC option order.';

            this.fastify.log.info(`[SnaptradeService] Placing single-leg option order for ${snaptradeOptionSymbol}...`);
            const placeRes = await snaptrade.trading.placeForceOrder(orderPayload, this.snaptradeRequestOptions());
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
            if (err instanceof SnapTradeRateLimitError) throw err;
            if (this.isRateLimitError(err)) {
                if (isOpeningOrder) {
                    const cooldownUntil = new Date(Date.now() + SNAPTRADE_ORDER_RATE_LIMIT_COOLDOWN_SECONDS * 1000).toISOString();
                    await redis.set(
                        this.orderRateLimitKey(userId),
                        cooldownUntil,
                        SNAPTRADE_ORDER_RATE_LIMIT_COOLDOWN_SECONDS
                    );
                }
                this.fastify.log.warn(`[SnaptradeService] Order submission rate limited for user ${userId}`);
                throw new SnapTradeRateLimitError(this.rateLimitMessage(isOpeningOrder));
            }
            this.fastify.log.error(`[SnaptradeService] Option order execution failed: ${err.message}`);
            if (err.responseBody) {
                this.fastify.log.error(`[SnaptradeService] API response body: ${JSON.stringify(err.responseBody)}`);
            }
            const detail = err.responseBody?.detail || err.message;
            throw new SnapTradeOrderSubmissionError(
                `Failed to place options trade via SnapTrade: ${detail}`,
                this.isAmbiguousOrderSubmissionError(err)
            );
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
