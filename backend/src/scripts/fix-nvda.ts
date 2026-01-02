
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: 'postgres://user:password@localhost:5432/options_monitoring',
});

async function fix() {
    const client = await pool.connect();
    try {
        console.log('Fixing NVDA expiration date...');
        await client.query(`UPDATE positions SET expiration_date = '2026-03-20' WHERE symbol = 'NVDA'`);
        console.log('Update complete.');
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
        pool.end();
    }
}

fix();
