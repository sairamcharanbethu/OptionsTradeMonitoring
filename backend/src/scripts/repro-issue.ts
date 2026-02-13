
import { Client } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';

// Load .env from backend root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

async function run() {
    console.log('--- Questrade 400 Repro Script ---');

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('Error: DATABASE_URL is not set');
        process.exit(1);
    }
    const client = new Client({ connectionString: dbUrl });

    try {
        await client.connect();

        // 1. Get Token
        const res = await client.query("SELECT value FROM settings WHERE key = 'questrade_refresh_token' ORDER BY updated_at DESC LIMIT 1");
        if (res.rows.length === 0) {
            console.error('No token found.');
            process.exit(1);
        }
        const refreshToken = res.rows[0].value;
        const tokenUrl = `https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${refreshToken}`;

        let tokenData: any;
        try {
            const authRes = await axios.get(tokenUrl);
            tokenData = authRes.data;
            console.log('✅ Token Refreshed');
            // Update DB
            await client.query("UPDATE settings SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'questrade_refresh_token'", [tokenData.refresh_token]);
        } catch (err: any) {
            console.error('Auth Failed:', err.message);
            process.exit(1);
        }

        const httpsUrl = tokenData.api_server.replace(/\/$/, '');
        // const validIds = "34987,12345"; // SPY + Dummy
        const validIds = "34987"; // SPY

        // TEST 1: WITHOUT stream=true (Expect 400)
        console.log(`\n[Test 1] GET ...?mode=WebSocket&ids=${validIds} (NO stream=true)`);
        try {
            const res1 = await axios.get(`${httpsUrl}/v1/markets/quotes?mode=WebSocket&ids=${validIds}`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
                validateStatus: () => true // Don't throw
            });
            console.log(`Result: ${res1.status} ${res1.statusText}`);
            if (res1.data) console.log('Body:', JSON.stringify(res1.data));
        } catch (e: any) {
            console.log('Error:', e.message);
        }

        // TEST 2: WITH stream=true (Expect 200)
        console.log(`\n[Test 2] GET ...?stream=true&mode=WebSocket&ids=${validIds}`);
        try {
            const res2 = await axios.get(`${httpsUrl}/v1/markets/quotes?stream=true&mode=WebSocket&ids=${validIds}`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
                validateStatus: () => true
            });
            console.log(`Result: ${res2.status} ${res2.statusText}`);
            if (res2.data) console.log('Body:', JSON.stringify(res2.data));
        } catch (e: any) {
            console.log('Error:', e.message);
        }

    } catch (err: any) {
        console.error('System Error:', err.message);
    } finally {
        await client.end();
    }
}

run();
