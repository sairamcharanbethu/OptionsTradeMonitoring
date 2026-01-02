"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fetch_1 = __importDefault(require("node-fetch"));
const pg_1 = __importDefault(require("pg"));
const { Pool } = pg_1.default;
const pool = new Pool({
    connectionString: 'postgres://user:password@localhost:5432/options_monitoring',
});
async function verifyAI() {
    const client = await pool.connect();
    try {
        // 1. Get a position ID
        const res = await client.query('SELECT id, symbol FROM positions WHERE status = \'OPEN\' LIMIT 1');
        if (res.rows.length === 0) {
            console.log('No open positions to test.');
            return;
        }
        const pos = res.rows[0];
        console.log(`Testing AI analysis for position ${pos.id} (${pos.symbol})...`);
        // 2. Call the AI endpoint
        const response = await (0, node_fetch_1.default)('http://localhost:3001/api/ai/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionId: pos.id })
        });
        if (response.ok) {
            const data = await response.json();
            console.log('--- AI Response ---');
            console.log('VERDICT:', data.verdict);
            console.log('REASONING:', data.analysis);
            console.log('Full Object:', data);
            console.log('-------------------');
        }
        else {
            console.error('Failed:', response.status, response.statusText);
            const text = await response.text();
            console.error('Response:', text);
        }
    }
    catch (error) {
        console.error('Error:', error);
    }
    finally {
        client.release();
        pool.end();
    }
}
verifyAI();
//# sourceMappingURL=verify-ai.js.map