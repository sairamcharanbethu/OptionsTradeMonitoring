import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

class RedisClient {
    private client: Redis | null = null;
    private isConnected = false;

    constructor() {
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
            const result = await this.client.set(key, value, 'NX', 'EX', ttlSeconds);
            return result === 'OK';
        } catch (err) {
            return false;
        }
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
}

export const redis = new RedisClient();
