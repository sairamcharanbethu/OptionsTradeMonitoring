
import { Client } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const NEW_TOKEN = 'G0mXYzDp--tnaaCMCNIILMgkL88EffL10';

async function update() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL missing');
        process.exit(1);
    }
    const client = new Client({ connectionString: dbUrl });
    try {
        await client.connect();
        await client.query(
            "UPDATE settings SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'questrade_refresh_token'",
            [NEW_TOKEN]
        );
        console.log('✅ Token updated successfully.');
    } catch (err) {
        console.error('Failed to update token:', err);
    } finally {
        await client.end();
    }
}
update();
