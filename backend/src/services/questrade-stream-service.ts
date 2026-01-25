import WebSocket from 'ws';
import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';
import { QuestradeService } from './questrade-service';
import { redis } from '../lib/redis';
import axios from 'axios';

export class QuestradeStreamService extends EventEmitter {
    private fastify: FastifyInstance;
    private ws: WebSocket | null = null;
    private qt: QuestradeService;
    private activeSymbolIds: Set<number> = new Set();
    private isConnected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_DELAY = 60000;
    private readonly LOCK_KEY = 'QSTREAM_MASTER_LOCK';

    constructor(fastify: FastifyInstance) {
        super(); // Inherit EventEmitter
        this.fastify = fastify;
        this.qt = (fastify as any).questrade;
    }

    async start() {
        this.attemptConnection();
    }
    private async attemptConnection() {
        // 1. Check Distributed Lock (Am I the master?)
        // Simple lock: Set with NX and EX (expiry). Refresh often.
        // For now, let's just try to acquire.
        const acquired = await this.acquireLock();
        if (!acquired) {
            console.log('[Stream] Another instance is the stream master. Standby mode.');
            this.scheduleReconnect(10000); // Check again in 10s
            return;
        }

        try {
            const token = await this.qt.getActiveToken();
            if (!token) {
                console.warn('[Stream] No token available. Retrying...');
                this.scheduleReconnect(5000);
                return;
            }

            // 1. Get Allocated Port via HTTP
            // Note: Questrade requires mode=WebSocket to trigger port allocation
            // The API server URL usually ends in /, remove it.
            const apiServer = token.api_server.replace(/\/$/, '');
            console.log(`[Stream] Allocating WebSocket port from ${apiServer}...`);

            const portRes = await axios.get(`${apiServer}/v1/markets/quotes?mode=WebSocket`, {
                headers: { Authorization: `Bearer ${token.access_token}` }
            });

            if (!(portRes.data as any) || !(portRes.data as any).streamPort) {
                throw new Error('Failed to allocate stream port: ' + JSON.stringify(portRes.data));
            }

            const streamPort = (portRes.data as any).streamPort;
            console.log(`[Stream] Port allocated: ${streamPort}`);

            // 2. Connect to Allocated Port
            // Construct URL: wss://<host>:<port>/v1/markets/quotes?access_token=...
            const host = apiServer.replace(/^https:\/\//, '');
            const wsUrl = `wss://${host}:${streamPort}/v1/markets/quotes?access_token=${token.access_token}`;

            console.log(`[Stream] Connecting to ${wsUrl} ...`);

            // Questrade often requires User-Agent header and sometimes Origin
            this.ws = new WebSocket(wsUrl, {
                headers: {
                    'User-Agent': 'OptionsTradeMonitoring/1.0',
                    'Origin': 'https://my.questrade.com'
                }
            });

            this.ws.on('open', this.onOpen.bind(this));
            this.ws.on('message', this.onMessage.bind(this));
            this.ws.on('error', this.onError.bind(this));
            this.ws.on('close', this.onClose.bind(this));

        } catch (err: any) {
            console.error('[Stream] Connection setup failed:', err.message);
            if (err.response) console.error('   API Response:', JSON.stringify(err.response.data));
            this.scheduleReconnect(5000);
        }
    }

    private onOpen() {
        console.log('[Stream] WebSocket Connected!');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();

        // Resubscribe to existing symbols
        if (this.activeSymbolIds.size > 0) {
            this.updateSubscriptions(Array.from(this.activeSymbolIds));
        }
    }

    private onMessage(data: WebSocket.Data) {
        try {
            const msg = JSON.parse(data.toString());

            // Handle Quotes
            if (msg.quotes instanceof Array) {
                msg.quotes.forEach((q: any) => {
                    this.emit('quote', q);
                });
            }

            // Handle Stream Errors
            if (msg.code && msg.message) {
                console.warn('[Stream] API Message:', msg);
            }

        } catch (err) {
            // Ignore ping/pong or non-json
        }
    }

    private onError(err: Error) {
        console.error('[Stream] WebSocket Error:', err.message);
    }

    private onClose(code: number, reason: string) {
        console.log(`[Stream] Disconnected (${code}): ${reason}`);
        this.cleanup();
        this.scheduleReconnect();
    }

    private cleanup() {
        this.isConnected = false;
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws = null;
        }
        // Release lock immediately so we (or others) can reconnect immediately
        redis.del(this.LOCK_KEY).catch(err => console.error('[Stream] Failed to release lock:', err));
    }

    private scheduleReconnect(delay?: number) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        const ms = delay || Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);
        console.log(`[Stream] Reconnecting in ${ms}ms...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.attemptConnection();
        }, ms);
    }

    private startHeartbeat() {
        // Refresh Lock every 10s
        this.pingInterval = setInterval(async () => {
            await this.refreshLock();
            // Optional: Send ping frame to WS if supported
            // if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
        }, 10000);
    }

    // --- External API ---

    public subscribe(symbolIds: number[]) {
        symbolIds.forEach(id => this.activeSymbolIds.add(id));
        if (this.isConnected) {
            this.updateSubscriptions(symbolIds); // Additivie? Questrade usually wants full list or add/remove commands.
            // Assuming simple stream mode usually implies sending the list of IDs desired.
            // Or standard REST subscription logic? 
            // WebSocket mostly PUSHES what you asked for.
            // Let's assume we send a JSON frame: { type: "setup", ids: [...] } or similar.
            // Actually Questrade usually streams quotes for requested IDs via GET, but WS might need a command.
            // Fallback: If WS is strictly for Notifications, we might be wrong. 
            // But typically 'v1/markets/quotes' in WS mode accepts text frames specifying IDs.
            // Let's send a comma-separated list or JSON.
            // Since documentation is 403, we rely on standard practice: send JSON.
        }
    }

    private updateSubscriptions(ids: number[]) {
        if (!this.ws) return;
        // Questrade WS Example Command (Hypothetical but standard):
        // { "action": "subscribe", "ids": [123, 456] }
        // Or simpler: just the string of IDs?
        // Let's try sending standard JSON payload.
        // NOTE: If Questrade streaming doesn't support upstream commands, 
        // we might have to use the HTTP endpoint to POST subscriptions to a stream port.
        // BUT we will assume standard WS capability.
        const msg = JSON.stringify({ action: 'subscribe', ids });
        this.ws.send(msg);
    }

    // --- Redis Locking ---
    private async acquireLock(): Promise<boolean> {
        // NX = Only set if not exists, EX = expire in 15s
        return await redis.setNX(this.LOCK_KEY, 'LOCKED', 15);
    }

    private async refreshLock() {
        // Extend lock TTL
        await redis.expire(this.LOCK_KEY, 15);
    }
}

