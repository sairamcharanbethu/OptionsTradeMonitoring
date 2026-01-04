import * as path from 'path';
import * as fs from 'fs';

function loadEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        const lines = envConfig.split(/\r?\n/);
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;
            const index = trimmedLine.indexOf('=');
            if (index > 0) {
                const key = trimmedLine.substring(0, index).trim();
                let value = trimmedLine.substring(index + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.substring(1, value.length - 1);
                }
                process.env[key] = value;
            }
        }
    }
}

loadEnv();

const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;

async function testBriefing() {
    if (!N8N_WEBHOOK_URL) {
        console.error('Error: N8N_ALERT_WEBHOOK_URL not found in .env file');
        process.exit(1);
    }

    const sampleData = {
        event: 'MORNING_BRIEFING',
        user_id: 'test_user_123',
        briefing: "Your portfolio is looking healthy with NVDA leading the gains at +45%. AAPL is slightly down but theta is manageable. Consider rolling MSFT as theta decay is accelerating.",
        discord_message: `🌅 **MORNING PORTFOLIO BRIEFING** 🌅\n\n**Overall Health:** ✅ Strong\n\n**Highlights:**\n- 🟢 **NVDA:** +45% (Hold)\n- 🟡 **AAPL:** -5% (Watch Theta)\n- 🔴 **MSFT:** -12% (Action: Roll recommended)\n\n**Next Steps:** Review MSFT expiration today. Market sentiment is bullish.\n\n⚡ [View Full Portfolio](https://your-app-url.com/dashboard) ⚡`,
        timestamp: new Date().toISOString()
    };

    console.log(`[TestScript] Sending Morning Briefing to n8n: ${N8N_WEBHOOK_URL}`);

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

testBriefing();
