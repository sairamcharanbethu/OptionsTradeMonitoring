const { Client } = require('pg');

async function migrate() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL not found in environment');
        process.exit(1);
    }

    const isCloud = connectionString.includes('aivencloud');
    const client = new Client({
        connectionString,
        ssl: isCloud ? { rejectUnauthorized: false } : undefined
    });

    try {
        console.log('Connecting to database...');
        await client.connect();
        console.log('Running migration...');
        await client.query('ALTER TABLE positions ADD COLUMN underlying_price DECIMAL(10, 2);');
        console.log('Migration successful: underlying_price column added.');
    } catch (err) {
        if (err.message.includes('already exists')) {
            console.log('Column underlying_price already exists, skipping.');
        } else {
            console.error('Migration failed:', err.message);
        }
    } finally {
        await client.end();
    }
}

migrate();
