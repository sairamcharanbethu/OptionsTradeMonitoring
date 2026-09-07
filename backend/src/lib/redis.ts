import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

class RedisClient {
    private client: Redis | null = null;
    private isConnected = false;

    constructor() {
        if (process.env.NODE_ENV === 'test') {
            return;
        }
        this.connect();
    }

    private connect() {
        try {
            this.client = new Redis(REDIS_URL, {
                retryStrategy: (times) => {
                    // Retry connection with backoff, max 5 seconds
                    const delay = Math.min(times * 50, 5000);
                    return delay;
                },
                maxRetriesPerRequest: 1 // Don't block requests too long if down
            });

            this.client.on('connect', () => {
                console.log('[Redis] Connected successfully');
                this.isConnected = true;
            });

            this.client.on('error', (err) => {
                console.error('[Redis] Connection error:', err.message);
                this.isConnected = false;
            });

            this.client.on('close', () => {
                this.isConnected = false;
            });

        } catch (err) {
            console.error('[Redis] Initialization failed:', err);
        }
    }

    // Fail-open get
    async get(key: string): Promise<string | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await this.client.get(key);
        } catch (err) {
            // Ignore error, return null (cache miss)
            return null;
        }
    }

    // Fail-open set
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            if (ttlSeconds) {
                await this.client.set(key, value, 'EX', ttlSeconds);
            } else {
                await this.client.set(key, value);
            }
        } catch (err) {
            // Ignore
        }
    }

    // Atomic Set-if-not-exists for locking
    async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        if (!this.isConnected || !this.client) return false;
        try {
            const result = await (this.client as any).set(key, value, 'NX', 'EX', ttlSeconds);
            return result === 'OK';
        } catch (err) {
            return false;
        }
    }

    isReady(): boolean {
        return this.isConnected && Boolean(this.client);
    }

    async quit() {
        if (this.client) {
            await this.client.quit();
        }
    }

    // Fail-open del
    async del(key: string): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            await this.client.del(key);
        } catch (err) {
            // Ignore
        }
    }

    async delIfValue(key: string, expectedValue: string): Promise<boolean> {
        if (!this.isConnected || !this.client) return false;
        try {
            const result = await this.client.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1,
                key,
                expectedValue
            );
            return result === 1;
        } catch (err) {
            return false;
        }
    }

    async expire(key: string, seconds: number): Promise<boolean> {
        if (!this.isConnected || !this.client) return false;
        try {
            // ioredis returns 1 if timeout was set, 0 if key does not exist
            const res = await this.client.expire(key, seconds);
            return res === 1;
        } catch (err) {
            return false;
        }
    }

    async incr(key: string, ttlSeconds?: number): Promise<number | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            const value = await this.client.incr(key);
            if (ttlSeconds && value === 1) await this.client.expire(key, ttlSeconds);
            return value;
        } catch (err) {
            return null;
        }
    }

    async lpush(key: string, value: string): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            await this.client.lpush(key, value);
        } catch (err) {
            // Ignore
        }
    }

    async rpop(key: string): Promise<string | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await this.client.rpop(key);
        } catch (err) {
            return null;
        }
    }

    async llen(key: string): Promise<number | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await this.client.llen(key);
        } catch (err) {
            return null;
        }
    }

    async sadd(key: string, value: string): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            await this.client.sadd(key, value);
        } catch (err) {
            // Ignore
        }
    }

    async smembers(key: string): Promise<string[]> {
        if (!this.isConnected || !this.client) return [];
        try {
            return await this.client.smembers(key);
        } catch (err) {
            return [];
        }
    }

    async srem(key: string, value: string): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            await this.client.srem(key, value);
        } catch (err) {
            // Ignore
        }
    }

    async hset(key: string, values: Record<string, string | number | null | undefined>): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            const cleaned: Record<string, string> = {};
            for (const [field, value] of Object.entries(values)) {
                if (value !== undefined) cleaned[field] = value === null ? '' : String(value);
            }
            if (Object.keys(cleaned).length > 0) {
                await this.client.hset(key, cleaned);
            }
        } catch (err) {
            // Ignore
        }
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        if (!this.isConnected || !this.client) return {};
        try {
            return await this.client.hgetall(key);
        } catch (err) {
            return {};
        }
    }

    async zadd(key: string, score: number, value: string): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            await this.client.zadd(key, score, value);
        } catch (err) {
            // Ignore
        }
    }

    async zrange(key: string, start: number, stop: number): Promise<string[]> {
        if (!this.isConnected || !this.client) return [];
        try {
            return await this.client.zrange(key, start, stop);
        } catch (err) {
            return [];
        }
    }

    async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await this.client.zremrangebyscore(key, min, max);
        } catch (err) {
            return null;
        }
    }

    async zcard(key: string): Promise<number | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await this.client.zcard(key);
        } catch (err) {
            return null;
        }
    }

    // ---- Pub/sub (realtime bus) -------------------------------------------

    /** Fire-and-forget publish; returns subscriber count or null when Redis is unavailable. */
    async publish(channel: string, message: string): Promise<number | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await this.client.publish(channel, message);
        } catch (err) {
            return null;
        }
    }

    /**
     * Subscribe on a DEDICATED connection (a subscribed ioredis client cannot
     * issue other commands). Returns an unsubscribe function, or null when the
     * client is unavailable. Reconnects follow ioredis' own retry strategy.
     */
    subscribe(channel: string, onMessage: (message: string) => void, onStatus?: (subscribed: boolean) => void): (() => Promise<void>) | null {
        if (!this.client) return null;
        try {
            const subscriber = this.client.duplicate();
            subscriber.on('error', () => onStatus?.(false));
            subscriber.on('close', () => onStatus?.(false));
            subscriber.on('ready', () => {
                subscriber.subscribe(channel).then(() => onStatus?.(true)).catch(() => onStatus?.(false));
            });
            subscriber.on('message', (incomingChannel: string, message: string) => {
                if (incomingChannel === channel) onMessage(message);
            });
            return async () => {
                try { await subscriber.unsubscribe(channel); } catch { /* ignore */ }
                try { await subscriber.quit(); } catch { /* ignore */ }
            };
        } catch (err) {
            return null;
        }
    }

    // ---- Streams (durable event log) ------------------------------------

    /** XADD with approximate MAXLEN trimming; returns the stream id or null. */
    async xadd(key: string, maxLen: number, fields: Record<string, string | number | null | undefined>): Promise<string | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            const flat: string[] = [];
            for (const [field, value] of Object.entries(fields)) {
                if (value === undefined) continue;
                flat.push(field, value === null ? '' : String(value));
            }
            if (flat.length === 0) return null;
            return await (this.client as any).xadd(key, 'MAXLEN', '~', String(maxLen), '*', ...flat);
        } catch (err) {
            return null;
        }
    }

    /** Newest-first range. `start` defaults to '+', `end` to '-'. */
    async xrevrange(key: string, start = '+', end = '-', count?: number): Promise<Array<[string, string[]]>> {
        if (!this.isConnected || !this.client) return [];
        try {
            const args: any[] = [key, start, end];
            if (count) args.push('COUNT', String(count));
            return await (this.client as any).xrevrange(...args);
        } catch (err) {
            return [];
        }
    }

    /** Oldest-first range (use '(' + id for an exclusive start). */
    async xrange(key: string, start = '-', end = '+', count?: number): Promise<Array<[string, string[]]>> {
        if (!this.isConnected || !this.client) return [];
        try {
            const args: any[] = [key, start, end];
            if (count) args.push('COUNT', String(count));
            return await (this.client as any).xrange(...args);
        } catch (err) {
            return [];
        }
    }

    async xlen(key: string): Promise<number | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            return await (this.client as any).xlen(key);
        } catch (err) {
            return null;
        }
    }
}

export const redis = new RedisClient();
