
const Fastify = require('fastify');
const postgres = require('@fastify/postgres');

async function run() {
    const fastify = Fastify();
    await fastify.register(postgres, {
        connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring',
        ssl: process.env.DATABASE_URL?.includes('aivencloud') ? { rejectUnauthorized: false } : undefined
    });

    const { MarketPoller } = require('./src/services/market-poller');
    const poller = new MarketPoller(fastify);

    console.log('Starting forced poll...');
    await poller.poll(true);
    console.log('Forced poll completed.');

    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
