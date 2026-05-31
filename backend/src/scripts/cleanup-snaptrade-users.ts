import { Client } from 'pg';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

async function run() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('Error: DATABASE_URL not set in .env');
        process.exit(1);
    }
    const client = new Client({ connectionString: dbUrl });
    try {
        await client.connect();
        
        const res = await client.query("SELECT key, value FROM settings WHERE key IN ('snaptrade_client_id', 'snaptrade_consumer_key')");
        const settings = res.rows.reduce((acc: any, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});

        const clientId = settings.snaptrade_client_id?.trim();
        const consumerKey = settings.snaptrade_consumer_key?.trim();

        if (!clientId || !consumerKey) {
            console.error('SnapTrade Client ID or Consumer Key not configured in settings DB.');
            process.exit(1);
        }

        console.log(`Connecting to SnapTrade with Client ID: "${clientId}"...`);
        const snaptrade = new Snaptrade({
            clientId,
            consumerKey
        });

        console.log('Listing registered users...');
        const usersRes = await snaptrade.authentication.listSnapTradeUsers();
        console.log('Registered Users on SnapTrade:', usersRes.data);

        if (usersRes.data && Array.isArray(usersRes.data) && usersRes.data.length > 0) {
            console.log(`Found ${usersRes.data.length} registered users. Deleting them to clean up personal key...`);
            for (const user of usersRes.data) {
                const idToDelete = typeof user === 'string' ? user : (user.userId || user.id || user.user_id);
                if (idToDelete) {
                    console.log(`Deleting user: ${idToDelete}...`);
                    await snaptrade.authentication.deleteSnapTradeUser({ userId: idToDelete });
                    console.log(`Successfully queued ${idToDelete} for deletion.`);
                }
            }
            console.log('All existing users queued for deletion!');
        } else {
            console.log('No registered users found.');
        }

    } catch (err: any) {
        console.error('Error occurred:', err.message);
        if (err.responseBody) {
            console.error('API Response Body:', JSON.stringify(err.responseBody, null, 2));
        }
    } finally {
        await client.end();
    }
}

run();
