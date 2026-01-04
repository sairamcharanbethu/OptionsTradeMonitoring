import * as path from 'path';
import * as fs from 'fs';

/**
 * Robust .env parser for scripts without dependencies
 */
function loadEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    console.log(`[TestScript] Checking for .env at: ${envPath}`);

    if (!fs.existsSync(envPath)) {
        console.error(`[TestScript] .env file not found at ${envPath}`);
        return;
    }

    const envConfig = fs.readFileSync(envPath, 'utf8');
    const lines = envConfig.split(/\r?\n/);

    let count = 0;
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;

        const index = trimmedLine.indexOf('=');
        if (index > 0) {
            const key = trimmedLine.substring(0, index).trim();
            let value = trimmedLine.substring(index + 1).trim();

            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.substring(1, value.length - 1);
            }

            process.env[key] = value;
            count++;
        }
    }
    console.log(`[TestScript] Loaded ${count} environment variables.`);
}

loadEnv();

const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;

async function testN8n() {
    if (!N8N_WEBHOOK_URL) {
        console.error('Error: N8N_ALERT_WEBHOOK_URL not found in .env file');
        console.log('Available process.env keys:', Object.keys(process.env).filter(k => k.includes('N8N') || k.includes('WEBHOOK')));
        process.exit(1);
    }

    const sampleData = {
        event: 'STOP_LOSS_TRIGGERED',
        symbol: 'AAPL',
        ticker: 'AAPL',
        option_type: 'CALL',
        strike_price: 150.00,
        expiration_date: '2026-06-19',
        price: 150.25,
        pnl: 450.00,
        loss_avoided: 125.50,
        position_id: 9999,
        ai_summary: "AAPL is down 50% with only 8 days left. Theta decay is accelerating at -$0.15/day, giving only an 18% chance of profit. Cut the loss now to preserve remaining capital for better opportunities.",
        discord_message: `🚨 **TRADE ALERT: AAPL CALL $150.00 (2026-06-19)** 🚨\n\n**Action:** STOP LOSS TRIGGERED\n**PnL:** +$450.00 (3.1%)\n**Analysis:** AAPL is approaching expiration with high theta decay. AI recommends closing now.\n\n**CALL TO ACTION:** ⚡ [Click here to Close Position](https://your-app-url.com/positions/9999) ⚡`,
        timestamp: new Date().toISOString()
    };

    console.log(`[TestScript] Sending FINAL LIVE sample data to n8n: ${N8N_WEBHOOK_URL}`);
    console.log('[TestScript] Sample Data:', JSON.stringify(sampleData, null, 2));

    try {
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sampleData)
        });

        console.log('[TestScript] Response Status:', response.status);
        const text = await response.text();
        console.log('[TestScript] Response Data:', text);
    } catch (error: any) {
        console.error('[TestScript] Error sending request to n8n:', error.message);
    }
}

testN8n();
