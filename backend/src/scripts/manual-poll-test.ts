
// Mock classes
class MockRedis {
    async setNX(key: string, val: string, ttl: number) { console.log('[MockRedis] setNX', key); return true; }
    async get(key: string) { console.log('[MockRedis] get', key); return null; }
    async set(key: string, val: string, ttl: number) { console.log('[MockRedis] set', key, val); }
}

const mockPositions = [
    {
        id: 1,
        symbol: 'AAPL',
        option_type: 'CALL',
        strike_price: 150,
        expiration_date: '2025-01-01',
        user_id: 1,
        status: 'OPEN',
        entry_price: 10.0,
        stop_loss_trigger: 5.0,
        quantity: 1
    }
];

const mockQuestrade = {
    getSymbolId: async (ticker: string) => { console.log('[MockQT] getSymbolId', ticker); return 12345; },
    getOptionQuote: async (id: number) => {
        console.log('[MockQT] getOptionQuote', id);
        return {
            symbolId: id,
            lastTradePrice: 12.5,
            bidPrice: 12.4,
            askPrice: 12.6,
            volatility: 0.25,
            delta: 0.5,
            gamma: 0.1,
            theta: -0.05,
            vega: 0.02,
            rho: 0.01,
            underlyingId: 999
        };
    },
    getQuote: async (ids: number[]) => {
        console.log('[MockQT] getQuote (Underlying)', ids);
        return [{ lastTradePrice: 155.0 }];
    }
};

const mockFastify: any = {
    log: {
        info: (msg: string) => console.log('[INFO]', msg),
        error: (msg: string) => console.error('[ERROR]', msg),
        warn: (msg: string) => console.warn('[WARN]', msg),
        debug: (msg: string) => console.debug('[DEBUG]', msg),
    },
    pg: {
        query: async (sql: string, params?: any[]) => {
            if (sql.includes('SELECT p.*')) return { rows: mockPositions };
            if (sql.includes('UPDATE positions')) { console.log('[PG] UPDATE POSITIONS', params); return { rowCount: 1 }; }
            if (sql.includes('INSERT INTO price_history')) { console.log('[PG] INSERT PRICE HISTORY', params); return { rowCount: 1 }; }
            return { rows: [] };
        }
    },
    questrade: mockQuestrade
};

import { MarketPoller } from '../services/market-poller';

async function runTest() {
    console.log('--- Starting Manual Poll Test ---');
    const poller = new MarketPoller(mockFastify, new MockRedis());

    // Force poll (bypass market hours)
    await poller.poll(true);
    console.log('--- Test Completed ---');
}

runTest();
