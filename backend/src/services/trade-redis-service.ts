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

export type TradeReadModel<T> = RedisReadModel<T> & {
  ageMs: number;
};

export type RedisLock = {
  key: string;
  token: string;
  acquired: boolean;
  degraded?: boolean;
};

type TradeEventInput = {
  userId: number;
  signalId?: number | string | null;
  positionId?: number | string | null;
  eventType: string;
  message?: string | null;
  metadata?: any;
};

export class TradeRedisService {
  private static readonly OPEN_TRADES_TTL_SECONDS = Number(process.env.REDIS_OPEN_TRADES_TTL_SECONDS || 8);
  private static readonly LOCK_TTL_SECONDS = Number(process.env.TRADE_LOCK_TTL_SECONDS || 30);
  private static readonly METRICS_TTL_SECONDS = 86400;
  private static readonly TRADE_STATE_TTL_SECONDS = 60;

  static keys = {
    userOpenTrades: (userId: number) => `trades:open:user:${userId}`,
    userWorkingTrades: (userId: number) => `trades:working:user:${userId}`,
    userTradeSummary: (userId: number) => `trades:summary:user:${userId}`,
    tradeState: (positionId: number | string) => `trade:${positionId}:state`,
    latestTradeEvent: (positionId: number | string) => `trade:${positionId}:latest-event`,
    brokerSyncQueue: () => 'broker-sync:queue',
    brokerSyncDedupe: (userId: number) => `broker-sync:queued:user:${userId}`,
    brokerSyncLock: (userId: number) => `locks:broker-sync:user:${userId}`,
    exitLock: (positionId: number | string) => `locks:exit:${positionId}`,
    entryLock: (userId: number, contractKey: string) => `locks:entry:${userId}:${contractKey}`,
    metric: (name: string) => `metrics:trade-redis:${name}`,
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
      await this.incrementMetric('locks.degraded');
      return { key, token, acquired: true, degraded: true };
    }
    const acquired = await redis.setNX(key, token, ttlSeconds);
    await this.incrementMetric(acquired ? 'locks.acquired' : 'locks.denied');
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

  static async getOpenTradesReadModel(userId: number): Promise<TradeReadModel<any[]> | null> {
    return this.getReadModel<any[]>(this.keys.userOpenTrades(userId));
  }

  static async getTradeState(positionId: number | string): Promise<TradeReadModel<any> | null> {
    return this.getReadModel<any>(this.keys.tradeState(positionId));
  }

  static async rebuildOpenTrades(db: Queryable, userId: number, broadcaster?: any) {
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
      this.setReadModel(this.keys.userTradeSummary(userId), summary),
      ...rows.map((trade: any) => this.setReadModel(this.keys.tradeState(trade.id), trade, this.TRADE_STATE_TTL_SECONDS))
    ]);

    this.broadcast(broadcaster, {
      type: 'TRADES_UPDATED',
      userId,
      generatedAt: summary.generatedAt,
      openCount: summary.openCount,
      workingCount: summary.workingCount
    });

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

  static async requestBrokerSync(userId: number): Promise<boolean> {
    const dedupeKey = this.keys.brokerSyncDedupe(userId);
    const queued = await redis.setNX(dedupeKey, String(Date.now()), 60);
    if (!queued) {
      await this.incrementMetric('brokerSyncQueue.deduped');
      return false;
    }
    await redis.lpush(this.keys.brokerSyncQueue(), String(userId));
    await this.incrementMetric('brokerSyncQueue.enqueued');
    return true;
  }

  static async popBrokerSyncRequest(): Promise<number | null> {
    const value = await redis.rpop(this.keys.brokerSyncQueue());
    if (!value) return null;
    const userId = Number(value);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    await redis.del(this.keys.brokerSyncDedupe(userId));
    return userId;
  }

  static async recordEvent(db: Queryable, event: TradeEventInput) {
    const metadata = event.metadata || {};
    await db.query(
      `INSERT INTO trade_events (user_id, signal_id, position_id, event_type, message, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [event.userId, event.signalId || null, event.positionId || null, event.eventType, event.message || null, metadata]
    );

    if (event.positionId) {
      await redis.set(this.keys.latestTradeEvent(event.positionId), JSON.stringify({
        ...event,
        generatedAt: new Date().toISOString()
      }), 3600);
    }
  }

  static async getHealth() {
    const queueDepth = await redis.llen(this.keys.brokerSyncQueue());
    const metricNames = [
      'locks.acquired',
      'locks.denied',
      'locks.degraded',
      'brokerSyncQueue.enqueued',
      'brokerSyncQueue.deduped'
    ];
    const metrics: Record<string, number> = {};
    for (const metric of metricNames) {
      const value = await redis.get(this.keys.metric(metric));
      metrics[metric] = Number(value || 0);
    }
    return {
      status: redis.isReady() ? 'UP' : 'DEGRADED',
      connected: redis.isReady(),
      queueDepth: queueDepth ?? null,
      metrics
    };
  }

  private static isWorkingTrade(trade: any) {
    const executionStatus = String(trade.execution_status || '');
    return ['PENDING_EXIT', 'PENDING_TRIM'].includes(executionStatus) || executionStatus.startsWith('EXIT_');
  }

  private static async getReadModel<T>(key: string): Promise<TradeReadModel<T> | null> {
    const cached = await redis.get(key);
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as RedisReadModel<T>;
      return {
        ...parsed,
        source: 'redis',
        ageMs: Math.max(0, Date.now() - new Date(parsed.generatedAt).getTime())
      };
    } catch {
      await redis.del(key);
      return null;
    }
  }

  private static async setReadModel<T>(key: string, data: T, ttlSeconds = this.OPEN_TRADES_TTL_SECONDS) {
    const payload: RedisReadModel<T> = {
      generatedAt: new Date().toISOString(),
      source: 'db',
      data
    };
    await redis.set(key, JSON.stringify(payload), ttlSeconds);
  }

  private static async incrementMetric(name: string) {
    await redis.incr(this.keys.metric(name), this.METRICS_TTL_SECONDS);
  }

  private static broadcast(broadcaster: any, payload: any) {
    if (!broadcaster?.websocketServer) return;
    broadcaster.websocketServer.clients.forEach((client: any) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(payload));
      }
    });
  }
}
