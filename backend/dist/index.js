"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const postgres_1 = __importDefault(require("@fastify/postgres"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const pg_1 = require("pg");
const positions_1 = require("./routes/positions");
const market_data_1 = require("./routes/market-data");
const market_1 = require("./routes/market");
const ai_1 = require("./routes/ai");
const settings_1 = require("./routes/settings");
const jwt_1 = __importDefault(require("@fastify/jwt"));
const auth_1 = __importDefault(require("./routes/auth"));
const admin_1 = require("./routes/admin");
const fastify = (0, fastify_1.default)({
    logger: {
        level: 'warn'
    },
    disableRequestLogging: true
});
const testConnection = async (connectionString, label) => {
    const isCloud = connectionString.includes('aivencloud');
    const client = new pg_1.Client({
        connectionString,
        connectionTimeoutMillis: 5000,
        ssl: isCloud ? { rejectUnauthorized: false } : undefined
    });
    try {
        console.log(`[Database] Testing connection to ${label}...`);
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        console.log(`[Database] Success: Connected to ${label}`);
        return true;
    }
    catch (err) {
        console.error(`[Database] Failed to connect to ${label}: ${err.message}`);
        return false;
    }
};
const start = async () => {
    try {
        let activeDbUrl = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring';
        const backupDbUrl = process.env.BACKUP_DATABASE_URL;
        // 1. Try Primary
        const primarySuccess = await testConnection(activeDbUrl, 'Primary');
        if (!primarySuccess) {
            if (backupDbUrl) {
                console.warn('[Database] Primary failed. Attempting Backup...');
                const backupSuccess = await testConnection(backupDbUrl, 'Backup');
                if (backupSuccess) {
                    activeDbUrl = backupDbUrl;
                    console.warn('[Database] SWITCHED TO BACKUP DATABASE.');
                }
                else {
                    throw new Error('Both Primary and Backup databases failed.');
                }
            }
            else {
                throw new Error('Primary database failed and no backup configured.');
            }
        }
        // Log final choice (masking creds)
        console.log(`[System] Active Database Host: ${activeDbUrl.includes('@') ? activeDbUrl.split('@')[1] : 'localhost'}`);
        await fastify.register(postgres_1.default, {
            connectionString: activeDbUrl,
            ssl: activeDbUrl.includes('aivencloud') ? { rejectUnauthorized: false } : undefined,
            max: 20,
            idleTimeoutMillis: 30000
        });
        await fastify.register(cors_1.default, {
            origin: true
        });
        // Swagger/OpenAPI configuration
        await fastify.register(swagger_1.default, {
            openapi: {
                openapi: '3.0.0',
                info: {
                    title: 'Options Trade Monitoring API',
                    description: 'API for tracking and monitoring options trading positions with real-time price updates, alerts, and portfolio analytics.',
                    version: '1.0.0'
                },
                // Empty servers array = Swagger uses relative URLs (works on any host/port)
                servers: [],
                components: {
                    securitySchemes: {
                        bearerAuth: {
                            type: 'http',
                            scheme: 'bearer',
                            bearerFormat: 'JWT',
                            description: 'Enter your JWT token obtained from /api/auth/signin'
                        }
                    }
                },
                tags: [
                    { name: 'Auth', description: 'Authentication endpoints' },
                    { name: 'Positions', description: 'Options positions management' },
                    { name: 'Settings', description: 'User settings' },
                    { name: 'Admin', description: 'Admin operations' },
                    { name: 'Market', description: 'Market data and status' },
                    { name: 'AI', description: 'AI-powered analysis' }
                ]
            }
        });
        await fastify.register(swagger_ui_1.default, {
            routePrefix: '/docs',
            uiConfig: {
                docExpansion: 'list',
                deepLinking: true,
                persistAuthorization: true
            }
        });
        if (!process.env.JWT_SECRET) {
            throw new Error('JWT_SECRET environment variable is required');
        }
        await fastify.register(jwt_1.default, {
            secret: process.env.JWT_SECRET
        });
        fastify.decorate('authenticate', async (request, reply) => {
            try {
                await request.jwtVerify();
            }
            catch (err) {
                reply.send(err);
            }
        });
        fastify.register(auth_1.default, { prefix: '/api/auth' });
        fastify.register(admin_1.adminRoutes, { prefix: '/api/admin' });
        fastify.register(positions_1.positionRoutes, { prefix: '/api/positions' });
        fastify.register(market_data_1.marketDataRoutes, { prefix: '/api/market-data' });
        fastify.register(market_1.marketRoutes, { prefix: '/api/market' });
        fastify.register(ai_1.aiRoutes, { prefix: '/api/ai' });
        fastify.register(settings_1.settingsRoutes, { prefix: '/api/settings' });
        fastify.get('/health', async () => {
            return { status: 'ok' };
        });
        // Root route
        fastify.get('/', async () => {
            return { message: 'Options Monitoring API' };
        });
        const { QuestradeService } = await Promise.resolve().then(() => __importStar(require('./services/questrade-service')));
        const questrade = new QuestradeService(fastify);
        fastify.decorate('questrade', questrade);
        // Initialize poller BEFORE listen
        const { MarketPoller } = await Promise.resolve().then(() => __importStar(require('./services/market-poller')));
        const poller = new MarketPoller(fastify);
        fastify.decorate('poller', poller);
        // --- WebSocket & Streaming Setup ---
        await fastify.register(Promise.resolve().then(() => __importStar(require('@fastify/websocket'))));
        const { redis } = await Promise.resolve().then(() => __importStar(require('./lib/redis')));
        const { QuestradeStreamService } = await Promise.resolve().then(() => __importStar(require('./services/questrade-stream-service')));
        const streamer = new QuestradeStreamService(fastify);
        // Broadcast real-time quotes to all connected frontend clients
        streamer.on('quote', async (quote) => {
            // Enrich with Symbol if missing
            if (!quote.symbol && quote.symbolId) {
                const ticker = await redis.get(`SYMBOL_NAME:${quote.symbolId}`);
                if (ticker)
                    quote.symbol = ticker;
            }
            if (fastify.websocketServer) {
                fastify.websocketServer.clients.forEach((client) => {
                    if (client.readyState === 1) { // WebSocket.OPEN
                        client.send(JSON.stringify({ type: 'PRICE_UPDATE', data: quote }));
                    }
                });
            }
            // Feed data into Poller for Stop Loss checks (Optimization: Don't wait for poll cycle)
            // poller.onExternalPriceUpdate(quote); // TODO: Implement in MarketPoller
        });
        fastify.decorate('streamer', streamer);
        // Public WebSocket endpoint
        fastify.get('/api/ws', { websocket: true }, (connection, req) => {
            connection.socket.on('message', (message) => {
                // Handle subscriptions from frontend if we want selective streaming
                // For now, we broadcast everything we have.
            });
        });
        const port = Number(process.env.PORT) || 3001;
        await fastify.listen({ port, host: '0.0.0.0' });
        // Start background services
        poller.start();
        streamer.start();
        console.log(`Server listening on http://localhost:${port}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
//# sourceMappingURL=index.js.map