
import fetch from 'node-fetch';
import pg from 'pg';
const { Pool } = pg;

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
        const response = await fetch('http://localhost:3001/api/ai/analyze', {
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
        } else {
            console.error('Failed:', response.status, response.statusText);
            const text = await response.text();
            console.error('Response:', text);
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        client.release();
        pool.end();
    }
}

verifyAI();
