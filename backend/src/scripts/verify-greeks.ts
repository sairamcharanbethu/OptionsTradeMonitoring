
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: 'postgres://user:password@localhost:5432/options_monitoring',
});

async function verifyGreeks() {
    const client = await pool.connect();
    try {
        console.log('Verifying Greeks data...');

        // Select positions that have updated price recently
        const res = await client.query(`
      SELECT symbol, delta, theta, gamma, vega, iv 
      FROM positions 
      WHERE status = 'OPEN' 
      ORDER BY updated_at DESC 
      LIMIT 1
    `);

        if (res.rows.length > 0) {
            const pos = res.rows[0];
            console.log('Found Position:', pos);

            if (pos.delta !== null && pos.theta !== null) {
                console.log('SUCCESS: Greeks are being populated!');
            } else {
                console.log('WARNING: Greeks are null. Might need to wait for next poll cycle.');
            }
        } else {
            console.log('No OPEN positions found to verify.');
        }

    } catch (err) {
        console.error('Verification failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

verifyGreeks();
