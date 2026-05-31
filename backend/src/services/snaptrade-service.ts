import { FastifyInstance } from 'fastify';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import { redis } from '../lib/redis';

export class SnaptradeService {
    private fastify: FastifyInstance;
    private snaptrade: Snaptrade;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
        this.snaptrade = new Snaptrade({
            clientId: process.env.SNAPTRADE_CLIENT_ID || "PERS-8Q4PKK8U07RX1XSQM92Z",
            consumerKey: process.env.SNAPTRADE_CONSUMER_KEY || "6KyYeWMcv6UAYTUfkqJaKEn1IYgbXL7aWBtUlILoYALchsBS5X",
        });
    }

    async syncPortfolio(userId: number, snaptradeUserId: string, snaptradeUserSecret: string) {
        this.fastify.log.info(`Syncing Snaptrade portfolio for user ${userId}...`);
        
        try {
            // 1. Fetch Accounts
            const accountsRes = await this.snaptrade.accountInformation.listUserAccounts({
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

                // Upsert accounts
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
                    const positionsRes = await this.snaptrade.accountInformation.getUserAccountPositions({
                        userId: snaptradeUserId,
                        userSecret: snaptradeUserSecret,
                        accountId: account.id,
                    });

                    // Clear old positions for this account (or soft delete) - here we just delete and re-insert for simplicity and accuracy
                    await client.query('DELETE FROM snaptrade_positions WHERE account_id = $1', [account.id]);

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
            throw new Error('Failed to sync SnapTrade portfolio');
        }
    }

    async getPortfolio(userId: number) {
        const CACHE_KEY = `SNAPTRADE_PORTFOLIO:${userId}`;
        const cached = await redis.get(CACHE_KEY);
        if (cached) return JSON.parse(cached);

        const { rows: accounts } = await this.fastify.pg.query('SELECT * FROM snaptrade_accounts WHERE user_id = $1', [userId]);
        const { rows: positions } = await this.fastify.pg.query('SELECT * FROM snaptrade_positions WHERE user_id = $1', [userId]);

        const result = {
            accounts,
            positions
        };

        await redis.set(CACHE_KEY, JSON.stringify(result), 300); // 5 min cache
        return result;
    }
}
