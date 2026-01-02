
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: 'postgres://user:password@localhost:5432/options_monitoring',
});

async function inspect() {
    const client = await pool.connect();
    try {
        const res = await client.query(`SELECT * FROM positions WHERE symbol = 'NVDA'`);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
        pool.end();
    }
}

inspect();
