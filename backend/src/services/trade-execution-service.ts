import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';
import { SnaptradeService } from './snaptrade-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { TradeRedisService } from './trade-redis-service';
import { TradeLifecycleService } from './trade-lifecycle-service';

type ExecutionBroker = 'none' | 'alpaca_paper' | 'wealthsimple_snaptrade' | 'simulated';

interface ExecuteSignalInput {
  userId: number;
  signalId: number;
  symbol: string;
  winningSide: 'CALL' | 'PUT';
  chosenStrike: number;
  chosenExpiry: string;
  stopUnderlying: number;
  targetUnderlying: number;
  mark: number | null;
}

interface ExecutionSettings {
  execution_broker?: string;
  alpaca_auto_trade?: string;
  snaptrade_auto_trade?: string;
  snaptrade_trading_account_id?: string;
  max_trades_per_day?: string;
  contracts_per_trade?: string;
  order_type?: string;
  entry_slippage_pct?: string;
  take_profit_pct?: string;
  stop_loss_engine_enabled?: string;
  live_trading_acknowledged?: string;
  alpaca_key_id?: string;
  alpaca_secret_key?: string;
}

type EntryQuoteSnapshot = {
  ticker: string;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  mark: number;
  spreadPct: number | null;
  quoteAgeMs: number | null;
  tradeAgeMs: number | null;
  timestamp: string | null;
};

type EntryQuoteValidation = {
  quote: EntryQuoteSnapshot;
  protectedLimit: number;
  baselineMark: number | null;
  movePct: number | null;
  stabilityMovePct: number | null;
};

export class TradeExecutionService {
  constructor(private fastify: FastifyInstance) {}

  private readonly ENTRY_MAX_QUOTE_AGE_MS = 2_000;
  private readonly ENTRY_MAX_SPREAD_PCT = 15;
  private readonly ENTRY_MIN_BID_TO_ENTRY_RATIO = 0.90;
  private readonly ENTRY_MAX_PREMIUM_JUMP_PCT = 8;
  private readonly ENTRY_MAX_STABILITY_MOVE_PCT = 8;
  private readonly ENTRY_STABILITY_DELAY_MS = 1_500;
  private readonly ENTRY_PROTECTED_LIMIT_OVER_MID_PCT = 3;

  public async getSettingsForUser(userId: number): Promise<ExecutionSettings> {
    const dbSettings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);

    return {
      execution_broker: 'none',
      alpaca_auto_trade: 'false',
      snaptrade_auto_trade: 'false',
      snaptrade_trading_account_id: '',
      max_trades_per_day: '2',
      contracts_per_trade: '1',
      order_type: 'LIMIT',
      entry_slippage_pct: '3',
      take_profit_pct: '',
      stop_loss_engine_enabled: 'true',
      live_trading_acknowledged: 'false',
      ...dbSettings
    };
  }

  public async executeSignal(input: ExecuteSignalInput, settingsOverride?: ExecutionSettings) {
    const settings = settingsOverride || await this.getSettingsForUser(input.userId);
    const broker = this.resolveBroker(settings);
    const quantity = this.parsePositiveInt(settings.contracts_per_trade, 1, 100);
    const maxTradesPerDay = this.parsePositiveInt(settings.max_trades_per_day, 2, 100);

    const existingExecution = await this.getExistingSignalExecution(input.userId, input.signalId);
    if (existingExecution && (existingExecution.broker_order_id || existingExecution.execution_status === 'PENDING' || existingExecution.execution_status === 'EXECUTED')) {
      return {
        success: false,
        skipped: true,
        broker,
        message: `Signal #${input.signalId} already has execution status ${existingExecution.execution_status || existingExecution.status}`
      };
    }

    const setupGrade = await this.getSignalSetupGrade(input.signalId);
    if (!this.isExecutableSetupGrade(setupGrade)) {
      const message = `Signal #${input.signalId} skipped: setup grade ${setupGrade || 'N/A'} is below A/A+`;
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      this.fastify.log.info(`[TradeExecutionService] ${message}`);
      return { success: false, skipped: true, broker, message };
    }

    const entryLockKey = TradeRedisService.keys.entryLock(
      input.userId,
      TradeRedisService.contractKey({
        symbol: input.symbol,
        optionType: input.winningSide,
        strike: input.chosenStrike,
        expiration: input.chosenExpiry
      })
    );
    const entryLock = await TradeRedisService.acquireLock(entryLockKey);
    if (!entryLock.acquired) {
      const message = `Skipped duplicate entry: ${this.contractLabel(input)} already has an entry request in progress`;
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }

    try {
    if (broker === 'wealthsimple_snaptrade') {
      try {
        const snaptradeService = new SnaptradeService(this.fastify);
        await snaptradeService.syncPendingBrokerOrders(input.userId);
      } catch (err: any) {
        const message = `Could not verify Wealthsimple orders before entry: ${err.message || String(err)}`;
        await this.markSignalExecutionFailure(input.userId, input.signalId, message);
        return { success: false, broker, message };
      }
    }

    const duplicate = await this.findDuplicateOpenEntry(input);
    if (duplicate) {
      const message = `Skipped duplicate entry: ${this.contractLabel(input)} already exists as position #${duplicate.id} (${duplicate.status}${duplicate.execution_status ? `/${duplicate.execution_status}` : ''})`;
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      this.fastify.log.info(`[TradeExecutionService] ${message}`);
      return { success: false, skipped: true, broker, message, duplicatePositionId: duplicate.id };
    }

    const supersededSummary = await this.closeSupersededPositions(input, settings, broker);
    if (supersededSummary.blocked) {
      await this.markSignalExecutionFailure(input.userId, input.signalId, supersededSummary.message);
      return { success: false, broker, message: supersededSummary.message, superseded: supersededSummary };
    }

    if (broker === 'none') {
      return this.createSimulatedPosition(input, quantity, 'Broker execution disabled');
    }

    const currentTradeCount = await this.countTradesToday(input.userId);
    if (currentTradeCount >= maxTradesPerDay) {
      const message = `Daily trade limit reached (${currentTradeCount}/${maxTradesPerDay})`;
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }

    if (broker === 'alpaca_paper') {
      return this.executeAlpacaPaperTrade(input, settings, quantity);
    }

    if (broker === 'wealthsimple_snaptrade') {
      return this.executeSnapTradeOptionTrade(input, settings, quantity);
    }

    return this.createSimulatedPosition(input, quantity, 'Unknown execution broker');
    } finally {
      await TradeRedisService.releaseLock(entryLock);
    }
  }

  public async getDailyTradeUsage(userId: number, settingsOverride?: ExecutionSettings) {
    const settings = settingsOverride || await this.getSettingsForUser(userId);
    const maxTradesPerDay = this.parsePositiveInt(settings.max_trades_per_day, 2, 100);
    const used = await this.countTradesToday(userId);

    return {
      used,
      max: maxTradesPerDay,
      remaining: Math.max(0, maxTradesPerDay - used)
    };
  }

  private resolveBroker(settings: ExecutionSettings): ExecutionBroker {
    const configured = settings.execution_broker as ExecutionBroker | undefined;
    if (configured === 'alpaca_paper' && settings.alpaca_auto_trade === 'true') return 'alpaca_paper';
    if (configured === 'wealthsimple_snaptrade' && settings.snaptrade_auto_trade === 'true') return 'wealthsimple_snaptrade';

    // Backward compatibility with the existing single Alpaca toggle.
    if ((!configured || configured === 'none') && settings.alpaca_auto_trade === 'true') return 'alpaca_paper';
    if ((!configured || configured === 'none') && settings.snaptrade_auto_trade === 'true') return 'wealthsimple_snaptrade';
    return 'none';
  }

  private parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
    const parsed = parseInt(value || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  }

  private parseOptionalPct(value: string | undefined, max: number): number | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.min(parsed, max);
  }

  private async getExistingSignalExecution(userId: number, signalId: number) {
    const { rows } = await this.fastify.pg.query(
      `SELECT status, execution_status, broker_order_id
       FROM signal_user_executions
       WHERE user_id = $1
         AND signal_id = $2`,
      [userId, signalId]
    );
    return rows[0] || null;
  }

  private async getSignalSetupGrade(signalId: number): Promise<string | null> {
    const { rows } = await this.fastify.pg.query(
      'SELECT setup_grade FROM signals WHERE id = $1',
      [signalId]
    );
    return rows[0]?.setup_grade || null;
  }

  private isExecutableSetupGrade(setupGrade: string | null | undefined): boolean {
    const normalized = String(setupGrade || '').toUpperCase();
    if (normalized.includes('A+')) return true;
    return /(^|[^A-Z])A([^A-Z+]|$)/.test(normalized);
  }

  private async findDuplicateOpenEntry(input: ExecuteSignalInput) {
    const { rows } = await this.fastify.pg.query(
      `SELECT id, status, execution_status, broker_order_id
       FROM positions
       WHERE user_id = $1
         AND symbol = $2
         AND option_type = $3
         AND strike_price = $4
         AND expiration_date::date = $5::date
         AND status IN ('OPEN', 'PENDING_ORDER')
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.userId, input.symbol, input.winningSide, input.chosenStrike, input.chosenExpiry]
    );
    return rows[0] || null;
  }

  private contractLabel(input: ExecuteSignalInput): string {
    return `${input.symbol} ${input.chosenExpiry} ${input.winningSide} ${input.chosenStrike}`;
  }

  private async countTradesToday(userId: number): Promise<number> {
    const { rows } = await this.fastify.pg.query(
      `SELECT COUNT(*)::int AS count
       FROM positions
       WHERE user_id = $1
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
         AND (
           account_id IN ('alpaca_paper', 'simulated')
           OR execution_broker IN ('alpaca_paper', 'wealthsimple_snaptrade', 'simulated')
         )`,
      [userId]
    );
    return Number(rows[0]?.count || 0);
  }

  private async closeSupersededPositions(input: ExecuteSignalInput, settings: ExecutionSettings, broker: ExecutionBroker) {
    const { rows: positions } = await this.fastify.pg.query(
      `SELECT *
       FROM positions
       WHERE user_id = $1
         AND symbol = $2
         AND option_type <> $3
         AND status IN ('OPEN', 'PENDING_ORDER')
         AND COALESCE(execution_status, '') NOT IN ('PENDING_EXIT', 'PENDING_TRIM')
       ORDER BY created_at DESC`,
      [input.userId, input.symbol, input.winningSide]
    );

    const summary = {
      checked: positions.length,
      closed: 0,
      supersededPending: 0,
      errors: [] as string[],
      blocked: false,
      message: ''
    };

    for (const position of positions) {
      try {
        if (TradeLifecycleService.isBrokerExitReviewStatus(position.execution_status)) {
          throw new Error(`Position has ${position.execution_status}; verify broker status before opening the opposite signal`);
        }

        if (position.status === 'PENDING_ORDER') {
          await this.markPendingPositionSuperseded(position, settings, broker, input.signalId);
          summary.supersededPending += 1;
          continue;
        }

        const closed = await this.submitSupersededExit(position, settings, broker, input.signalId);
        if (closed) summary.closed += 1;
      } catch (err: any) {
        const message = `Position #${position.id}: ${err.message || String(err)}`;
        summary.errors.push(message);
        this.fastify.log.warn(`[TradeExecutionService] Failed to close superseded ${input.symbol} ${position.option_type}: ${message}`);
      }
    }

    if (summary.errors.length > 0) {
      summary.blocked = true;
      summary.message = `Superseded ${input.symbol} order cleanup failed: ${summary.errors.join('; ')}`;
    }

    if (summary.closed > 0 || summary.supersededPending > 0) {
      await this.invalidateUserCaches(input.userId);
      const streamers = [
        (this.fastify as any).alpacaMarketDataStreamer,
        (this.fastify as any).streamer
      ];
      for (const streamer of streamers) {
        if (streamer?.syncSubscriptions) {
          streamer.syncSubscriptions().catch((err: any) => {
            this.fastify.log.warn(`[TradeExecutionService] Failed to refresh stream subscriptions after superseded cleanup: ${err.message}`);
          });
        }
      }
    }

    return summary;
  }

  private async markPendingPositionSuperseded(position: any, settings: ExecutionSettings, broker: ExecutionBroker, signalId: number) {
    const executionBroker = String(position.execution_broker || broker || '');

    if (!position.is_simulated && executionBroker === 'wealthsimple_snaptrade') {
      const snaptradeService = new SnaptradeService(this.fastify);
      await snaptradeService.syncPendingBrokerOrders(Number(position.user_id));
      const { rows } = await this.fastify.pg.query(
        `SELECT *
         FROM positions
         WHERE id = $1`,
        [position.id]
      );
      const refreshed = rows[0];
      if (refreshed?.status === 'OPEN') {
        await this.submitSupersededExit(refreshed, settings, broker, signalId);
        return;
      }
      if (refreshed?.status === 'CLOSED') return;
      throw new Error(`SnapTrade entry order for position #${position.id} is still pending and cannot be safely auto-cancelled by this app`);
    }

    if (position.account_id === 'alpaca_paper' || executionBroker === 'alpaca_paper') {
      const keyId = settings.alpaca_key_id?.trim();
      const secretKey = settings.alpaca_secret_key?.trim();
      const orderId = String(position.broker_order_id || '').trim();
      if (!keyId || !secretKey) throw new Error('Alpaca credentials are not configured for pending-order cancellation');
      if (!orderId) throw new Error(`Alpaca pending position #${position.id} has no broker order id to cancel`);

      const res = await fetch(`https://paper-api.alpaca.markets/v2/orders/${orderId}`, {
        method: 'DELETE',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey
        }
      });
      if (!res.ok && res.status !== 404) {
        const errorText = await res.text();
        throw new Error(`Alpaca paper cancel failed: ${res.status} - ${errorText}`);
      }
    }

    await this.fastify.pg.query(
      `UPDATE positions
       SET status = 'CLOSED',
           execution_status = 'SUPERSEDED',
           execution_error = NULL,
           exit_reason = 'SUPERSEDED',
           notes = COALESCE(notes, '') || $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND status = 'PENDING_ORDER'`,
      [` [Pending entry superseded by Signal #${signalId}${position.account_id === 'alpaca_paper' || executionBroker === 'alpaca_paper' ? '; broker order cancel submitted' : ''}]`, position.id]
    );
  }

  private async submitSupersededExit(position: any, settings: ExecutionSettings, broker: ExecutionBroker, signalId: number): Promise<boolean> {
    try {
      TradeLifecycleService.assertCanRequestExit(position);
    } catch (err: any) {
      throw new Error(`Superseded exit blocked for position #${position.id}: ${err.message}`);
    }

    const executionBroker = String(position.execution_broker || broker || '');
    if (!position.is_simulated && executionBroker === 'wealthsimple_snaptrade') {
      const exitLock = await TradeRedisService.acquireLock(TradeRedisService.keys.exitLock(position.id));
      if (!exitLock.acquired) {
        throw new Error(`Superseded exit blocked for position #${position.id}: another exit request is already in progress`);
      }

      try {
        const snaptradeService = new SnaptradeService(this.fastify);
        await snaptradeService.syncPendingBrokerOrders(Number(position.user_id));

        const { rows } = await this.fastify.pg.query(
          `SELECT *
           FROM positions
           WHERE id = $1`,
          [position.id]
        );
        const refreshed = rows[0];
        try {
          TradeLifecycleService.assertCanRequestExit(refreshed);
        } catch (err: any) {
          if (refreshed?.status === 'CLOSED') return false;
          throw new Error(`Superseded exit blocked for position #${position.id} after broker sync: ${err.message}`);
        }

        const accountId = String(refreshed.execution_account_id || refreshed.account_id || settings.snaptrade_trading_account_id || '').trim();
        if (!accountId) throw new Error('No SnapTrade account id is attached to the superseded position');

        const osiTicker = this.constructOSITicker(refreshed.symbol, Number(refreshed.strike_price), refreshed.option_type, refreshed.expiration_date);
        const order = await snaptradeService.placeOptionOrder(
          Number(refreshed.user_id),
          accountId,
          osiTicker,
          'SELL_TO_CLOSE',
          Number(refreshed.quantity || 1),
          'MARKET'
        );

        await TradeLifecycleService.markExitSubmitted(
          this.fastify.pg,
          refreshed.id,
          order,
          {
            reason: 'SUPERSEDED',
            orderType: 'MARKET',
            note: ` [Superseded by Signal #${signalId}; SnapTrade MARKET exit submitted${order.orderId ? `: ${order.orderId}` : ''}]`
          }
        );
        await TradeRedisService.recordEvent(this.fastify.pg, {
          userId: Number(refreshed.user_id),
          positionId: refreshed.id,
          eventType: 'EXIT_REQUESTED',
          message: `Superseded by Signal #${signalId}; SnapTrade close submitted`,
          metadata: { orderId: order.orderId || null, tradeId: order.tradeId || null, reason: 'SUPERSEDED' }
        });
        await TradeRedisService.rebuildOpenTrades(this.fastify.pg, Number(refreshed.user_id), this.fastify);
        await TradeRedisService.requestBrokerSync(Number(refreshed.user_id));
        this.scheduleSnapTradePendingSync(Number(refreshed.user_id));
        return true;
      } finally {
        await TradeRedisService.releaseLock(exitLock);
      }
    }

    if (position.account_id === 'alpaca_paper' || executionBroker === 'alpaca_paper') {
      const keyId = settings.alpaca_key_id?.trim();
      const secretKey = settings.alpaca_secret_key?.trim();
      if (!keyId || !secretKey) throw new Error('Alpaca credentials are not configured for superseded exit');

      const osiTicker = this.constructOSITicker(position.symbol, Number(position.strike_price), position.option_type, position.expiration_date);
      const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method: 'POST',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          symbol: osiTicker,
          qty: Number(position.quantity || 1),
          side: 'sell',
          type: 'market',
          time_in_force: 'day'
        })
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Alpaca paper superseded exit failed: ${res.status} - ${errorText}`);
      }
      const orderData: any = await res.json();
      await this.fastify.pg.query(
        `UPDATE positions
         SET execution_status = 'PENDING_EXIT',
             execution_error = NULL,
             broker_exit_order_id = $1,
             exit_reason = 'SUPERSEDED',
             exit_order_type = 'MARKET',
             exit_requested_at = CURRENT_TIMESTAMP,
             notes = COALESCE(notes, '') || $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
           AND status = 'OPEN'`,
        [
          orderData.id || null,
          ` [Superseded by Signal #${signalId}; Alpaca paper MARKET exit submitted${orderData.id ? `: ${orderData.id}` : ''}]`,
          position.id
        ]
      );
      return true;
    }

    const exitPrice = Number(position.current_price || position.entry_price || 0);
    const realizedPnl = (exitPrice - Number(position.entry_price || 0)) * Number(position.quantity || 1) * 100;
    await this.fastify.pg.query(
      `UPDATE positions
       SET status = 'CLOSED',
           execution_status = 'SUPERSEDED',
           exit_price = $1,
           realized_pnl = $2,
           exit_reason = 'SUPERSEDED',
           notes = COALESCE(notes, '') || $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
         AND status = 'OPEN'`,
      [
        exitPrice,
        realizedPnl,
        ` [Simulated/non-live position superseded by Signal #${signalId}]`,
        position.id
      ]
    );
    return true;
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async getSignalOptionDetails(signalId: number): Promise<any> {
    const { rows } = await this.fastify.pg.query(
      'SELECT option_details FROM signals WHERE id = $1',
      [signalId]
    );
    const raw = rows[0]?.option_details;
    if (!raw) return {};
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return raw;
  }

  private parseAlpacaTimestamp(value: any): number | null {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async fetchAlpacaOptionSnapshot(osiTicker: string, keyId?: string, secretKey?: string): Promise<EntryQuoteSnapshot | null> {
    const alpacaKeyId = keyId?.trim();
    const alpacaSecretKey = secretKey?.trim();
    if (!alpacaKeyId || !alpacaSecretKey) return null;

    const snapRes = await fetch(`https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${encodeURIComponent(osiTicker)}`, {
      headers: {
        'APCA-API-KEY-ID': alpacaKeyId,
        'APCA-API-SECRET-KEY': alpacaSecretKey
      }
    });
    if (!snapRes.ok) {
      const detail = await snapRes.text().catch(() => '');
      throw new Error(`Alpaca option quote check failed: ${snapRes.status}${detail ? ` - ${detail}` : ''}`);
    }

    const snapData: any = await snapRes.json();
    const snap = snapData.snapshots?.[osiTicker];
    if (!snap) return null;

    const bid = Number(snap.latestQuote?.bp || 0);
    const ask = Number(snap.latestQuote?.ap || 0);
    const last = Number(snap.latestTrade?.p || 0);
    const mid = bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : 0;
    const mark = mid > 0 ? mid : last > 0 ? Number(last.toFixed(2)) : 0;
    const spreadPct = bid > 0 && ask > 0 && mid > 0 ? Number((((ask - bid) / mid) * 100).toFixed(2)) : null;
    const quoteTimeMs = this.parseAlpacaTimestamp(snap.latestQuote?.t);
    const tradeTimeMs = this.parseAlpacaTimestamp(snap.latestTrade?.t);
    const now = Date.now();
    const quoteAgeMs = quoteTimeMs ? Math.max(0, now - quoteTimeMs) : null;
    const tradeAgeMs = tradeTimeMs ? Math.max(0, now - tradeTimeMs) : null;
    const timestampMs = quoteTimeMs || tradeTimeMs;

    return {
      ticker: osiTicker,
      bid,
      ask,
      last,
      mid,
      mark,
      spreadPct,
      quoteAgeMs,
      tradeAgeMs,
      timestamp: timestampMs ? new Date(timestampMs).toISOString() : null
    };
  }

  private assertEntryQuote(quote: EntryQuoteSnapshot, intendedEntry: number, baselineMark: number | null, stabilityMovePct: number | null) {
    if (!quote || quote.mark <= 0) {
      throw new Error('Entry skipped: no usable live option quote was available');
    }
    if (quote.quoteAgeMs !== null && quote.quoteAgeMs > this.ENTRY_MAX_QUOTE_AGE_MS) {
      throw new Error(`Entry skipped: option quote is stale (${Math.round(quote.quoteAgeMs / 1000)}s old)`);
    }
    if (!quote.bid || !quote.ask || quote.bid <= 0 || quote.ask <= 0 || quote.spreadPct === null) {
      throw new Error('Entry skipped: option quote is missing a usable bid/ask spread');
    }
    if (quote.spreadPct > this.ENTRY_MAX_SPREAD_PCT) {
      throw new Error(`Entry skipped: option spread ${quote.spreadPct}% is wider than ${this.ENTRY_MAX_SPREAD_PCT}%`);
    }
    if (intendedEntry > 0 && quote.bid < intendedEntry * this.ENTRY_MIN_BID_TO_ENTRY_RATIO) {
      const underwaterPct = Number(((1 - quote.bid / intendedEntry) * 100).toFixed(1));
      throw new Error(`Entry skipped: immediate sellable bid $${quote.bid.toFixed(2)} is ${underwaterPct}% below intended entry $${intendedEntry.toFixed(2)}`);
    }
    if (baselineMark && baselineMark > 0) {
      const movePct = ((quote.mark - baselineMark) / baselineMark) * 100;
      if (movePct > this.ENTRY_MAX_PREMIUM_JUMP_PCT) {
        throw new Error(`Entry skipped: premium jumped ${movePct.toFixed(1)}% from signal mark $${baselineMark.toFixed(2)} to $${quote.mark.toFixed(2)}`);
      }
    }
    if (stabilityMovePct !== null && Math.abs(stabilityMovePct) > this.ENTRY_MAX_STABILITY_MOVE_PCT) {
      throw new Error(`Entry skipped: premium moved ${Math.abs(stabilityMovePct).toFixed(1)}% during quote stability check`);
    }
  }

  private async validateEntryQuote(input: ExecuteSignalInput, settings: ExecutionSettings, osiTicker: string, plannedLimit: number | undefined): Promise<EntryQuoteValidation> {
    const optionDetails = await this.getSignalOptionDetails(input.signalId);
    const baselineMark = Number(optionDetails?.mark || input.mark || 0) > 0 ? Number(optionDetails?.mark || input.mark) : null;
    const intendedEntry = Number(plannedLimit || baselineMark || input.mark || 0);

    const firstQuote = await this.fetchAlpacaOptionSnapshot(osiTicker, settings.alpaca_key_id, settings.alpaca_secret_key);
    if (!firstQuote) {
      throw new Error('Entry skipped: live option quote validation is unavailable');
    }
    await this.wait(this.ENTRY_STABILITY_DELAY_MS);
    const finalQuote = await this.fetchAlpacaOptionSnapshot(osiTicker, settings.alpaca_key_id, settings.alpaca_secret_key);
    if (!finalQuote) {
      throw new Error('Entry skipped: final live option quote validation is unavailable');
    }

    const stabilityMovePct = firstQuote.mark > 0
      ? Number((((finalQuote.mark - firstQuote.mark) / firstQuote.mark) * 100).toFixed(2))
      : null;
    const effectiveIntendedEntry = intendedEntry > 0 ? intendedEntry : finalQuote.mark;
    this.assertEntryQuote(finalQuote, effectiveIntendedEntry, baselineMark, stabilityMovePct);

    const protectedLimit = Number(Math.min(
      finalQuote.ask,
      finalQuote.mid * (1 + this.ENTRY_PROTECTED_LIMIT_OVER_MID_PCT / 100)
    ).toFixed(2));

    return {
      quote: finalQuote,
      protectedLimit,
      baselineMark,
      movePct: baselineMark ? Number((((finalQuote.mark - baselineMark) / baselineMark) * 100).toFixed(2)) : null,
      stabilityMovePct
    };
  }

  private async executeAlpacaPaperTrade(input: ExecuteSignalInput, settings: ExecutionSettings, quantity: number) {
    const keyId = settings.alpaca_key_id?.trim();
    const secretKey = settings.alpaca_secret_key?.trim();
    if (!keyId || !secretKey) {
      const message = 'Alpaca credentials are not configured';
      await this.markSignalExecutionFailure(input.userId, input.signalId, message);
      return { success: false, broker: 'alpaca_paper', message };
    }

    const osiTicker = this.constructOSITicker(input.symbol, input.chosenStrike, input.winningSide, input.chosenExpiry);
    const slippagePct = Math.max(0, Number(settings.entry_slippage_pct || 3));
    const useLimitOrder = input.mark !== null && input.mark > 0 && (settings.order_type || 'LIMIT') === 'LIMIT';
    let limitPrice = useLimitOrder ? Number((input.mark! * (1 + slippagePct / 100)).toFixed(2)) : undefined;
    let entryQuoteValidation: EntryQuoteValidation | null = null;

    try {
      const validatedQuote = await this.validateEntryQuote(input, settings, osiTicker, limitPrice);
      entryQuoteValidation = validatedQuote;
      limitPrice = validatedQuote.protectedLimit;
    } catch (err: any) {
      const message = err.message || String(err);
      await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
      this.fastify.log.info(`[TradeExecutionService] ${message}`);
      return { success: false, skipped: true, broker: 'alpaca_paper', message };
    }

    const orderPayload: any = {
      symbol: osiTicker,
      qty: quantity,
      side: 'buy',
      type: 'limit',
      time_in_force: 'day'
    };
    if (limitPrice) orderPayload.limit_price = limitPrice.toString();

    try {
      const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method: 'POST',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Alpaca paper order failed: ${res.status} - ${errorText}`);
      }

      const orderData: any = await res.json();
      const entryPrice = entryQuoteValidation?.quote.mark || await this.resolveEntryPriceFromAlpaca(osiTicker, input.mark, keyId, secretKey);
      const orderFilled = ['filled', 'partially_filled'].includes(String(orderData.status || '').toLowerCase());
      const executionStatus = orderFilled ? 'EXECUTED' : 'PENDING';
      const position = await this.insertExecutedPosition(input, {
        quantity,
        entryPrice,
        isSimulated: true,
        accountId: 'alpaca_paper',
        executionBroker: 'alpaca_paper',
        brokerOrderId: orderData.id || null,
        brokerTradeId: null,
        executionStatus,
        positionStatus: orderFilled ? 'OPEN' : 'PENDING_ORDER',
        takeProfitPct: settings.take_profit_pct,
        notes: `[Alpaca paper trade ${orderData.id || 'submitted'} from Signal #${input.signalId}]`
      });

      await this.recordTradeEventBestEffort({
        userId: input.userId,
        positionId: position?.id || null,
        eventType: orderFilled ? 'ENTRY_FILLED' : 'ENTRY_ORDER_SUBMITTED',
        message: `Alpaca paper ${orderPayload.type} entry ${orderFilled ? 'filled' : 'submitted'} from Signal #${input.signalId}`,
        metadata: {
          signalId: input.signalId,
          broker: 'alpaca_paper',
          orderId: orderData.id || null,
          quantity,
          orderType: orderPayload.type,
          protectedLimit: limitPrice,
          entryQuoteValidation,
          setupGrade: await this.getSignalSetupGrade(input.signalId),
          contract: this.contractLabel(input),
          entryPrice,
          stopUnderlying: input.stopUnderlying,
          targetUnderlying: input.targetUnderlying
        }
      });
      await this.markSignalExecuted(input.userId, input.signalId, 'alpaca_paper', orderData.id || null, null, quantity, executionStatus);
      await this.invalidateUserCaches(input.userId);
      return { success: true, broker: 'alpaca_paper', orderId: orderData.id, quantity, executionStatus };
    } catch (err: any) {
      await this.markSignalExecutionFailure(input.userId, input.signalId, err.message);
      throw err;
    }
  }

  private async executeSnapTradeOptionTrade(input: ExecuteSignalInput, settings: ExecutionSettings, quantity: number) {
    if (settings.live_trading_acknowledged !== 'true') {
      const message = 'Wealthsimple live trading acknowledgement is required';
      await this.markSignalExecutionFailure(input.userId, input.signalId, message);
      return { success: false, broker: 'wealthsimple_snaptrade', message };
    }

    const accountId = settings.snaptrade_trading_account_id?.trim();
    if (!accountId) {
      const message = 'No Wealthsimple/SnapTrade trading account selected';
      await this.markSignalExecutionFailure(input.userId, input.signalId, message);
      return { success: false, broker: 'wealthsimple_snaptrade', message };
    }

    const osiTicker = this.constructOSITicker(input.symbol, input.chosenStrike, input.winningSide, input.chosenExpiry);
    const slippagePct = Math.max(0, Number(settings.entry_slippage_pct || 3));
    const useLimitOrder = input.mark !== null && input.mark > 0 && (settings.order_type || 'LIMIT') === 'LIMIT';
    let limitPrice = useLimitOrder ? (input.mark! * (1 + slippagePct / 100)).toFixed(2) : undefined;
    let orderType: 'LIMIT' | 'MARKET' = useLimitOrder ? 'LIMIT' : 'MARKET';
    let entryQuoteValidation: EntryQuoteValidation | null = null;

    try {
      try {
        const validatedQuote = await this.validateEntryQuote(input, settings, osiTicker, limitPrice ? Number(limitPrice) : undefined);
        entryQuoteValidation = validatedQuote;
        limitPrice = validatedQuote.protectedLimit.toFixed(2);
        orderType = 'LIMIT';
      } catch (err: any) {
        const message = err.message || String(err);
        await this.markSignalExecutionFailure(input.userId, input.signalId, message, true);
        this.fastify.log.info(`[TradeExecutionService] ${message}`);
        return { success: false, skipped: true, broker: 'wealthsimple_snaptrade', message };
      }

      const snaptradeService = new SnaptradeService(this.fastify);
      const result = await snaptradeService.placeOptionOrder(
        input.userId,
        accountId,
        osiTicker,
        'BUY_TO_OPEN',
        quantity,
        orderType,
        limitPrice
      );

      const position = await this.insertExecutedPosition(input, {
        quantity,
        entryPrice: entryQuoteValidation?.quote.mark || input.mark || Number(limitPrice || 1),
        isSimulated: false,
        accountId,
        executionBroker: 'wealthsimple_snaptrade',
        brokerOrderId: result.orderId || null,
        brokerTradeId: result.tradeId || null,
        executionStatus: 'PENDING',
        positionStatus: 'PENDING_ORDER',
        takeProfitPct: settings.take_profit_pct,
        notes: `[Wealthsimple/SnapTrade live trade ${result.orderId || result.tradeId || 'submitted'} from Signal #${input.signalId}]`
      });

      await this.recordTradeEventBestEffort({
        userId: input.userId,
        positionId: position?.id || null,
        eventType: 'ENTRY_ORDER_SUBMITTED',
        message: `Wealthsimple ${orderType} entry submitted from Signal #${input.signalId}`,
        metadata: {
          signalId: input.signalId,
          broker: 'wealthsimple_snaptrade',
          orderId: result.orderId || null,
          tradeId: result.tradeId || null,
          quantity,
          orderType,
          limitPrice: limitPrice || null,
          entryQuoteValidation,
          setupGrade: await this.getSignalSetupGrade(input.signalId),
          contract: this.contractLabel(input),
          mark: input.mark,
          stopUnderlying: input.stopUnderlying,
          targetUnderlying: input.targetUnderlying
        }
      });
      await this.markSignalExecuted(input.userId, input.signalId, 'wealthsimple_snaptrade', result.orderId || null, result.tradeId || null, quantity, 'PENDING');
      await this.invalidateUserCaches(input.userId);
      await TradeRedisService.requestBrokerSync(input.userId);
      this.scheduleSnapTradePendingSync(input.userId);
      return { success: true, broker: 'wealthsimple_snaptrade', orderId: result.orderId, tradeId: result.tradeId, quantity, executionStatus: 'PENDING' };
    } catch (err: any) {
      await this.markSignalExecutionFailure(input.userId, input.signalId, err.message);
      throw err;
    }
  }

  private async createSimulatedPosition(input: ExecuteSignalInput, quantity: number, reason: string) {
    const position = await this.insertExecutedPosition(input, {
      quantity,
      entryPrice: input.mark || 1,
      isSimulated: true,
      accountId: 'simulated',
      executionBroker: 'simulated',
      brokerOrderId: null,
      brokerTradeId: null,
      executionStatus: 'SIMULATED',
      notes: `[Simulated position from Signal #${input.signalId}: ${reason}]`
    });
    await this.recordTradeEventBestEffort({
      userId: input.userId,
      positionId: position?.id || null,
      eventType: 'ENTRY_FILLED',
      message: `Simulated entry created from Signal #${input.signalId}`,
      metadata: {
        signalId: input.signalId,
        broker: 'simulated',
        quantity,
        setupGrade: await this.getSignalSetupGrade(input.signalId),
        contract: this.contractLabel(input),
        reason
      }
    });
    await this.markSignalExecuted(input.userId, input.signalId, 'simulated', null, null, quantity);
    await this.invalidateUserCaches(input.userId);
    return { success: true, broker: 'simulated', quantity };
  }

  private async insertExecutedPosition(input: ExecuteSignalInput, execution: {
    quantity: number;
    entryPrice: number;
    isSimulated: boolean;
    accountId: string;
    executionBroker: string;
    brokerOrderId: string | null;
    brokerTradeId: string | null;
    executionStatus: string;
    positionStatus?: string;
    takeProfitPct?: string;
    notes: string;
  }) {
    const entryPrice = Math.max(Number(execution.entryPrice || input.mark || 1), 0.01);
    const premiumStopLoss = Number((entryPrice * 0.8).toFixed(2));
    const configuredTakeProfitPct = this.parseOptionalPct(execution.takeProfitPct, 500);
    const premiumTakeProfit = configuredTakeProfitPct !== null
      ? Number((entryPrice * (1 + configuredTakeProfitPct / 100)).toFixed(2))
      : null;

    const { rows } = await this.fastify.pg.query(
      `INSERT INTO positions (
        user_id, symbol, option_type, strike_price, expiration_date,
        entry_price, quantity, stop_loss_trigger, take_profit_trigger,
        trailing_high_price, trailing_stop_loss_pct, current_price,
        status, is_simulated, account_id, notes, execution_broker,
        broker_order_id, broker_trade_id, execution_account_id, execution_status, contracts_requested,
        suggested_stop_loss, suggested_take_profit_1,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
        $23, $24,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING *`,
      [
        input.userId,
        input.symbol,
        input.winningSide,
        input.chosenStrike,
        input.chosenExpiry,
        entryPrice,
        execution.quantity,
        premiumStopLoss,
        premiumTakeProfit,
        entryPrice,
        null,
        entryPrice,
        execution.positionStatus || 'OPEN',
        execution.isSimulated,
        execution.accountId,
        `${execution.notes} [Auto exits: premium SL $${premiumStopLoss}, premium TP ${premiumTakeProfit === null ? 'suggested TP only' : `$${premiumTakeProfit}`}, underlying SL ${input.stopUnderlying}, underlying TP ${input.targetUnderlying}]`,
        execution.executionBroker,
        execution.brokerOrderId,
        execution.brokerTradeId,
        execution.accountId,
        execution.executionStatus,
        execution.quantity,
        input.stopUnderlying,
        input.targetUnderlying
      ]
    );

    const streamers = [
      (this.fastify as any).alpacaMarketDataStreamer,
      (this.fastify as any).streamer
    ];
    for (const streamer of streamers) {
      if (streamer?.syncSubscriptions) {
        streamer.syncSubscriptions().catch((err: any) => {
          this.fastify.log.warn(`[TradeExecutionService] Failed to refresh stream subscriptions: ${err.message}`);
        });
      }
    }

    return rows[0] || null;
  }

  private async recordTradeEventBestEffort(event: {
    userId: number;
    positionId?: number | string | null;
    eventType: string;
    message?: string | null;
    metadata?: any;
  }) {
    try {
      await TradeRedisService.recordEvent(this.fastify.pg, event);
    } catch (err: any) {
      this.fastify.log.warn(`[TradeExecutionService] Failed to record trade event ${event.eventType}: ${err.message}`);
    }
  }

  private async resolveEntryPriceFromAlpaca(osiTicker: string, mark: number | null, keyId: string, secretKey: string): Promise<number> {
    if (mark && mark > 0) return mark;
    try {
      const snapRes = await fetch(`https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${osiTicker}`, {
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey
        }
      });
      if (snapRes.ok) {
        const snapData: any = await snapRes.json();
        const snap = snapData.snapshots?.[osiTicker];
        if (snap) {
          const bid = snap.latestQuote?.bp || 0;
          const ask = snap.latestQuote?.ap || 0;
          if (bid > 0 && ask > 0) return Number(((bid + ask) / 2).toFixed(2));
          if (snap.latestTrade?.p) return Number(snap.latestTrade.p);
        }
      }
    } catch (err: any) {
      this.fastify.log.warn(`[TradeExecutionService] Failed to resolve Alpaca entry price: ${err.message}`);
    }
    return 1;
  }

  private async markSignalExecuted(userId: number, signalId: number, broker: string, orderId: string | null, tradeId: string | null, quantity: number, executionStatus: string = 'EXECUTED') {
    await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (
         signal_id, user_id, status, execution_broker, broker_order_id, broker_trade_id,
         execution_status, execution_error, contracts_requested, updated_at
       )
       VALUES ($1, $2, 'EXECUTED', $3, $4, $5, $6, NULL, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = 'EXECUTED',
           execution_broker = EXCLUDED.execution_broker,
           broker_order_id = EXCLUDED.broker_order_id,
           broker_trade_id = EXCLUDED.broker_trade_id,
           execution_status = EXCLUDED.execution_status,
           execution_error = NULL,
           contracts_requested = EXCLUDED.contracts_requested,
           updated_at = CURRENT_TIMESTAMP`,
      [signalId, userId, broker, orderId, tradeId, executionStatus, quantity]
    );
  }

  private async markSignalExecutionFailure(userId: number, signalId: number, error: string, skipped = false) {
    const executionStatus = skipped ? 'SKIPPED' : 'FAILED';
    const status = skipped ? 'CANCELLED' : 'PENDING';

    await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (
         signal_id, user_id, status, execution_status, execution_error, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = EXCLUDED.status,
           execution_status = EXCLUDED.execution_status,
           execution_error = EXCLUDED.execution_error,
           updated_at = CURRENT_TIMESTAMP`,
      [signalId, userId, status, executionStatus, error]
    );
  }

  private async invalidateUserCaches(userId: number) {
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);
    await TradeRedisService.rebuildOpenTrades(this.fastify.pg, userId, this.fastify);
  }

  private scheduleSnapTradePendingSync(userId: number) {
    const delays = [5000, 30000, 120000];
    for (const delayMs of delays) {
      setTimeout(() => {
        const snaptradeService = new SnaptradeService(this.fastify);
        snaptradeService.syncPendingBrokerOrders(userId).catch((err: any) => {
          this.fastify.log.warn(`[TradeExecutionService] SnapTrade pending sync failed after ${delayMs}ms: ${err.message}`);
        });
      }, delayMs);
    }
  }

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : expiration.split('T')[0];
    const [year, month, day] = dateStr.split('-');
    const yy = year.slice(-2);
    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${month}${day}${side}${strikeValue}`;
  }
}
