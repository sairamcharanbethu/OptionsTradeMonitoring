import crypto from 'crypto';
import { redis } from '../lib/redis';

type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

type RedisReadModel<T> = {
  generatedAt: string;
  source: 'redis' | 'db';
  data: T;
};

export type RedisLock = {
  key: string;
  token: string;
  acquired: boolean;
  degraded?: boolean;
};

export class TradeRedisService {
  private static readonly OPEN_TRADES_TTL_SECONDS = Number(process.env.REDIS_OPEN_TRADES_TTL_SECONDS || 8);
  private static readonly LOCK_TTL_SECONDS = Number(process.env.TRADE_LOCK_TTL_SECONDS || 30);

  static keys = {
    userOpenTrades: (userId: number) => `trades:open:user:${userId}`,
    userWorkingTrades: (userId: number) => `trades:working:user:${userId}`,
    userTradeSummary: (userId: number) => `trades:summary:user:${userId}`,
    brokerSyncLock: (userId: number) => `locks:broker-sync:user:${userId}`,
    exitLock: (positionId: number | string) => `locks:exit:${positionId}`,
    entryLock: (userId: number, contractKey: string) => `locks:entry:${userId}:${contractKey}`,
  };

  static contractKey(input: {
    symbol: string;
    optionType: string;
    strike: number | string;
    expiration: string | Date;
  }) {
    const expiry = input.expiration instanceof Date
      ? input.expiration.toISOString().split('T')[0]
      : String(input.expiration).split('T')[0];
    return [
      String(input.symbol || '').trim().toUpperCase(),
      String(input.optionType || '').trim().toUpperCase(),
      Number(input.strike).toFixed(3),
      expiry
    ].join(':');
  }

  static async acquireLock(key: string, ttlSeconds = this.LOCK_TTL_SECONDS): Promise<RedisLock> {
    const token = crypto.randomUUID();
    if (!redis.isReady()) {
      return { key, token, acquired: true, degraded: true };
    }
    const acquired = await redis.setNX(key, token, ttlSeconds);
    return { key, token, acquired };
  }

  static async releaseLock(lock: RedisLock | null | undefined) {
    if (!lock?.acquired || lock.degraded) return;
    await redis.delIfValue(lock.key, lock.token);
  }

  static async getOpenTrades(userId: number) {
    const cached = await this.getReadModel<any[]>(this.keys.userOpenTrades(userId));
    return cached?.data || null;
  }

  static async rebuildOpenTrades(db: Queryable, userId: number) {
    const { rows } = await db.query(
      `SELECT *
       FROM positions
       WHERE user_id = $1
         AND execution_broker = 'wealthsimple_snaptrade'
         AND status IN ('PENDING_ORDER', 'OPEN')
       ORDER BY
         CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END,
         created_at DESC`,
      [userId]
    );

    const working = rows.filter((trade: any) => this.isWorkingTrade(trade));
    const summary = {
      openCount: rows.filter((trade: any) => trade.status === 'OPEN' && !this.isWorkingTrade(trade)).length,
      workingCount: working.length,
      generatedAt: new Date().toISOString()
    };

    await Promise.all([
      this.setReadModel(this.keys.userOpenTrades(userId), rows),
      this.setReadModel(this.keys.userWorkingTrades(userId), working),
      this.setReadModel(this.keys.userTradeSummary(userId), summary)
    ]);

    return rows;
  }

  static async invalidateUser(userId: number) {
    await Promise.all([
      redis.del(this.keys.userOpenTrades(userId)),
      redis.del(this.keys.userWorkingTrades(userId)),
      redis.del(this.keys.userTradeSummary(userId)),
      redis.del(`USER_POSITIONS:${userId}`),
      redis.del(`USER_STATS:${userId}`)
    ]);
  }

  private static isWorkingTrade(trade: any) {
    const executionStatus = String(trade.execution_status || '');
    return ['PENDING_EXIT', 'PENDING_TRIM'].includes(executionStatus) || executionStatus.startsWith('EXIT_');
  }

  private static async getReadModel<T>(key: string): Promise<RedisReadModel<T> | null> {
    const cached = await redis.get(key);
    if (!cached) return null;
    try {
      return JSON.parse(cached);
    } catch {
      await redis.del(key);
      return null;
    }
  }

  private static async setReadModel<T>(key: string, data: T) {
    const payload: RedisReadModel<T> = {
      generatedAt: new Date().toISOString(),
      source: 'db',
      data
    };
    await redis.set(key, JSON.stringify(payload), this.OPEN_TRADES_TTL_SECONDS);
  }
}
