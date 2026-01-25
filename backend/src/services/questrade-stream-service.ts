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

    public get isSocketConnected(): boolean {
        return this.isConnected;
    }
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
            // AND requires 'ids' to be present.
            const apiServer = token.api_server.replace(/\/$/, '');
            console.log(`[Stream] Allocating WebSocket port from ${apiServer}...`);

            // Gather IDs first
            const result = await (this.fastify as any).pg.query(
                "SELECT symbol, option_type, strike_price, expiration_date FROM positions WHERE status != 'CLOSED'"
            );

            const initialIds: number[] = [];

            // If we have positions, resolve their IDs
            if (result.rows.length > 0) {
                for (const pos of result.rows) {
                    const ticker = this.constructOSITicker(pos.symbol, Number(pos.strike_price), pos.option_type, pos.expiration_date);
                    const id = await this.resolveSymbolId(ticker);
                    if (id) initialIds.push(id);
                }
            }

            // If no positions, we MUST provide at least one ID to connect (Questrade Requirement).
            // Let's fallback to SPY.
            if (initialIds.length === 0) {
                console.log('[Stream] No active positions. Resolving SPY fallback...');
                const spyId = await this.resolveSymbolId('SPY');
                if (spyId) initialIds.push(spyId);
            }

            // If still empty (e.g. SPY lookup failed), connection will likely fail with 400.
            const idsParam = initialIds.join(',');
            console.log(`[Stream] Connecting with IDs: ${idsParam}`);

            const portRes = await axios.get(`${apiServer}/v1/markets/quotes?stream=true&mode=WebSocket&ids=${idsParam}`, {
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
            const wsUrl = `wss://${host}:${streamPort}/v1/markets/quotes?access_token=${token.access_token}`; // ids param might not be needed here if sent in step 1, but usually safer to re-send? 
            // Diagnostic script worked with 2-step. Handshake usually doesn't need params if step 1 did it?
            // Actually diagnostic successfully connected to port WITHOUT ids in the `wss://` url, 
            // but `startHeartbeat` re-syncs anyway.

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

        // Initial Subscription Sync is handled by the connection URL query params now.
        // We defer the next sync to the heartbeat loop.
        // this.syncSubscriptions();
    }

    private startHeartbeat() {
        // Refresh Lock every 10s
        // Sync Subscriptions every 60s
        if (this.pingInterval) clearInterval(this.pingInterval);

        let counter = 0;
        this.pingInterval = setInterval(async () => {
            counter++;
            await this.refreshLock();

            // Every 60 seconds (approx)
            if (counter % 6 === 0) {
                await this.syncSubscriptions();
            }
        }, 10000);
    }

    private async onMessage(data: WebSocket.Data) {
        try {
            const msg = JSON.parse(data.toString());

            // Handle Quotes
            if (msg.quotes instanceof Array) {
                msg.quotes.forEach((q: any) => {
                    this.emit('quote', q);
                });
            }

            // Handle Stream Errors
            if (msg.code) {
                if (msg.code === 1017) {
                    console.warn('[Stream] Token Invalid (1017). Forcing refresh...');
                    // Invalidate and refresh token
                    await this.qt.refreshToken();
                    this.cleanup();
                    this.scheduleReconnect(1000);
                    return;
                }
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

    // --- Helper for OSI Ticker ---
    private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
        try {
            let dateStr = '';
            if (expiration instanceof Date) {
                const year = expiration.getFullYear();
                const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
                const day = expiration.getDate().toString().padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            } else {
                dateStr = expiration.split('T')[0];
            }

            const parts = dateStr.split('-');
            if (parts.length !== 3) return symbol; // Fallback

            const YY = parts[0].slice(-2);
            const MM = parts[1].padStart(2, '0');
            const DD = parts[2].padStart(2, '0');
            const side = type === 'CALL' ? 'C' : 'P';
            const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');

            return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
        } catch (e) {
            return symbol;
        }
    }

    private async resolveSymbolId(ticker: string): Promise<number | null> {
        const CACHE_KEY = `SYMBOL_ID:${ticker}`;
        const cached = await redis.get(CACHE_KEY);
        if (cached) return parseInt(cached, 10);

        try {
            const id = await this.qt.getSymbolId(ticker);
            if (id) {
                await redis.set(CACHE_KEY, id.toString(), 86400); // 24h
            }
            return id;
        } catch (e) {
            return null;
        }
    }

    public async syncSubscriptions() {
        if (!this.isConnected) return;

        try {
            console.log('[Stream] Syncing active subscriptions...');
            const result = await (this.fastify as any).pg.query(
                "SELECT symbol, option_type, strike_price, expiration_date FROM positions WHERE status != 'CLOSED'"
            );

            const newIds = new Set<number>();

            for (const pos of result.rows) {
                // Construct Option Ticker
                const ticker = this.constructOSITicker(
                    pos.symbol,
                    Number(pos.strike_price),
                    pos.option_type,
                    pos.expiration_date
                );

                const id = await this.resolveSymbolId(ticker);
                if (id) newIds.add(id);
            }

            // Also include any explicitly requested IDs (via .subscribe method)
            this.activeSymbolIds.forEach(id => newIds.add(id));

            if (newIds.size === 0) return;

            // Convert to array
            const idsList = Array.from(newIds);

            // Check if different from current subscriptions to avoid spamming
            // Ideally we tracked what we SENT to WS. For now, we resubscribe to ensure sync.
            // Or we can simple send 'action: subscribe' which is additive/idempotent usually.

            console.log(`[Stream] Subscribing to ${idsList.length} symbols/options.`);
            this.updateSubscriptions(idsList);

            // Update local set
            this.activeSymbolIds = newIds;

        } catch (err: any) {
            console.error('[Stream] Failed to sync subscriptions:', err.message);
        }
    }

    private updateSubscriptions(ids: number[]) {
        if (!this.ws) return;
        // Sending comma-separated list of IDs is standard for some streamer modes
        // But let's stick to the command format we guessed, or try IDs string if 400.
        // Based on "GET ...?ids=..." working, maybe writing IDs to socket works?
        // Let's try standard JSON first.
        const msg = JSON.stringify({ action: 'subscribe', ids });
        this.ws.send(msg);

        // Also send "Raw" ids just in case (some WS endpoints take raw lines)
        // this.ws.send(ids.join(',')); 
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

