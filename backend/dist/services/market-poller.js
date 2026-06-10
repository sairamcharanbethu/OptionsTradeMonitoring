"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketPoller = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const stop_loss_engine_1 = require("./stop-loss-engine");
const redis_1 = require("../lib/redis");
const ai_service_1 = require("./ai-service");
const ws_1 = __importDefault(require("ws"));
class MarketPoller {
    fastify;
    aiService;
    currentIntervalSeconds = 30; // Default 30s
    timerId = null;
    pollingEnabled = true;
    redisClient;
    // Alpaca WebSocket stream
    alpacaWs = null;
    alpacaReconnectAttempts = 0;
    alpacaReconnectTimer = null;
    alpacaStreamActive = false;
    constructor(fastify, redisClient) {
        this.fastify = fastify;
        this.aiService = new ai_service_1.AIService(fastify);
        this.redisClient = redisClient || redis_1.redis;
    }
    LOCK_KEY = 'MARKET_POLLER_LEADER';
    async start() {
        // 1. Fetch the preferred interval and polling enabled state from settings
        try {
            const { rows } = await this.fastify.pg.query("SELECT key, value FROM settings WHERE key IN ('market_poll_interval', 'polling_enabled') ORDER BY updated_at DESC");
            for (const row of rows) {
                if (row.key === 'market_poll_interval') {
                    this.currentIntervalSeconds = parseInt(row.value, 10) || 60;
                }
                else if (row.key === 'polling_enabled') {
                    this.pollingEnabled = row.value !== 'false';
                }
            }
        }
        catch (err) {
            this.fastify.log.error(`[MarketPoller] Failed to load poll settings from DB: ${err}`);
        }
        this.fastify.log.info(`[MarketPoller] Starting with polling ${this.pollingEnabled ? 'ENABLED' : 'DISABLED'}, interval: ${this.currentIntervalSeconds}s`);
        // Start recursive loop
        this.scheduleNextPoll();
        this.startBriefingJob();
        // Start Alpaca WebSocket stream for instant trade update notifications
        this.startAlpacaStream();
    }
    scheduleNextPoll() {
        if (this.timerId)
            clearTimeout(this.timerId);
        this.timerId = setTimeout(async () => {
            try {
                if (!this.pollingEnabled) {
                    // Skip polling but keep the timer alive so we can resume
                    return;
                }
                // Distributed Lock Check
                // Attempt to acquire lock for slightly longer than the interval
                const lockDuration = this.currentIntervalSeconds + 5;
                const acquired = await this.redisClient.setNX(this.LOCK_KEY, 'LOCKED', Math.floor(lockDuration));
                if (acquired) {
                    await this.poll();
                }
            }
            catch (err) {
                this.fastify.log.error(`[MarketPoller] Error during poll execution: ${err}`);
            }
            finally {
                this.scheduleNextPoll();
            }
        }, this.currentIntervalSeconds * 1000);
    }
    updateInterval(seconds) {
        this.fastify.log.info(`[MarketPoller] Updating poll interval to: ${seconds}s`);
        this.currentIntervalSeconds = seconds;
        this.scheduleNextPoll(); // Reschedule immediately
    }
    /**
     * Stop polling. The timer loop stays alive but skips actual poll calls.
     */
    stop() {
        this.pollingEnabled = false;
        this.fastify.log.info('[MarketPoller] Polling DISABLED by user.');
    }
    /**
     * Resume polling after being stopped.
     */
    resume() {
        this.pollingEnabled = true;
        this.fastify.log.info('[MarketPoller] Polling ENABLED by user.');
        this.scheduleNextPoll(); // Kick off immediately
    }
    /**
     * Returns whether polling is currently active.
     */
    isRunning() {
        return this.pollingEnabled;
    }
    // Called by QuestradeStreamService via Index.ts
    async handlePriceUpdate(quote) {
        if (!quote || !quote.symbolId)
            return;
        // Map SymbolID -> Position(s)
        // Since we don't store symbolId in DB, we have to look it up or do a reverse check.
        // Optimization: We can store a local cache of SymbolID -> Symbol string
        // For now, let's try to match by resolving if needed, but that's slow.
        // Better approach: If quote has 'symbol', use it. If not, we might skip or broadcast only.
        // Questrade stream quotes usually imply we know the ID. 
        // Let's rely on the Poller's cache if possible, or just skip if we can't map.
        // Actually, for immediate STOP LOSS, we really want to process this.
        // Let's assume for this iteration we mainly broadcast for UI.
        // Stop Loss checks are still run by the Poller periodically (1 min).
        // If we want real-time stop loss, we'd need a robust ID map.
        // Future TODO: Add symbol_id to positions table.
    }
    startBriefingJob() {
        // Default to 8:30 AM ET
        const schedule = process.env.MORNING_BRIEFING_SCHEDULE || '30 8 * * *';
        this.fastify.log.info(`[MarketPoller] Starting morning briefing job with schedule: ${schedule}`);
        node_cron_1.default.schedule(schedule, async () => {
            try {
                await this.sendMorningBriefings();
            }
            catch (err) {
                this.fastify.log.error(`[MarketPoller] Error during morning briefing execution: ${err}`);
            }
        });
    }
    async sendMorningBriefings(ignoreFrequency = false) {
        this.fastify.log.info(`[MarketPoller] Executing morning briefings (ignoreFrequency: ${ignoreFrequency})...`);
        const { rows: users } = await this.fastify.pg.query('SELECT DISTINCT p.user_id, u.username FROM positions p JOIN users u ON p.user_id = u.id');
        for (const { user_id: userId, username } of users) {
            try {
                // 1. Check user settings for briefing frequency
                const { rows: settingsRows } = await this.fastify.pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
                const settings = settingsRows.reduce((acc, row) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {});
                const frequency = settings.briefing_frequency || 'disabled';
                if (!ignoreFrequency && frequency === 'disabled')
                    continue;
                // 2. Decide if we should send it today
                if (!ignoreFrequency && !this.shouldSendBriefingToday(frequency))
                    continue;
                // 3. Fetch open positions
                const { rows: positions } = await this.fastify.pg.query("SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.user_id = $1 AND p.status != 'CLOSED'", [userId]);
                if (positions.length === 0)
                    continue;
                // 4. Generate AI briefing
                this.fastify.log.info(`[MarketPoller] Generating briefing for user ${userId}...`);
                const briefingData = await this.aiService.generateBriefing(positions);
                // 5. Notify N8n
                await this.notifyN8nBriefing(userId, username, briefingData.briefing, briefingData.discord_message);
            }
            catch (err) {
                this.fastify.log.error(`[MarketPoller] Failed to send briefing for user ${userId}: ${err}`);
            }
        }
    }
    shouldSendBriefingToday(frequency) {
        const now = new Date();
        // Use ET for consistency
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            weekday: 'long',
        });
        const weekday = formatter.format(now);
        switch (frequency) {
            case 'daily': return true;
            case 'every_2_days':
                // Simple parity check on day of year/month for demo purposes
                // In production, we might store "last_briefing_sent" in DB
                return now.getDate() % 2 === 0;
            case 'monday': return weekday === 'Monday';
            case 'friday': return weekday === 'Friday';
            case 'weekly': return weekday === 'Monday'; // Default weekly to Monday
            default: return false;
        }
    }
    async notifyN8nBriefing(userId, username, briefing, discordMessage) {
        const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
        if (!N8N_WEBHOOK_URL)
            return;
        try {
            await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'MORNING_BRIEFING',
                    notification_type: 'briefing',
                    user_id: userId,
                    username: username,
                    briefing: briefing,
                    discord_message: `**[User: ${username}]**\n${discordMessage}`,
                    timestamp: new Date().toISOString()
                })
            });
            this.fastify.log.info(`[MarketPoller] Briefing sent to n8n for user ${userId}`);
        }
        catch (err) {
            this.fastify.log.error(`[MarketPoller] Failed to notify n8n for briefing (user ${userId}):`, err.message);
        }
    }
    constructOSITicker(symbol, strike, type, expiration) {
        // Format: AAPL230616C00150000
        // Use string parsing for expiration to avoid timezone shifts
        // Expecting YYYY-MM-DD (Date object or string)
        let dateStr = '';
        if (expiration instanceof Date) {
            // Format to YYYY-MM-DD manually to avoid timezone shift from .toISOString()
            const year = expiration.getFullYear();
            const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
            const day = expiration.getDate().toString().padStart(2, '0');
            dateStr = `${year}-${month}-${day}`;
        }
        else {
            dateStr = expiration.split('T')[0];
        }
        const parts = dateStr.split('-');
        if (parts.length !== 3) {
            this.fastify.log.warn(`[MarketPoller] Invalid expiration date format: ${expiration}`);
            return `${symbol.toUpperCase()}XXXXXX${type === 'CALL' ? 'C' : 'P'}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
        }
        const YY = parts[0].slice(-2);
        const MM = parts[1].padStart(2, '0');
        const DD = parts[2].padStart(2, '0');
        const side = type === 'CALL' ? 'C' : 'P';
        const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
        return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
    }
    async getOptionPremium(userId, symbol, strike, type, expiration, skipCache = false) {
        const ticker = this.constructOSITicker(symbol, strike, type, expiration);
        try {
            // 0. Check for user-specific Alpaca configuration
            const { rows: settingsRows } = await this.fastify.pg.query("SELECT key, value FROM settings WHERE user_id = $1 AND key IN ('alpaca_key_id', 'alpaca_secret_key')", [userId]);
            const settings = settingsRows.reduce((acc, row) => {
                acc[row.key] = row.value;
                return acc;
            }, {});
            const alpacaKeyId = settings.alpaca_key_id?.trim();
            const alpacaSecretKey = settings.alpaca_secret_key?.trim();
            if (alpacaKeyId && alpacaSecretKey) {
                this.fastify.log.info(`[MarketPoller] Fetching price for ${ticker} via Alpaca API...`);
                // 1. Fetch Option Snapshot
                const optUrl = `https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${ticker}`;
                const optRes = await fetch(optUrl, {
                    headers: {
                        'APCA-API-KEY-ID': alpacaKeyId,
                        'APCA-API-SECRET-KEY': alpacaSecretKey
                    }
                });
                if (!optRes.ok) {
                    throw new Error(`Alpaca options snapshot API error: Status ${optRes.status}`);
                }
                const optData = await optRes.json();
                const snapshot = optData.snapshots?.[ticker];
                if (!snapshot) {
                    throw new Error(`Alpaca options snapshot not found for ${ticker}`);
                }
                // Calculate option price (mid-price of bid/ask if valid, else latest trade price)
                const bid = snapshot.latestQuote?.bp || 0;
                const ask = snapshot.latestQuote?.ap || 0;
                const price = (bid > 0 && ask > 0) ? (bid + ask) / 2 : snapshot.latestTrade?.p || 0;
                // 2. Fetch Underlying Price
                let underlyingPrice = 0;
                const stockUrl = `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbol}`;
                const stockRes = await fetch(stockUrl, {
                    headers: {
                        'APCA-API-KEY-ID': alpacaKeyId,
                        'APCA-API-SECRET-KEY': alpacaSecretKey
                    }
                });
                if (stockRes.ok) {
                    const stockData = await stockRes.json();
                    underlyingPrice = stockData[symbol]?.latestTrade?.p || stockData[symbol]?.latestQuote?.ap || 0;
                }
                else {
                    this.fastify.log.warn(`[MarketPoller] Alpaca stock snapshot query failed: Status ${stockRes.status}`);
                }
                return {
                    status: 'ok',
                    symbol: ticker,
                    price,
                    iv: null,
                    underlying_price: underlyingPrice,
                    greeks: null,
                    metadata: {
                        symbol,
                        strike,
                        type,
                        expiration
                    }
                };
            }
            // Fallback: Questrade Integration
            const questrade = this.fastify.questrade;
            // 1. Get/Resolve Option Symbol ID
            // We can STILL cache the symbolId for the ticker (it never changes for a specific option)
            const SYMBOL_ID_CACHE_KEY = `SYMBOL_ID:${ticker}`;
            let symbolId = null;
            const cachedId = await this.redisClient.get(SYMBOL_ID_CACHE_KEY);
            if (cachedId) {
                symbolId = parseInt(cachedId, 10);
            }
            else {
                this.fastify.log.info(`[MarketPoller] Resolving Questrade Symbol ID for ${ticker}...`);
                symbolId = await questrade.getSymbolId(ticker);
                if (symbolId) {
                    await this.redisClient.set(SYMBOL_ID_CACHE_KEY, symbolId.toString(), 86400); // 24h
                    await this.redisClient.set(`SYMBOL_NAME:${symbolId}`, ticker, 86400);
                }
            }
            if (!symbolId) {
                this.fastify.log.warn(`[MarketPoller] Could not resolve symbol ID for ${ticker} on Questrade.`);
                return null;
            }
            // 2. Get Quote from Questrade (FRESH EVERY TIME)
            const quote = await questrade.getOptionQuote(symbolId);
            if (!quote)
                return null;
            // 3. Fetch Underlying Price (Questrade option quote doesn't include it in JSON)
            let underlyingPrice = 0;
            if (quote.underlyingId) {
                const uQuotes = await questrade.getQuote([quote.underlyingId]);
                if (uQuotes && uQuotes.length > 0) {
                    underlyingPrice = uQuotes[0].lastTradePrice || 0;
                }
            }
            // Calculate premium (use Mid price if available, else last)
            const bid = quote.bidPrice || 0;
            const ask = quote.askPrice || 0;
            const price = (bid > 0 && ask > 0) ? (bid + ask) / 2 : quote.lastTradePrice || 0;
            const result = {
                status: 'ok',
                symbol: ticker,
                price,
                iv: quote.volatility || 0,
                underlying_price: underlyingPrice,
                greeks: {
                    delta: quote.delta || 0,
                    gamma: quote.gamma || 0,
                    theta: quote.theta || 0,
                    vega: quote.vega || 0,
                    rho: quote.rho || 0
                },
                metadata: {
                    symbol,
                    strike,
                    type,
                    expiration
                }
            };
            // We no longer set PRICE cache in Redis as per user request
            return result;
        }
        catch (err) {
            this.fastify.log.error(`[MarketPoller] Option fetch failed for ${ticker}:`, err.message);
            return null;
        }
    }
    async syncPrice(symbol, skipCache = false) {
        this.fastify.log.info(`[MarketPoller] TARGETED Sync for symbol: ${symbol}`);
        const { rows: positions } = await this.fastify.pg.query("SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.symbol = $1 AND p.status != 'CLOSED'", [symbol]);
        if (positions.length === 0) {
            this.fastify.log.info(`[MarketPoller] No active or triggered positions found for ${symbol}.`);
            return null;
        }
        let lastFetchedPrice = null;
        for (const position of positions) {
            const data = await this.getOptionPremium(position.user_id, position.symbol, Number(position.strike_price), position.option_type, position.expiration_date, skipCache);
            if (data && data.price !== null) {
                // this.fastify.log.debug(`[MarketPoller] ${position.symbol} ${position.option_type} $${position.strike_price} -> Premium: $${data.price}`);
                this.fastify.log.info(`[MarketPoller] ${position.symbol} Price: ${data.price} IV: ${data.iv} Underlying: ${data.underlying_price} Greeks:`, data.greeks);
                await this.processUpdate(position, data.price, data.greeks, data.iv, data.underlying_price);
                lastFetchedPrice = data.price;
            }
        }
        if (lastFetchedPrice !== null) {
            this.fastify.log.info(`[MarketPoller] TARGETED Sync for ${symbol} completed successfully.`);
        }
        else {
            this.fastify.log.warn(`[MarketPoller] TARGETED Sync for ${symbol} failed or no positions were updated.`);
        }
        return lastFetchedPrice;
    }
    isMarketOpen() {
        const now = new Date();
        // Use Intl to get ET time
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            weekday: 'short',
            hour: 'numeric',
            minute: 'numeric',
        });
        const parts = formatter.formatToParts(now);
        const getPart = (type) => parts.find(p => p.type === type)?.value;
        const weekday = getPart('weekday');
        const hour = parseInt(getPart('hour') || '0', 10);
        const minute = parseInt(getPart('minute') || '0', 10);
        // Weekend check
        if (weekday === 'Sat' || weekday === 'Sun')
            return false;
        // Market hours: 9:30 AM - 4:15 PM (16:15) ET
        const currentTimeMinutes = hour * 60 + minute;
        const marketOpenMinutes = 9 * 60 + 30;
        const marketCloseMinutes = 16 * 60 + 15;
        return currentTimeMinutes >= marketOpenMinutes && currentTimeMinutes <= marketCloseMinutes;
    }
    async poll(force = false) {
        this.fastify.log.info(`[MarketPoller] Polling job started at ${new Date().toISOString()}...`);
        const { rows: positions } = await this.fastify.pg.query("SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.status != 'CLOSED'");
        if (positions.length === 0) {
            this.fastify.log.info('[MarketPoller] No active positions to poll.');
            return;
        }
        // 0. Hard Time-based Day Trading Cutoffs Enforcements
        const now = new Date();
        const etFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });
        const [etHourStr, etMinuteStr] = etFormatter.format(now).split(':');
        const etHour = parseInt(etHourStr, 10);
        const etMinute = parseInt(etMinuteStr, 10);
        const etTimeMinutes = etHour * 60 + etMinute;
        const todayStr = now.toISOString().split('T')[0];
        const isEodCutoff = etTimeMinutes >= 15 * 60 + 50; // 3:50 PM ET or later
        const isMorningCutoff = etTimeMinutes >= 13 * 60; // 1:00 PM ET or later
        for (const pos of positions) {
            let shouldForceClose = false;
            let reason = '';
            const expDateStr = pos.expiration_date instanceof Date
                ? pos.expiration_date.toISOString().split('T')[0]
                : new Date(pos.expiration_date).toISOString().split('T')[0];
            const is0Dte = expDateStr === todayStr;
            if (isEodCutoff) {
                shouldForceClose = true;
                reason = 'EOD Hard Cutoff (3:50 PM ET)';
            }
            else if (isMorningCutoff && is0Dte) {
                shouldForceClose = true;
                reason = 'Morning 0 DTE Hard Cutoff (1:00 PM ET)';
            }
            if (shouldForceClose) {
                this.fastify.log.info(`[MarketPoller] Force closing position ${pos.id} (${pos.symbol}) due to ${reason}.`);
                let currentPrice = Number(pos.current_price || pos.entry_price);
                if (!pos.is_simulated) {
                    try {
                        const accountId = pos.account_id;
                        if (!accountId) {
                            this.fastify.log.error(`[MarketPoller] No account_id found for Live position ${pos.id}. Cannot force close.`);
                        }
                        else {
                            const snaptradeService = new (await Promise.resolve().then(() => __importStar(require('./snaptrade-service')))).SnaptradeService(this.fastify);
                            const osiTicker = this.constructOSITicker(pos.symbol, Number(pos.strike_price), pos.option_type, pos.expiration_date);
                            // Hard cutoffs always use MARKET orders to guarantee exit before bell
                            let limitPrice = undefined;
                            let orderType = 'MARKET';
                            await snaptradeService.placeOptionOrder(pos.user_id, accountId, osiTicker, 'SELL_TO_CLOSE', pos.quantity, orderType, limitPrice);
                        }
                    }
                    catch (err) {
                        this.fastify.log.error(`[MarketPoller] Failed to execute Live force-close for position ${pos.id}: ${err.message}`);
                    }
                }
                else if (pos.account_id === 'alpaca_paper') {
                    try {
                        const { rows: settingsRows } = await this.fastify.pg.query("SELECT key, value FROM settings WHERE user_id = $1 AND key IN ('alpaca_key_id', 'alpaca_secret_key')", [pos.user_id]);
                        const userSettings = settingsRows.reduce((acc, r) => {
                            acc[r.key] = r.value;
                            return acc;
                        }, {});
                        const alpacaKeyId = userSettings.alpaca_key_id?.trim() || '';
                        const alpacaSecretKey = userSettings.alpaca_secret_key?.trim() || '';
                        if (alpacaKeyId && alpacaSecretKey) {
                            const osiTicker = this.constructOSITicker(pos.symbol, Number(pos.strike_price), pos.option_type, pos.expiration_date);
                            this.fastify.log.info(`[MarketPoller] Force closing Alpaca paper position ${pos.id} (${osiTicker})...`);
                            const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
                                method: 'POST',
                                headers: {
                                    'APCA-API-KEY-ID': alpacaKeyId,
                                    'APCA-API-SECRET-KEY': alpacaSecretKey,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    symbol: osiTicker,
                                    qty: pos.quantity || 1,
                                    side: 'sell',
                                    type: 'market',
                                    time_in_force: 'day'
                                })
                            });
                            if (!res.ok) {
                                const errText = await res.text();
                                throw new Error(`Alpaca paper force close failed: ${res.status} - ${errText}`);
                            }
                        }
                    }
                    catch (err) {
                        this.fastify.log.error(`[MarketPoller] Failed to execute Alpaca force-close for position ${pos.id}: ${err.message}`);
                    }
                }
                const realizedPnl = (currentPrice - Number(pos.entry_price)) * pos.quantity * 100;
                await this.fastify.pg.query(`UPDATE positions 
                 SET status = 'CLOSED', 
                     realized_pnl = $1,
                     notes = COALESCE(notes, '') || $2,
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $3`, [realizedPnl, ` [Force closed: ${reason}]`, pos.id]);
                await this.notifyN8n(pos, currentPrice, realizedPnl, 0, 'FORCE_CLOSE', `Position force closed due to ${reason}`, `**[FORCE CLOSE]** Position closed due to ${reason}. Current price: $${currentPrice}. P&L: $${realizedPnl.toFixed(2)}`);
                pos.status = 'CLOSED';
            }
        }
        // Refresh active positions list after cutoffs
        const activePositions = positions.filter((p) => p.status !== 'CLOSED');
        if (activePositions.length === 0) {
            this.fastify.log.info('[MarketPoller] All active positions were force-closed by cutoffs.');
            return;
        }
        const symbols = [...new Set(activePositions.map((p) => p.symbol))];
        const isMarketOpen = this.isMarketOpen();
        const etWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
        const isWeekend = etWeekday === 'Sat' || etWeekday === 'Sun';
        const allowSync = isMarketOpen || isWeekend;
        if (!force && !isMarketOpen) {
            if (isWeekend) {
                this.fastify.log.info('[MarketPoller] Market is closed (Weekend), but weekend testing bypass is active. Price syncing allowed.');
            }
            else {
                this.fastify.log.info('[MarketPoller] Market is closed. Will only perform housekeeping (auto-expiry).');
            }
        }
        for (const symbol of symbols) {
            // 1. Auto-Close Expired Logic
            // Check for expired positions for this symbol first
            const symbolPositions = positions.filter((p) => p.symbol === symbol);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            for (const pos of symbolPositions) {
                const expDate = new Date(pos.expiration_date);
                expDate.setHours(0, 0, 0, 0);
                // Standard comparison: If expiration date is strictly less than today (yesterday or earlier), it's expired.
                if (expDate < today) {
                    this.fastify.log.info(`[MarketPoller] Auto-closing expired position ${pos.id} (${pos.symbol}) as worthless/expired.`);
                    // Close with 0 PnL
                    await this.fastify.pg.query(`UPDATE positions 
                 SET status = 'CLOSED', 
                     exit_price = 0, 
                     realized_pnl = 0, 
                     notes = COALESCE(notes, '') || ' [Auto-closed as Expired]',
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`, [pos.id]);
                    // Mark as closed locally so we don't sync it below
                    pos.status = 'CLOSED';
                }
            }
            // 2. Price Sync (Only if Market Open or Forced)
            // Filter out positions we just closed
            const activePositions = symbolPositions.filter((p) => p.status !== 'CLOSED');
            if ((force || allowSync) && activePositions.length > 0) {
                await this.syncPrice(symbol, force);
                // Stay within limits, sequential delay
                await new Promise(resolve => setTimeout(() => resolve(), 5000));
            }
        }
    }
    async processUpdate(position, price, greeks, iv, underlyingPrice) {
        const engineResult = stop_loss_engine_1.StopLossEngine.evaluate(price, {
            entry_price: Number(position.entry_price),
            stop_loss_trigger: Number(position.stop_loss_trigger),
            take_profit_trigger: position.take_profit_trigger ? Number(position.take_profit_trigger) : undefined,
            trailing_high_price: Number(position.trailing_high_price || position.entry_price),
            trailing_stop_loss_pct: position.trailing_stop_loss_pct ? Number(position.trailing_stop_loss_pct) : undefined,
        });
        let triggered = engineResult.triggered;
        let triggerType = engineResult.triggerType;
        let lossAvoided = engineResult.lossAvoided;
        // Strategy 1: Underlying-Triggered Stops (Structural Exit Strategy)
        const underlyingStop = position.suggested_stop_loss ? Number(position.suggested_stop_loss) : null;
        const underlyingTarget = position.suggested_take_profit_1 ? Number(position.suggested_take_profit_1) : null;
        if (underlyingPrice && underlyingStop) {
            if (position.option_type === 'CALL' && underlyingPrice <= underlyingStop) {
                triggered = true;
                triggerType = 'STOP_LOSS';
                lossAvoided = Number(position.entry_price) - price;
                this.fastify.log.info(`[MarketPoller] Strategy 1 STOP_LOSS triggered via underlying index price: ${underlyingPrice} <= ${underlyingStop}`);
            }
            else if (position.option_type === 'PUT' && underlyingPrice >= underlyingStop) {
                triggered = true;
                triggerType = 'STOP_LOSS';
                lossAvoided = Number(position.entry_price) - price;
                this.fastify.log.info(`[MarketPoller] Strategy 1 STOP_LOSS triggered via underlying index price: ${underlyingPrice} >= ${underlyingStop}`);
            }
        }
        if (underlyingPrice && underlyingTarget && !triggered) {
            // Parse analysis_data to check for Negative GEX Regime dynamic trailing stop
            let analysis = {};
            try {
                if (position.analysis_data) {
                    analysis = typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data;
                }
            }
            catch (e) {
                this.fastify.log.warn(`[MarketPoller] Failed to parse analysis_data for position ${position.id}`);
            }
            const gexRegime = analysis.gexRegime || 'POSITIVE';
            if (gexRegime === 'NEGATIVE') {
                // Dynamic Trailing profit target active
                if (position.option_type === 'CALL') {
                    // Check if we already hit target and activated trailing
                    const hasReachedTarget = analysis.underlyingTrailingHigh !== undefined || underlyingPrice >= underlyingTarget;
                    if (hasReachedTarget) {
                        const currentTrailingHigh = analysis.underlyingTrailingHigh || underlyingPrice;
                        const newTrailingHigh = Math.max(currentTrailingHigh, underlyingPrice);
                        analysis.underlyingTrailingHigh = newTrailingHigh;
                        // Trailing stop at 0.2% below trailing high
                        const trailingStopPrice = newTrailingHigh * (1 - 0.002);
                        this.fastify.log.info(`[MarketPoller] Negative GEX Dynamic Trailing active on position ${position.id}. High: ${newTrailingHigh.toFixed(2)}, Stop: ${trailingStopPrice.toFixed(2)}, Spot: ${underlyingPrice.toFixed(2)}`);
                        if (underlyingPrice <= trailingStopPrice) {
                            triggered = true;
                            triggerType = 'TAKE_PROFIT';
                            this.fastify.log.info(`[MarketPoller] Dynamic Trailing TAKE_PROFIT triggered for CALL: Spot ${underlyingPrice.toFixed(2)} <= Trailing Stop ${trailingStopPrice.toFixed(2)}`);
                        }
                        // Save updated analysis data back to the database
                        await this.fastify.pg.query("UPDATE positions SET analysis_data = $1 WHERE id = $2", [JSON.stringify(analysis), position.id]);
                    }
                }
                else if (position.option_type === 'PUT') {
                    const hasReachedTarget = analysis.underlyingTrailingLow !== undefined || underlyingPrice <= underlyingTarget;
                    if (hasReachedTarget) {
                        const currentTrailingLow = analysis.underlyingTrailingLow || underlyingPrice;
                        const newTrailingLow = Math.min(currentTrailingLow, underlyingPrice);
                        analysis.underlyingTrailingLow = newTrailingLow;
                        // Trailing stop at 0.2% above trailing low
                        const trailingStopPrice = newTrailingLow * (1 + 0.002);
                        this.fastify.log.info(`[MarketPoller] Negative GEX Dynamic Trailing active on position ${position.id}. Low: ${newTrailingLow.toFixed(2)}, Stop: ${trailingStopPrice.toFixed(2)}, Spot: ${underlyingPrice.toFixed(2)}`);
                        if (underlyingPrice >= trailingStopPrice) {
                            triggered = true;
                            triggerType = 'TAKE_PROFIT';
                            this.fastify.log.info(`[MarketPoller] Dynamic Trailing TAKE_PROFIT triggered for PUT: Spot ${underlyingPrice.toFixed(2)} >= Trailing Stop ${trailingStopPrice.toFixed(2)}`);
                        }
                        // Save updated analysis data
                        await this.fastify.pg.query("UPDATE positions SET analysis_data = $1 WHERE id = $2", [JSON.stringify(analysis), position.id]);
                    }
                }
            }
            else {
                // Standard fixed take-profit target for Positive GEX mean-reversion
                if (position.option_type === 'CALL' && underlyingPrice >= underlyingTarget) {
                    triggered = true;
                    triggerType = 'TAKE_PROFIT';
                    this.fastify.log.info(`[MarketPoller] Strategy 1 Fixed TAKE_PROFIT triggered via underlying index price: ${underlyingPrice} >= ${underlyingTarget}`);
                }
                else if (position.option_type === 'PUT' && underlyingPrice <= underlyingTarget) {
                    triggered = true;
                    triggerType = 'TAKE_PROFIT';
                    this.fastify.log.info(`[MarketPoller] Strategy 1 Fixed TAKE_PROFIT triggered via underlying index price: ${underlyingPrice} <= ${underlyingTarget}`);
                }
            }
        }
        // Update Price AND Greeks
        await this.fastify.pg.query(`UPDATE positions 
       SET current_price = $1, 
           updated_at = CURRENT_TIMESTAMP,
           delta = $2,
           theta = $3,
           gamma = $4,
           vega = $5,
           iv = $6,
           underlying_price = $7
       WHERE id = $8`, [
            price,
            greeks?.delta ?? null,
            greeks?.theta ?? null,
            greeks?.gamma ?? null,
            greeks?.vega ?? null,
            iv ?? null,
            underlyingPrice ?? null,
            position.id
        ]);
        await this.fastify.pg.query('INSERT INTO price_history (position_id, price) VALUES ($1, $2)', [position.id, price]);
        if (triggered) {
            if (position.status === 'OPEN') {
                const exitTriggerType = triggerType || 'STOP_LOSS';
                const newStatus = 'CLOSED';
                const realizedPnl = (price - Number(position.entry_price)) * position.quantity * 100;
                // Execute Live SnapTrade order if not simulated
                if (!position.is_simulated) {
                    this.fastify.log.info(`[MarketPoller] LIVE position exit triggered for position ${position.id} (${position.symbol}). Executing SELL_TO_CLOSE via SnapTrade...`);
                    try {
                        const accountId = position.account_id;
                        if (!accountId) {
                            this.fastify.log.error(`[MarketPoller] No account_id found for Live position ${position.id}. Cannot close.`);
                        }
                        else {
                            const snaptradeService = new (await Promise.resolve().then(() => __importStar(require('./snaptrade-service')))).SnaptradeService(this.fastify);
                            const osiTicker = this.constructOSITicker(position.symbol, Number(position.strike_price), position.option_type, position.expiration_date);
                            let limitPrice = undefined;
                            let orderType = 'MARKET';
                            // Only use LIMIT order if taking profit. Stop Loss MUST be MARKET to guarantee exit.
                            if (exitTriggerType === 'TAKE_PROFIT' && price > 0) {
                                limitPrice = price.toFixed(2);
                                orderType = 'LIMIT';
                            }
                            await snaptradeService.placeOptionOrder(position.user_id, accountId, osiTicker, 'SELL_TO_CLOSE', position.quantity, orderType, limitPrice);
                            this.fastify.log.info(`[MarketPoller] Live exit execution successful for position ${position.id} using ${orderType} order at limit price: ${limitPrice}.`);
                        }
                    }
                    catch (err) {
                        this.fastify.log.error(`[MarketPoller] Live exit execution failed for position ${position.id}: ${err.message}`);
                    }
                }
                else if (position.account_id === 'alpaca_paper') {
                    this.fastify.log.info(`[MarketPoller] Alpaca paper position exit triggered for position ${position.id} (${position.symbol}). Executing SELL via Alpaca...`);
                    try {
                        const { rows: settingsRows } = await this.fastify.pg.query("SELECT key, value FROM settings WHERE user_id = $1 AND key IN ('alpaca_key_id', 'alpaca_secret_key')", [position.user_id]);
                        const userSettings = settingsRows.reduce((acc, r) => {
                            acc[r.key] = r.value;
                            return acc;
                        }, {});
                        const alpacaKeyId = userSettings.alpaca_key_id?.trim() || '';
                        const alpacaSecretKey = userSettings.alpaca_secret_key?.trim() || '';
                        if (alpacaKeyId && alpacaSecretKey) {
                            const osiTicker = this.constructOSITicker(position.symbol, Number(position.strike_price), position.option_type, position.expiration_date);
                            // Use limit order with 3% slippage floor to prevent terrible exit fills
                            const useLimitExit = price > 0;
                            const exitLimitPrice = useLimitExit ? Number((price * 0.97).toFixed(2)) : undefined;
                            const exitPayload = {
                                symbol: osiTicker,
                                qty: position.quantity || 1,
                                side: 'sell',
                                type: useLimitExit ? 'limit' : 'market',
                                time_in_force: 'day'
                            };
                            if (exitLimitPrice) {
                                exitPayload.limit_price = exitLimitPrice.toString();
                            }
                            this.fastify.log.info(`[MarketPoller] Placing Alpaca ${exitPayload.type} exit for position ${position.id} (${osiTicker})${exitLimitPrice ? ` @ limit $${exitLimitPrice}` : ''}`);
                            const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
                                method: 'POST',
                                headers: {
                                    'APCA-API-KEY-ID': alpacaKeyId,
                                    'APCA-API-SECRET-KEY': alpacaSecretKey,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify(exitPayload)
                            });
                            if (!res.ok) {
                                const errText = await res.text();
                                throw new Error(`Alpaca paper exit failed: ${res.status} - ${errText}`);
                            }
                            this.fastify.log.info(`[MarketPoller] Alpaca paper exit execution successful for position ${position.id}.`);
                        }
                    }
                    catch (err) {
                        this.fastify.log.error(`[MarketPoller] Alpaca paper exit execution failed for position ${position.id}: ${err.message}`);
                    }
                }
                const updateResult = await this.fastify.pg.query(`UPDATE positions 
              SET status = $1, 
              loss_avoided = $2,
              realized_pnl = $3,
              notes = COALESCE(notes, '') || $4,
              updated_at = CURRENT_TIMESTAMP 
              WHERE id = $5 AND status = 'OPEN'`, [newStatus, lossAvoided, realizedPnl, ` [Closed via Underlying-Triggered ${exitTriggerType} Strategy]`, position.id]);
                if (updateResult.rowCount === 0) {
                    // Already updated or state mismatch, skip AI alert
                    return;
                }
                await this.fastify.pg.query('INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)', [position.id, exitTriggerType, exitTriggerType === 'TAKE_PROFIT' ? (position.suggested_take_profit_1 || position.take_profit_trigger) : (position.suggested_stop_loss || position.stop_loss_trigger), price]);
                // Generate AI Summary for the alert (Discord Message)
                let aiData = { summary: '', discord_message: '' };
                try {
                    aiData = await this.aiService.generateAlertSummary({
                        symbol: position.symbol,
                        type: position.option_type,
                        strike: position.strike_price,
                        expiration: position.expiration_date,
                        event: exitTriggerType === 'TAKE_PROFIT' ? 'TAKE_PROFIT_TRIGGERED' : 'STOP_LOSS_TRIGGERED',
                        price: price,
                        pnl: ((price - Number(position.entry_price)) / Number(position.entry_price) * 100).toFixed(2),
                        greeks: {
                            delta: greeks?.delta ?? position.delta,
                            theta: greeks?.theta ?? position.theta,
                            iv: iv ?? position.iv
                        },
                        underlying_price: underlyingPrice ?? position.underlying_price
                    });
                }
                catch (err) {
                    this.fastify.log.error(`[MarketPoller] AI Summary generation failed: ${err}`);
                }
                this.notifyN8n(position, price, realizedPnl, lossAvoided, exitTriggerType, aiData.summary, aiData.discord_message, greeks, iv);
            }
        }
        else if (engineResult.newHigh || engineResult.newStopLoss) {
            await this.fastify.pg.query(`UPDATE positions 
         SET trailing_high_price = COALESCE($1, trailing_high_price),
             stop_loss_trigger = COALESCE($2, stop_loss_trigger),
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3`, [engineResult.newHigh, engineResult.newStopLoss, position.id]);
        }
    }
    async notifyN8n(position, price, pnl, lossAvoided, type = 'STOP_LOSS', aiSummary, discordMessage, greeks, iv) {
        const username = position.username || 'Unknown';
        const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
        if (!N8N_WEBHOOK_URL)
            return;
        try {
            await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: type === 'TAKE_PROFIT' ? 'TAKE_PROFIT_TRIGGERED' : 'STOP_LOSS_TRIGGERED',
                    notification_type: 'alert',
                    username: username,
                    symbol: position.symbol,
                    ticker: position.symbol,
                    option_type: position.option_type,
                    strike_price: position.strike_price,
                    expiration_date: position.expiration_date,
                    price: price,
                    pnl: pnl,
                    loss_avoided: lossAvoided,
                    position_id: position.id,
                    ai_summary: aiSummary,
                    discord_message: `**[User: ${username}]**\n${discordMessage}`,
                    greeks: greeks,
                    iv: iv,
                    timestamp: new Date().toISOString()
                })
            });
        }
        catch (err) {
            this.fastify.log.error('[MarketPoller] Failed to notify n8n:', err.message);
        }
    }
    // ═══ Alpaca WebSocket Trade Updates Stream ═══════════════════════════════
    /**
     * Connects to Alpaca's paper trading WebSocket stream and subscribes
     * to trade_updates. On fill events, instantly syncs position status
     * in our database and broadcasts to the frontend.
     */
    async startAlpacaStream() {
        // Find any user with Alpaca credentials configured
        try {
            const { rows } = await this.fastify.pg.query(`SELECT s1.user_id, s1.value as key_id, s2.value as secret_key
         FROM settings s1
         JOIN settings s2 ON s1.user_id = s2.user_id AND s2.key = 'alpaca_secret_key'
         WHERE s1.key = 'alpaca_key_id' AND s1.value != '' AND s2.value != ''
         LIMIT 1`);
            if (rows.length === 0) {
                this.fastify.log.info('[AlpacaStream] No Alpaca credentials configured. Stream not started.');
                return;
            }
            const { key_id, secret_key } = rows[0];
            this.connectAlpacaStream(key_id.trim(), secret_key.trim());
        }
        catch (err) {
            this.fastify.log.error(`[AlpacaStream] Failed to load Alpaca credentials: ${err.message}`);
        }
    }
    connectAlpacaStream(keyId, secretKey) {
        if (this.alpacaWs) {
            try {
                this.alpacaWs.close();
            }
            catch (_) { }
        }
        this.fastify.log.info('[AlpacaStream] Connecting to wss://paper-api.alpaca.markets/stream...');
        const ws = new ws_1.default('wss://paper-api.alpaca.markets/stream');
        this.alpacaWs = ws;
        ws.on('open', () => {
            this.fastify.log.info('[AlpacaStream] Connected. Authenticating...');
            ws.send(JSON.stringify({
                action: 'authenticate',
                data: { key_id: keyId, secret_key: secretKey }
            }));
        });
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                // Authentication response
                if (msg.stream === 'authorization') {
                    if (msg.data?.status === 'authorized') {
                        this.fastify.log.info('[AlpacaStream] Authenticated. Subscribing to trade_updates...');
                        this.alpacaReconnectAttempts = 0;
                        this.alpacaStreamActive = true;
                        ws.send(JSON.stringify({
                            action: 'listen',
                            data: { streams: ['trade_updates'] }
                        }));
                    }
                    else {
                        this.fastify.log.error(`[AlpacaStream] Authentication failed: ${JSON.stringify(msg.data)}`);
                    }
                    return;
                }
                // Subscription confirmation
                if (msg.stream === 'listening') {
                    this.fastify.log.info(`[AlpacaStream] Subscribed to streams: ${JSON.stringify(msg.data?.streams)}`);
                    return;
                }
                // Trade update events
                if (msg.stream === 'trade_updates') {
                    await this.handleAlpacaTradeUpdate(msg.data);
                }
            }
            catch (parseErr) {
                this.fastify.log.error(`[AlpacaStream] Failed to parse message: ${parseErr.message}`);
            }
        });
        ws.on('error', (err) => {
            this.fastify.log.error(`[AlpacaStream] WebSocket error: ${err.message}`);
        });
        ws.on('close', (code, reason) => {
            this.alpacaStreamActive = false;
            this.fastify.log.warn(`[AlpacaStream] Connection closed (code: ${code}, reason: ${reason.toString()}). Scheduling reconnect...`);
            this.scheduleAlpacaReconnect(keyId, secretKey);
        });
    }
    scheduleAlpacaReconnect(keyId, secretKey) {
        if (this.alpacaReconnectTimer)
            clearTimeout(this.alpacaReconnectTimer);
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s, max 60s
        const delay = Math.min(60000, Math.pow(2, this.alpacaReconnectAttempts + 1) * 1000);
        this.alpacaReconnectAttempts++;
        this.fastify.log.info(`[AlpacaStream] Reconnecting in ${delay / 1000}s (attempt ${this.alpacaReconnectAttempts})...`);
        this.alpacaReconnectTimer = setTimeout(() => {
            this.connectAlpacaStream(keyId, secretKey);
        }, delay);
    }
    async handleAlpacaTradeUpdate(data) {
        const event = data?.event;
        const order = data?.order;
        if (!event || !order)
            return;
        const orderId = order.id;
        const orderSymbol = order.symbol; // OSI ticker
        const orderSide = order.side; // 'buy' or 'sell'
        const filledQty = Number(order.filled_qty || 0);
        const filledAvgPrice = Number(order.filled_avg_price || 0);
        const orderStatus = order.status;
        this.fastify.log.info(`[AlpacaStream] Trade update: ${event} | ${orderSymbol} | Side: ${orderSide} | Status: ${orderStatus} | Filled: ${filledQty} @ $${filledAvgPrice}`);
        switch (event) {
            case 'fill': {
                // Order fully filled
                if (orderSide === 'buy') {
                    // Entry fill — update the position's entry price with actual fill price
                    try {
                        await this.fastify.pg.query(`UPDATE positions SET entry_price = $1, current_price = $1, trailing_high_price = $1, updated_at = CURRENT_TIMESTAMP
               WHERE account_id = 'alpaca_paper' AND status = 'OPEN'
               AND notes LIKE $2`, [filledAvgPrice, `%${orderId}%`]);
                        this.fastify.log.info(`[AlpacaStream] Entry fill recorded: ${orderSymbol} @ $${filledAvgPrice}`);
                    }
                    catch (err) {
                        this.fastify.log.error(`[AlpacaStream] Failed to update entry fill: ${err.message}`);
                    }
                }
                else if (orderSide === 'sell') {
                    // Exit fill — close the position with actual exit price
                    try {
                        const { rows } = await this.fastify.pg.query(`SELECT id, entry_price, quantity, user_id FROM positions
               WHERE account_id = 'alpaca_paper' AND status = 'OPEN'
               AND symbol = $1
               ORDER BY created_at DESC LIMIT 1`, [orderSymbol.substring(0, 3)] // Extract root symbol (e.g., SPY, QQQ)
                        );
                        if (rows.length > 0) {
                            const pos = rows[0];
                            const realizedPnl = (filledAvgPrice - Number(pos.entry_price)) * Number(pos.quantity) * 100;
                            await this.fastify.pg.query(`UPDATE positions SET status = 'CLOSED', current_price = $1, exit_price = $1,
                 realized_pnl = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`, [filledAvgPrice, realizedPnl, pos.id]);
                            this.fastify.log.info(`[AlpacaStream] Exit fill recorded: ${orderSymbol} @ $${filledAvgPrice} | P&L: $${realizedPnl.toFixed(2)}`);
                            // Invalidate frontend caches
                            await this.redisClient.del(`USER_POSITIONS:${pos.user_id}`);
                            await this.redisClient.del(`USER_STATS:${pos.user_id}`);
                        }
                    }
                    catch (err) {
                        this.fastify.log.error(`[AlpacaStream] Failed to update exit fill: ${err.message}`);
                    }
                }
                // Broadcast to frontend
                this.broadcastToFrontend({ type: 'ALPACA_FILL', data: { event, symbol: orderSymbol, side: orderSide, price: filledAvgPrice, qty: filledQty } });
                break;
            }
            case 'partial_fill': {
                this.fastify.log.info(`[AlpacaStream] Partial fill: ${orderSymbol} ${filledQty} @ $${filledAvgPrice}`);
                this.broadcastToFrontend({ type: 'ALPACA_PARTIAL_FILL', data: { event, symbol: orderSymbol, side: orderSide, price: filledAvgPrice, qty: filledQty } });
                break;
            }
            case 'canceled':
            case 'rejected': {
                this.fastify.log.warn(`[AlpacaStream] Order ${event}: ${orderSymbol} | ID: ${orderId} | Reason: ${order.reject_reason || 'N/A'}`);
                this.broadcastToFrontend({ type: 'ALPACA_ORDER_EVENT', data: { event, symbol: orderSymbol, orderId, reason: order.reject_reason } });
                break;
            }
            default:
                this.fastify.log.debug(`[AlpacaStream] Unhandled event: ${event}`);
        }
    }
    broadcastToFrontend(message) {
        if (this.fastify.websocketServer) {
            const payload = JSON.stringify(message);
            this.fastify.websocketServer.clients.forEach((client) => {
                if (client.readyState === 1) {
                    client.send(payload);
                }
            });
        }
    }
}
exports.MarketPoller = MarketPoller;
//# sourceMappingURL=market-poller.js.map