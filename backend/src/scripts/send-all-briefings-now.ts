import Fastify from 'fastify';
import postgres from '@fastify/postgres';
import * as path from 'path';
import * as fs from 'fs';
import { MarketPoller } from '../services/market-poller';

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

const fastify = Fastify();

async function run() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL not found');
        process.exit(1);
    }

    console.log('[OneTimeBrief] Initializing DB connection...');
    await fastify.register(postgres, {
        connectionString: dbUrl,
        ssl: dbUrl.includes('aivencloud') ? { rejectUnauthorized: false } : undefined
    });

    await fastify.ready();
    console.log('[OneTimeBrief] DB Ready. Initializing MarketPoller...');

    const poller = new MarketPoller(fastify as any);

    console.log('[OneTimeBrief] Starting one-time briefing for all users (ignoring settings)...');
    await poller.sendMorningBriefings(true);

    console.log('[OneTimeBrief] DONE.');
    await fastify.close();
    process.exit(0);
}

run().catch(err => {
    console.error('[OneTimeBrief] CRITICAL ERROR:', err);
    process.exit(1);
});
