
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the root .env file
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring',
    ssl: process.env.DATABASE_URL?.includes('render') ? { rejectUnauthorized: false } : undefined
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('Running Analysis Columns migration...');

        const queries = [
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS analyzed_support DECIMAL(10, 2);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS analyzed_resistance DECIMAL(10, 2);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS suggested_stop_loss DECIMAL(10, 2);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS suggested_take_profit_1 DECIMAL(10, 2);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS suggested_take_profit_2 DECIMAL(10, 2);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS analysis_data JSONB;`
        ];

        for (const query of queries) {
            await client.query(query);
            console.log(`Executed: ${query}`);
        }

        console.log('Migration complete.');
    } catch (err: any) {
        console.error('Migration failed:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
