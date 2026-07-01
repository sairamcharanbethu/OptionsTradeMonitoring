import cron from 'node-cron';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { redis as defaultRedis } from '../lib/redis';

type QuoteTelemetry = {
  positionId: number | string;
  price: number;
  delta?: number | null;
  theta?: number | null;
  gamma?: number | null;
  vega?: number | null;
  iv?: number | null;
  underlyingPrice?: number | null;
  recordedAt?: string;
};

type FlushSummary = {
  checked: number;
  flushed: number;
  historyRows: number;
  errors: string[];
};

export class MarketDataWriteBufferService {
  public static readonly pendingPositionsKey = 'market-data-buffer:positions';
  public static readonly currentPrefix = 'market-data-buffer:current';
  public static readonly historyPrefix = 'market-data-buffer:history';
  private readonly pendingPositionsKey = MarketDataWriteBufferService.pendingPositionsKey;
  private readonly flushLockKey = 'market-data-buffer:flush-lock';
  private readonly currentPrefix = MarketDataWriteBufferService.currentPrefix;
  private readonly historyPrefix = MarketDataWriteBufferService.historyPrefix;
  private lastFlushAt: string | null = null;
  private lastFlushSummary: FlushSummary | null = null;
  private flushRunning = false;

  constructor(private fastify: FastifyInstance, private redisClient: any = defaultRedis) {}

  public startEodFlushJob() {
    const schedule = process.env.MARKET_DATA_EOD_FLUSH_SCHEDULE || '15 16 * * 1-5';
    this.fastify.log.info(`[MarketDataBuffer] Starting EOD flush job with schedule: ${schedule} America/New_York`);
    cron.schedule(schedule, async () => {
      try {
        await this.flushToDatabase();
      } catch (err: any) {
        this.fastify.log.warn(`[MarketDataBuffer] EOD flush failed: ${err.message || String(err)}`);
      }
    }, { timezone: 'America/New_York' });
  }

  public async recordQuote(input: QuoteTelemetry): Promise<boolean> {
    if (!this.redisClient.isReady?.()) return false;

    const positionId = String(input.positionId);
    const price = Number(input.price);
    if (!positionId || !Number.isFinite(price) || price <= 0) return true;

    const recordedAt = input.recordedAt || new Date().toISOString();
    const score = new Date(recordedAt).getTime();
    const history = JSON.stringify({ price, recordedAt });

    await Promise.all([
      this.redisClient.sadd(this.pendingPositionsKey, positionId),
      this.redisClient.hset(this.currentKey(positionId), {
        price,
        delta: input.delta,
        theta: input.theta,
        gamma: input.gamma,
        vega: input.vega,
        iv: input.iv,
        underlyingPrice: input.underlyingPrice,
        updatedAt: recordedAt
      }),
      this.redisClient.zadd(this.historyKey(positionId), Number.isFinite(score) ? score : Date.now(), history)
    ]);

    return true;
  }

  public async flushToDatabase(): Promise<FlushSummary> {
    if (this.flushRunning) {
      return this.lastFlushSummary || { checked: 0, flushed: 0, historyRows: 0, errors: ['Flush already running'] };
    }

    const lockToken = crypto.randomUUID();
    const lockAcquired = await this.redisClient.setNX?.(this.flushLockKey, lockToken, 900);
    if (!lockAcquired) {
      return this.lastFlushSummary || { checked: 0, flushed: 0, historyRows: 0, errors: ['Flush lock is held by another backend'] };
    }

    this.flushRunning = true;
    const summary: FlushSummary = { checked: 0, flushed: 0, historyRows: 0, errors: [] };
    try {
      const positionIds = await this.redisClient.smembers(this.pendingPositionsKey);
      summary.checked = positionIds.length;

      for (const positionId of positionIds) {
        try {
          const latest = await this.redisClient.hgetall(this.currentKey(positionId));
          const historyRows = await this.redisClient.zrange(this.historyKey(positionId), 0, -1);
          await this.flushPosition(positionId, latest, historyRows);
          await this.cleanupFlushedBuffers(positionId, latest, historyRows);
          summary.flushed += 1;
          summary.historyRows += historyRows.length;
        } catch (err: any) {
          summary.errors.push(`position ${positionId}: ${err.message || String(err)}`);
        }
      }

      this.lastFlushAt = new Date().toISOString();
      this.lastFlushSummary = summary;
      if (summary.checked > 0 || summary.errors.length > 0) {
        this.fastify.log.info(`[MarketDataBuffer] Flush checked=${summary.checked} flushed=${summary.flushed} historyRows=${summary.historyRows} errors=${summary.errors.length}`);
      }
      return summary;
    } finally {
      this.flushRunning = false;
      await this.redisClient.delIfValue?.(this.flushLockKey, lockToken);
    }
  }

  public async writeThrough(input: QuoteTelemetry) {
    await this.updateCurrentPrice(input);
    await this.insertPriceHistory(input.positionId, input.price, input.recordedAt || new Date().toISOString());
  }

  public async applyLatestToPositions<T extends { id: number | string; status?: string }>(positions: T[]): Promise<T[]> {
    if (!this.redisClient.isReady?.() || positions.length === 0) return positions;

    return Promise.all(positions.map(async (position) => {
      if (String(position.status || '').toUpperCase() === 'CLOSED') return position;
      const latest = await this.redisClient.hgetall(this.currentKey(String(position.id)));
      return this.applyLatest(position, latest);
    }));
  }

  public async applyLatestToPosition<T extends { id: number | string; status?: string }>(position: T): Promise<T> {
    const [updated] = await this.applyLatestToPositions([position]);
    return updated;
  }

  public async getBufferedPriceHistory(positionId: string | number): Promise<Array<{ price: number; recorded_at: string }>> {
    if (!this.redisClient.isReady?.()) return [];
    const rows = await this.redisClient.zrange(this.historyKey(String(positionId)), 0, -1);
    const parsedRows: Array<{ price: number; recorded_at: string }> = [];
    for (const row of rows) {
      const parsed = this.parseHistoryRow(row);
      if (parsed) parsedRows.push(parsed);
    }
    return parsedRows;
  }

  public getHealth() {
    return {
      status: this.redisClient.isReady?.() ? 'UP' : 'DEGRADED',
      lastFlushAt: this.lastFlushAt,
      lastFlushSummary: this.lastFlushSummary,
      flushRunning: this.flushRunning
    };
  }

  private async flushPosition(positionId: string, latest: Record<string, string>, historyRows: string[]) {
    const client = await (this.fastify as any).pg.connect();
    try {
      await client.query('BEGIN');
      if (latest.price) {
        await this.updateCurrentPrice({
          positionId,
          price: Number(latest.price),
          delta: this.optionalNumber(latest.delta),
          theta: this.optionalNumber(latest.theta),
          gamma: this.optionalNumber(latest.gamma),
          vega: this.optionalNumber(latest.vega),
          iv: this.optionalNumber(latest.iv),
          underlyingPrice: this.optionalNumber(latest.underlyingPrice)
        }, client);
      }

      for (const row of historyRows) {
        const parsed = this.parseHistoryRow(row);
        if (parsed) {
          await this.insertPriceHistory(positionId, parsed.price, parsed.recorded_at, client);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async cleanupFlushedBuffers(positionId: string, latest: Record<string, string>, historyRows: string[]) {
    const historyScores = historyRows
      .map((row) => this.parseHistoryRow(row))
      .filter((row): row is { price: number; recorded_at: string } => Boolean(row))
      .map((row) => new Date(row.recorded_at).getTime())
      .filter((score) => Number.isFinite(score));
    if (historyScores.length > 0) {
      await this.redisClient.zremrangebyscore(this.historyKey(positionId), '-inf', Math.max(...historyScores));
    }

    const latestAfterFlush = await this.redisClient.hgetall(this.currentKey(positionId));
    const currentUnchanged = Boolean(latest.price)
      && latestAfterFlush.price === latest.price
      && latestAfterFlush.updatedAt === latest.updatedAt;
    if (currentUnchanged) {
      await this.redisClient.del(this.currentKey(positionId));
    }

    const remainingHistory = await this.redisClient.zcard(this.historyKey(positionId));
    const remainingCurrent = await this.redisClient.hgetall(this.currentKey(positionId));
    if (!remainingCurrent.price && Number(remainingHistory || 0) === 0) {
      await this.redisClient.srem(this.pendingPositionsKey, positionId);
    }
  }

  private async updateCurrentPrice(input: QuoteTelemetry, client?: any) {
    const queryable = client || (this.fastify as any).pg;
    await queryable.query(
      `UPDATE positions
       SET current_price = $1,
           updated_at = CURRENT_TIMESTAMP,
           delta = $2,
           theta = $3,
           gamma = $4,
           vega = $5,
           iv = $6,
           underlying_price = $7
       WHERE id = $8`,
      [
        input.price,
        input.delta ?? null,
        input.theta ?? null,
        input.gamma ?? null,
        input.vega ?? null,
        input.iv ?? null,
        input.underlyingPrice ?? null,
        input.positionId
      ]
    );
  }

  private async insertPriceHistory(positionId: string | number, price: number, recordedAt: string, client?: any) {
    const queryable = client || (this.fastify as any).pg;
    await queryable.query(
      'INSERT INTO price_history (position_id, price, recorded_at) VALUES ($1, $2, $3)',
      [positionId, price, recordedAt]
    );
  }

  private currentKey(positionId: string) {
    return `${this.currentPrefix}:${positionId}`;
  }

  private historyKey(positionId: string) {
    return `${this.historyPrefix}:${positionId}`;
  }

  private optionalNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private applyLatest<T extends { id: number | string }>(position: T, latest: Record<string, string>): T {
    if (!latest?.price) return position;
    const next: any = { ...position };
    this.assignOptionalNumber(next, 'current_price', latest.price);
    this.assignOptionalNumber(next, 'delta', latest.delta);
    this.assignOptionalNumber(next, 'theta', latest.theta);
    this.assignOptionalNumber(next, 'gamma', latest.gamma);
    this.assignOptionalNumber(next, 'vega', latest.vega);
    this.assignOptionalNumber(next, 'iv', latest.iv);
    this.assignOptionalNumber(next, 'underlying_price', latest.underlyingPrice);
    if (latest.updatedAt) next.updated_at = latest.updatedAt;
    return next;
  }

  private assignOptionalNumber(target: any, key: string, value: string | undefined) {
    const parsed = this.optionalNumber(value);
    if (parsed !== null) target[key] = parsed;
  }

  private parseHistoryRow(row: string): { price: number; recorded_at: string } | null {
    try {
      const parsed = JSON.parse(row);
      const price = Number(parsed.price);
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        price,
        recorded_at: parsed.recordedAt || parsed.recorded_at || new Date().toISOString()
      };
    } catch {
      return null;
    }
  }
}
