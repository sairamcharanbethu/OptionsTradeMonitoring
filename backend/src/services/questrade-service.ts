import axios from 'axios';
import { FastifyInstance } from 'fastify';

interface QuestradeToken {
    access_token: string;
    refresh_token: string;
    api_server: string;
    token_type: string;
    expires_in: number;
    expires_at: number;
}

export class QuestradeService {
    private fastify: FastifyInstance;
    private token: QuestradeToken | null = null;
    private isRefreshing = false;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
    }

    private async getTokenFromDb(): Promise<string | null> {
        try {
            // Get the most recent refresh token regardless of user_id, 
            // similar to how MarketPoller fetches poll interval.
            const { rows } = await this.fastify.pg.query(
                "SELECT value FROM settings WHERE key = 'questrade_refresh_token' ORDER BY updated_at DESC LIMIT 1"
            );
            return rows.length > 0 ? rows[0].value : null;
        } catch (err) {
            console.error('[QuestradeService] Failed to get token from DB:', err);
            return null;
        }
    }

    private async saveTokenToDb(refreshToken: string) {
        try {
            // We need a user_id for the conflict check. We'll use the first user or 1.
            const { rows: users } = await this.fastify.pg.query("SELECT id FROM users LIMIT 1");
            const userId = users.length > 0 ? users[0].id : 1;

            await this.fastify.pg.query(
                `INSERT INTO settings (user_id, key, value, updated_at) 
                 VALUES ($1, 'questrade_refresh_token', $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id, key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
                [userId, refreshToken]
            );
        } catch (err) {
            console.error('[QuestradeService] Failed to save token to DB:', err);
        }
    }

    async setClientId(clientId: string) {
        try {
            const { rows: users } = await this.fastify.pg.query("SELECT id FROM users LIMIT 1");
            const userId = users.length > 0 ? users[0].id : 1;

            await this.fastify.pg.query(
                `INSERT INTO settings (user_id, key, value, updated_at) 
                 VALUES ($1, 'questrade_client_id', $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id, key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
                [userId, clientId]
            );
        } catch (err) {
            console.error('[QuestradeService] Failed to save client_id to DB:', err);
        }
    }

    async initializeWithToken(data: { access_token: string; refresh_token: string; api_server: string; token_type: string; expires_in: number }) {
        this.token = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            api_server: data.api_server,
            token_type: data.token_type,
            expires_in: data.expires_in,
            expires_at: Date.now() + (data.expires_in * 1000)
        };

        await this.saveTokenToDb(data.refresh_token);
        console.log('[QuestradeService] Initialized with provided token.');
    }

    async getClientId(): Promise<string | null> {
        try {
            const { rows } = await this.fastify.pg.query(
                "SELECT value FROM settings WHERE key = 'questrade_client_id' ORDER BY updated_at DESC LIMIT 1"
            );
            return rows.length > 0 ? rows[0].value : (process.env.QUESTRADE_CLIENT_ID || null);
        } catch (err) {
            console.error('[QuestradeService] Failed to get client_id from DB:', err);
            return null;
        }
    }

    private async ensureAuthenticated() {
        if (this.token && this.token.expires_at > Date.now() + 60000) {
            return;
        }

        if (this.isRefreshing) {
            // Simple wait if already refreshing
            while (this.isRefreshing) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
        }

        this.isRefreshing = true;
        try {
            let refreshToken = await this.getTokenFromDb();

            // Fallback to env for initial setup
            if (!refreshToken) {
                refreshToken = process.env.QUESTRADE_REFRESH_TOKEN || null;
                if (!refreshToken) {
                    throw new Error('Questrade Refresh Token not found in DB or ENV');
                }
            }

            console.log('[QuestradeService] Refreshing access token...');
            const tokenUrl = `https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${refreshToken}`;
            const response = await axios.get<any>(tokenUrl);

            const data = response.data;
            this.token = {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                api_server: data.api_server,
                token_type: data.token_type,
                expires_in: data.expires_in,
                expires_at: Date.now() + (data.expires_in * 1000)
            };

            await this.saveTokenToDb(data.refresh_token);
            console.log('[QuestradeService] Token refreshed successfully.');

        } catch (err: any) {
            console.error('[QuestradeService] Authentication failed:', err.response?.data || err.message);
            throw err;
        } finally {
            this.isRefreshing = false;
        }
    }

    async getSymbolId(symbol: string): Promise<number | null> {
        await this.ensureAuthenticated();
        try {
            const response = await axios.get<any>(`${this.token!.api_server}v1/symbols?names=${symbol.toUpperCase()}`, {
                headers: { Authorization: `${this.token!.token_type} ${this.token!.access_token}` }
            });

            const symbols = response.data.symbols;
            return symbols && symbols.length > 0 ? symbols[0].symbolId : null;
        } catch (err: any) {
            console.error(`[QuestradeService] Failed to get symbol ID for ${symbol}:`, err.message);
            return null;
        }
    }

    async getQuote(symbolId: number): Promise<any> {
        await this.ensureAuthenticated();
        try {
            const response = await axios.get<any>(`${this.token!.api_server}v1/markets/quotes/${symbolId}`, {
                headers: { Authorization: `${this.token!.token_type} ${this.token!.access_token}` }
            });
            return response.data.quotes[0];
        } catch (err: any) {
            console.error(`[QuestradeService] Failed to get quote for ${symbolId}:`, err.message);
            return null;
        }
    }

    async getOptionQuote(symbolId: number): Promise<any> {
        await this.ensureAuthenticated();
        try {
            // Note: v1/markets/quotes/options is specifically for options and can provide Greeks
            const response = await axios.post<any>(`${this.token!.api_server}v1/markets/quotes/options`, {
                filters: [
                    {
                        optionId: symbolId
                    }
                ]
            }, {
                headers: { Authorization: `${this.token!.token_type} ${this.token!.access_token}` }
            });
            return response.data.optionQuotes && response.data.optionQuotes.length > 0 ? response.data.optionQuotes[0] : null;
        } catch (err: any) {
            console.error(`[QuestradeService] Failed to get option quote for ${symbolId}:`, err.message);
            return null;
        }
    }

    async getHistoricalData(symbolId: number, startTime: Date, endTime: Date, interval: string = 'OneDay'): Promise<any[]> {
        await this.ensureAuthenticated();
        try {
            const start = startTime.toISOString();
            const end = endTime.toISOString();

            const response = await axios.get<any>(`${this.token!.api_server}v1/markets/candles/${symbolId}`, {
                params: {
                    startTime: start,
                    endTime: end,
                    interval: interval
                },
                headers: { Authorization: `${this.token!.token_type} ${this.token!.access_token}` }
            });

            return response.data.candles;
        } catch (err: any) {
            console.error(`[QuestradeService] Failed to get historical data for ${symbolId}:`, err.message);
            return [];
        }
    }
}
