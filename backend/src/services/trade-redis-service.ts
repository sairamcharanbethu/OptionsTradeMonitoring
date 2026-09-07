import crypto from 'crypto';
import { publishRealtime } from '../lib/realtime';
import { redis } from '../lib/redis';
import { MarketDataWriteBufferService } from './market-data-write-buffer-service';

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

export type TradeEventRecord = {
  stream_id: string | null;
  user_id: number;
  signal_id: number | null;
  position_id: number | null;
  event_type: string;
  message: string | null;
  metadata: any;
  created_at: string;
};

export type TradeEventsPage = {
  source: 'redis' | 'db';
  events: TradeEventRecord[];
  /** Newest stream id in the page; pass back as `after` to fetch only newer events. */
  cursor: string | null;
};

/** Subset of the Redis wrapper the event stream needs (injectable for tests). */
type StreamClient = {
  isReady: () => boolean;
  xadd: (key: string, maxLen: number, fields: Record<string, any>) => Promise<string | null>;
  xrevrange: (key: string, start?: string, end?: string, count?: number) => Promise<Array<[string, string[]]>>;
  xrange: (key: string, start?: string, end?: string, count?: number) => Promise<Array<[string, string[]]>>;
  xlen: (key: string) => Promise<number | null>;
};

export class TradeRedisService {
  private static readonly OPEN_TRADES_TTL_SECONDS = Number(process.env.REDIS_OPEN_TRADES_TTL_SECONDS || 8);
  private static readonly LOCK_TTL_SECONDS = Number(process.env.TRADE_LOCK_TTL_SECONDS || 30);
  private static readonly METRICS_TTL_SECONDS = 86400;
  private static readonly TRADE_STATE_TTL_SECONDS = 60;
  /** Durable-enough operator event log: newest ~5000 events, approximate trimming. */
  static readonly TRADE_EVENTS_STREAM = 'trade-events:stream';
  static readonly TRADE_EVENTS_STREAM_MAXLEN = Number(process.env.TRADE_EVENTS_STREAM_MAXLEN || 5000);
  /** Positions list cache (routes/positions GET) — short TTL, invalidated on lifecycle writes. */
  static readonly POSITIONS_CACHE_TTL_SECONDS = Number(process.env.POSITIONS_CACHE_TTL_SECONDS || 5);
  private static streamClient: StreamClient = redis as unknown as StreamClient;

  /** Test seam: swap the stream client. */
  static useStreamClient(client: StreamClient | null) {
    this.streamClient = (client || redis) as StreamClient;
  }

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
    entryExposureLock: (userId: number, broker: string, symbol: string) => {
      const normalized = String(symbol || '').trim().toUpperCase();
      const exposureGroup = ['SPY', 'QQQ'].includes(normalized) ? 'SPY-QQQ' : normalized;
      return `locks:entry-exposure:${userId}:${broker}:${exposureGroup}`;
    },
    metric: (name: string) => `metrics:trade-redis:${name}`,
    positionsCache: (userId: number) => `USER_POSITIONS:${userId}`,
  };

  /** Invalidate the positions-list cache for a user (call after any lifecycle write). */
  static async invalidatePositionsCache(userId: number) {
    await redis.del(this.keys.positionsCache(userId));
  }

  /** The exit engine's latest view of a position from the Redis write buffer (or null). */
  static async getLatestQuote(positionId: number | string): Promise<Record<string, number | string | null> | null> {
    if (!redis.isReady()) return null;
    const latest = await redis.hgetall(`${MarketDataWriteBufferService.currentPrefix}:${positionId}`);
    if (!latest?.price) return null;
    const num = (value: string | undefined) => {
      if (value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      current_price: num(latest.price),
      stop_loss_trigger: num(latest.stopLossTrigger),
      trailing_high_price: num(latest.trailingHighPrice),
      underlying_price: num(latest.underlyingPrice),
      delta: num(latest.delta),
      updated_at: latest.updatedAt || null
    };
  }

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
    if (!cached?.data) return null;
    return this.applyBufferedMarketData(cached.data);
  }

  static async getOpenTradesReadModel(userId: number): Promise<TradeReadModel<any[]> | null> {
    const cached = await this.getReadModel<any[]>(this.keys.userOpenTrades(userId));
    if (!cached) return null;
    return {
      ...cached,
      data: await this.applyBufferedMarketData(cached.data)
    };
  }

  static async getTradeState(positionId: number | string): Promise<TradeReadModel<any> | null> {
    const cached = await this.getReadModel<any>(this.keys.tradeState(positionId));
    if (!cached) return null;
    const [trade] = await this.applyBufferedMarketData([cached.data]);
    return {
      ...cached,
      data: trade
    };
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

    const rowsWithMarketData = await this.applyBufferedMarketData(rows);
    const working = rowsWithMarketData.filter((trade: any) => this.isWorkingTrade(trade));
    const summary = {
      openCount: rowsWithMarketData.filter((trade: any) => trade.status === 'OPEN' && !this.isWorkingTrade(trade)).length,
      workingCount: working.length,
      generatedAt: new Date().toISOString()
    };

    await Promise.all([
      this.setReadModel(this.keys.userOpenTrades(userId), rowsWithMarketData),
      this.setReadModel(this.keys.userWorkingTrades(userId), working),
      this.setReadModel(this.keys.userTradeSummary(userId), summary),
      ...rowsWithMarketData.map((trade: any) => this.setReadModel(this.keys.tradeState(trade.id), trade, this.TRADE_STATE_TTL_SECONDS))
    ]);

    this.broadcast(broadcaster, {
      type: 'TRADES_UPDATED',
      userId,
      generatedAt: summary.generatedAt,
      openCount: summary.openCount,
      workingCount: summary.workingCount
    });

    return rowsWithMarketData;
  }

  static async rebuildOpenTradesBestEffort(db: Queryable, userId: number, broadcaster?: any, context = 'trade mutation') {
    try {
      await this.rebuildOpenTrades(db, userId, broadcaster);
      return null;
    } catch (error: any) {
      const message = `Failed to refresh trade cache after committed ${context}: ${error.message || String(error)}`;
      broadcaster?.log?.warn?.(`[TradeRedisService] ${message}`);
      return message;
    }
  }

  static async refreshAfterCommittedMutation(db: Queryable, userId: number, broadcaster?: any, context = 'trade mutation') {
    const warnings: string[] = [];
    const cacheWarning = await this.rebuildOpenTradesBestEffort(db, userId, broadcaster, context);
    if (cacheWarning) warnings.push(cacheWarning);
    try {
      await this.requestBrokerSync(userId);
    } catch (error: any) {
      const message = `Failed to queue broker sync after committed ${context}: ${error.message || String(error)}`;
      warnings.push(message);
      broadcaster?.log?.warn?.(`[TradeRedisService] ${message}`);
    }
    return warnings;
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

    try {
      const telemetry = metadata?.telemetry || metadata;
      await db.query(
        `INSERT INTO execution_telemetry (
           user_id, signal_id, position_id, event_type, broker, order_id, ticker,
           bid, ask, mark, intended_price, fill_price, slippage_pct, latency_ms, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          event.userId,
          event.signalId || null,
          event.positionId || null,
          event.eventType,
          telemetry.broker || null,
          telemetry.orderId || telemetry.order_id || null,
          telemetry.ticker || telemetry.contract || null,
          telemetry.bid ?? null,
          telemetry.ask ?? null,
          telemetry.mark ?? null,
          telemetry.intendedEntry ?? telemetry.intended_price ?? null,
          telemetry.fillPrice ?? telemetry.fill_price ?? null,
          telemetry.slippagePct ?? telemetry.slippage_pct ?? null,
          telemetry.latencyMs ?? telemetry.latency_ms ?? null,
          metadata
        ]
      );
    } catch {
      // Telemetry must never prevent the primary trade event from being recorded.
    }

    const createdAt = new Date().toISOString();
    if (event.positionId) {
      await redis.set(this.keys.latestTradeEvent(event.positionId), JSON.stringify({
        ...event,
        generatedAt: createdAt
      }), 3600);
      // A lifecycle event on a position means the cached positions list is stale.
      await this.invalidatePositionsCache(event.userId);
    }

    // Append to the Redis stream (decision log / resumable operator feed).
    // Postgres remains the durable record; the stream is the fast tail.
    let streamId: string | null = null;
    try {
      streamId = await this.streamClient.xadd(this.TRADE_EVENTS_STREAM, this.TRADE_EVENTS_STREAM_MAXLEN, {
        user_id: event.userId,
        signal_id: event.signalId ?? null,
        position_id: event.positionId ?? null,
        event_type: event.eventType,
        message: event.message ?? null,
        metadata: JSON.stringify(metadata ?? {}),
        created_at: createdAt
      });
    } catch {
      streamId = null;
    }

    // Operator UI push. Every lifecycle transition records an event, so a
    // position-linked event is also the signal to refresh that position.
    publishRealtime('TRADE_EVENT', {
      stream_id: streamId,
      user_id: event.userId,
      signal_id: event.signalId || null,
      position_id: event.positionId || null,
      event_type: event.eventType,
      message: event.message || null,
      metadata,
      created_at: createdAt
    }, { userId: event.userId });
    if (event.positionId) {
      publishRealtime('POSITION_UPDATE', { id: event.positionId, kind: 'lifecycle', event_type: event.eventType }, { userId: event.userId });
    }
  }

  /**
   * Read recent trade events, newest first. Redis stream when available (with
   * `after` = exclusive stream-id cursor for "only newer than"), Postgres
   * trade_events otherwise. `userId` null means all users (admin).
   */
  static async readEvents(db: Queryable, options: {
    userId: number | null;
    limit?: number;
    after?: string | null;
    types?: string[] | null;
  }): Promise<TradeEventsPage> {
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit || 200)));
    const types = options.types && options.types.length ? new Set(options.types.map((t) => String(t).toUpperCase())) : null;
    const matches = (row: TradeEventRecord) =>
      (options.userId == null || Number(row.user_id) === Number(options.userId))
      && (!types || types.has(String(row.event_type).toUpperCase()));

    if (this.streamClient.isReady()) {
      const after = options.after && /^\d+-\d+$/.test(options.after) ? options.after : null;
      // Filtering happens client-side, so over-fetch to fill the page.
      const fetchCount = Math.min(5000, limit * (options.userId == null && !types ? 1 : 5));
      const raw = after
        ? (await this.streamClient.xrange(this.TRADE_EVENTS_STREAM, `(${after}`, '+', fetchCount)).reverse()
        : await this.streamClient.xrevrange(this.TRADE_EVENTS_STREAM, '+', '-', fetchCount);
      const events: TradeEventRecord[] = [];
      for (const entry of raw) {
        const record = this.parseStreamEntry(entry);
        if (record && matches(record)) events.push(record);
        if (events.length >= limit) break;
      }
      return { source: 'redis', events, cursor: events[0]?.stream_id ?? (raw[0]?.[0] ?? null) };
    }

    const params: any[] = [];
    const where: string[] = [];
    if (options.userId != null) { params.push(options.userId); where.push(`user_id = $${params.length}`); }
    if (types) { params.push(Array.from(types)); where.push(`UPPER(event_type) = ANY($${params.length})`); }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT id, user_id, signal_id, position_id, event_type, message, metadata, created_at
         FROM trade_events
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params
    );
    const events: TradeEventRecord[] = (rows || []).map((row: any) => ({
      stream_id: null,
      user_id: Number(row.user_id),
      signal_id: row.signal_id == null ? null : Number(row.signal_id),
      position_id: row.position_id == null ? null : Number(row.position_id),
      event_type: String(row.event_type),
      message: row.message ?? null,
      metadata: row.metadata ?? {},
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    }));
    return { source: 'db', events, cursor: null };
  }

  static async getEventStreamLength(): Promise<number | null> {
    if (!this.streamClient.isReady()) return null;
    return this.streamClient.xlen(this.TRADE_EVENTS_STREAM);
  }

  private static parseStreamEntry(entry: [string, string[]]): TradeEventRecord | null {
    try {
      const [id, flat] = entry;
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
      const num = (value: string | undefined) => (value === undefined || value === '' ? null : Number(value));
      let metadata: any = {};
      try { metadata = fields.metadata ? JSON.parse(fields.metadata) : {}; } catch { metadata = { raw: fields.metadata }; }
      return {
        stream_id: id,
        user_id: Number(fields.user_id),
        signal_id: num(fields.signal_id),
        position_id: num(fields.position_id),
        event_type: String(fields.event_type || ''),
        message: fields.message ? fields.message : null,
        metadata,
        created_at: fields.created_at || new Date(Number(id.split('-')[0])).toISOString()
      };
    } catch {
      return null;
    }
  }

  static async getHealth() {
    const queueDepth = await redis.llen(this.keys.brokerSyncQueue());
    const eventStreamLength = await this.getEventStreamLength();
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
      eventStreamLength,
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

  private static async applyBufferedMarketData<T extends { id: number | string; status?: string }>(trades: T[]): Promise<T[]> {
    if (!redis.isReady() || trades.length === 0) return trades;

    return Promise.all(trades.map(async (trade) => {
      if (String(trade.status || '').toUpperCase() === 'CLOSED') return trade;
      const latest = await redis.hgetall(`${MarketDataWriteBufferService.currentPrefix}:${trade.id}`);
      if (!latest?.price) return trade;
      const next: any = { ...trade };
      this.assignOptionalNumber(next, 'current_price', latest.price);
      this.assignOptionalNumber(next, 'delta', latest.delta);
      this.assignOptionalNumber(next, 'theta', latest.theta);
      this.assignOptionalNumber(next, 'gamma', latest.gamma);
      this.assignOptionalNumber(next, 'vega', latest.vega);
      this.assignOptionalNumber(next, 'iv', latest.iv);
      this.assignOptionalNumber(next, 'underlying_price', latest.underlyingPrice);
      if (latest.updatedAt) next.updated_at = latest.updatedAt;
      return next;
    }));
  }

  private static assignOptionalNumber(target: any, key: string, value: string | undefined) {
    if (!value) return;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) target[key] = parsed;
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
