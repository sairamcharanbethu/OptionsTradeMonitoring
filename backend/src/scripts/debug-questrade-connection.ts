
import { Client } from 'pg';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';

console.log("HELLO STARTING SCRIPT v200");
// Load .env from backend root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

async function run() {
    console.log('--- Questrade HTTP Stream Mode Test ---');

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('Error: DATABASE_URL is not set in .env');
        process.exit(1);
    }
    const client = new Client({ connectionString: dbUrl });

    try {
        await client.connect();

        // 1. Fetch Refresh Token
        const res = await client.query("SELECT value FROM settings WHERE key = 'questrade_refresh_token' ORDER BY updated_at DESC LIMIT 1");
        if (res.rows.length === 0) {
            console.error('[DB] No questrade_refresh_token found.');
            process.exit(1);
        }

        const refreshToken = res.rows[0].value;
        console.log('[Auth] Refreshing Token...');

        // 2. Refresh Token
        const tokenUrl = `https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${refreshToken}`;

        let tokenData: any;
        try {
            const authRes = await axios.get(tokenUrl);
            tokenData = authRes.data;
            console.log('✅ [Auth] Success!');
            await client.query("UPDATE settings SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'questrade_refresh_token'", [tokenData.refresh_token]);
            console.log('✅ [DB] Token Updated.');

        } catch (err: any) {
            console.error('❌ [Auth] Failed:', err.response?.data || err.message);
            process.exit(1);
        }

        const httpsUrl = tokenData.api_server.replace(/\/$/, '');

        // 2a. Resolve a valid Symbol ID (SPY)
        let validId = 34987; // Known valid from previous run

        // TEST 1: HTTP Streaming with mode=WebSocket
        console.log(`\n[Test] HTTP GET ...?stream=true&ids=${validId}&mode=WebSocket`);
        try {
            const streamRes = await axios.get(`${httpsUrl}/v1/markets/quotes?stream=true&ids=${validId}&mode=WebSocket`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
                responseType: 'stream'
            });
            console.log(`✅ [Test] Success! Status: ${streamRes.status}`);

            // accumulate data
            let buffer = '';
            (streamRes.data as any).on('data', (d: any) => buffer += d.toString());

            await new Promise(r => setTimeout(r, 1000));
            (streamRes.data as any).destroy();

            try {
                const json = JSON.parse(buffer);
                if (json.streamPort) {
                    console.log(`✅ [Port] Received Allocation: ${json.streamPort}`);

                    const urlNoProto = httpsUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
                    const wsPortUrl = `wss://${urlNoProto}:${json.streamPort}/v1/markets/quotes?access_token=${tokenData.access_token}`; // &mode=WebSocket?

                    console.log(`[WS-Step2] Connecting to ${wsPortUrl}...`);
                    const ws = new WebSocket(wsPortUrl, {
                        headers: { 'User-Agent': 'OptionsTradeMonitoring/1.0', 'Origin': 'https://my.questrade.com' }
                    });

                    ws.on('open', () => { console.log('✅✅✅ [WS-Step2] CONNECTED TO DYNAMIC PORT!'); ws.close(); });
                    ws.on('error', (e) => console.log(`❌ [WS-Step2] Error: ${e.message}`));

                    await new Promise(r => setTimeout(r, 5000));
                }
            } catch (e: any) {
                console.log('Failed to parse port response:', e.message, buffer);
            }
        } catch (err: any) {
            console.log(`❌ [Test] Failed: ${err.message}`);
            if (err.response) console.log('   Body:', JSON.stringify(err.response.data)); // Stream might prevent body read?
        }

    } catch (err: any) {
        console.error('[System] Error:', err.message);
    } finally {
        await client.end();
        // Force exit after 5s
        setTimeout(() => process.exit(0), 5000);
    }
}

run();
