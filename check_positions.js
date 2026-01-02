
const { Client } = require('pg');
const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring',
    ssl: process.env.DATABASE_URL?.includes('aivencloud') ? { rejectUnauthorized: false } : undefined
});

async function run() {
    await client.connect();
    const res = await client.query("SELECT id, symbol, strike_price, expiration_date, current_price, updated_at, status FROM positions WHERE status IN ('OPEN', 'STOP_TRIGGERED') ORDER BY id DESC");
    console.log(JSON.stringify(res.rows, null, 2));
    await client.end();
}

run().catch(console.error);
