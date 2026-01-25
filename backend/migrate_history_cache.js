require('dotenv').config({ path: '../.env' });
const { Client } = require('pg');

(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS stock_history_cache (
                id SERIAL PRIMARY KEY,
                symbol VARCHAR(20) UNIQUE NOT NULL,
                data JSONB NOT NULL,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Created stock_history_cache table');
    } catch (e) {
        console.error('Migration failed:', e.message);
    } finally {
        await client.end();
    }
})();
