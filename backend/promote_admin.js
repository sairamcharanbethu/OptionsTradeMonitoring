const pg = require('pg');

const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function promoteUser() {
    try {
        await client.connect();
        console.log('Connected to cloud database');

        const result = await client.query(
            "UPDATE users SET role = 'ADMIN' WHERE username = 'sbethu'"
        );

        console.log('✓ User sbethu promoted to ADMIN');
        console.log('Rows affected:', result.rowCount);

        await client.end();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

promoteUser();
