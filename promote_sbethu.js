const { Client } = require('pg');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

client.connect()
    .then(() => client.query("UPDATE users SET role = 'ADMIN' WHERE username = 'sbethu'"))
    .then(res => {
        console.log('✓ User sbethu promoted to ADMIN');
        console.log('Rows affected:', res.rowCount);
        return client.end();
    })
    .catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
