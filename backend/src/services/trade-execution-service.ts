import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';
import { SnaptradeService } from './snaptrade-service';

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
  live_trading_acknowledged?: string;
  alpaca_key_id?: string;
  alpaca_secret_key?: string;
}

export class TradeExecutionService {
  constructor(private fastify: FastifyInstance) {}

  public async getSettingsForUser(userId: number): Promise<ExecutionSettings> {
    const { rows } = await this.fastify.pg.query(
      'SELECT key, value FROM settings WHERE user_id = $1',
      [userId]
    );
    const dbSettings = rows.reduce((acc: any, row: any) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    return {
      execution_broker: 'none',
      alpaca_auto_trade: 'false',
      snaptrade_auto_trade: 'false',
      snaptrade_trading_account_id: '',
      max_trades_per_day: '2',
      contracts_per_trade: '1',
      order_type: 'LIMIT',
      entry_slippage_pct: '3',
      live_trading_acknowledged: 'false',
      ...dbSettings
    };
  }

  public async executeSignal(input: ExecuteSignalInput, settingsOverride?: ExecutionSettings) {
    const settings = settingsOverride || await this.getSettingsForUser(input.userId);
    const broker = this.resolveBroker(settings);
    const quantity = this.parsePositiveInt(settings.contracts_per_trade, 1, 100);
    const maxTradesPerDay = this.parsePositiveInt(settings.max_trades_per_day, 2, 100);

    if (broker === 'none') {
      return this.createSimulatedPosition(input, quantity, 'Broker execution disabled');
    }

    const currentTradeCount = await this.countTradesToday(input.userId);
    if (currentTradeCount >= maxTradesPerDay) {
      const message = `Daily trade limit reached (${currentTradeCount}/${maxTradesPerDay})`;
      await this.markSignalExecutionFailure(input.signalId, message, true);
      return { success: false, skipped: true, broker, message };
    }

    if (broker === 'alpaca_paper') {
      return this.executeAlpacaPaperTrade(input, settings, quantity);
    }

    if (broker === 'wealthsimple_snaptrade') {
      return this.executeSnapTradeOptionTrade(input, settings, quantity);
    }

    return this.createSimulatedPosition(input, quantity, 'Unknown execution broker');
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

  private async executeAlpacaPaperTrade(input: ExecuteSignalInput, settings: ExecutionSettings, quantity: number) {
    const keyId = settings.alpaca_key_id?.trim();
    const secretKey = settings.alpaca_secret_key?.trim();
    if (!keyId || !secretKey) {
      const message = 'Alpaca credentials are not configured';
      await this.markSignalExecutionFailure(input.signalId, message);
      return { success: false, broker: 'alpaca_paper', message };
    }

    const osiTicker = this.constructOSITicker(input.symbol, input.chosenStrike, input.winningSide, input.chosenExpiry);
    const slippagePct = Math.max(0, Number(settings.entry_slippage_pct || 3));
    const useLimitOrder = input.mark !== null && input.mark > 0 && (settings.order_type || 'LIMIT') === 'LIMIT';
    const limitPrice = useLimitOrder ? Number((input.mark! * (1 + slippagePct / 100)).toFixed(2)) : undefined;

    const orderPayload: any = {
      symbol: osiTicker,
      qty: quantity,
      side: 'buy',
      type: useLimitOrder ? 'limit' : 'market',
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
      const entryPrice = await this.resolveEntryPriceFromAlpaca(osiTicker, input.mark, keyId, secretKey);
      const orderFilled = ['filled', 'partially_filled'].includes(String(orderData.status || '').toLowerCase());
      const executionStatus = orderFilled ? 'EXECUTED' : 'PENDING';
      await this.insertExecutedPosition(input, {
        quantity,
        entryPrice,
        isSimulated: true,
        accountId: 'alpaca_paper',
        executionBroker: 'alpaca_paper',
        brokerOrderId: orderData.id || null,
        brokerTradeId: null,
        executionStatus,
        positionStatus: orderFilled ? 'OPEN' : 'PENDING_ORDER',
        notes: `[Alpaca paper trade ${orderData.id || 'submitted'} from Signal #${input.signalId}]`
      });

      await this.markSignalExecuted(input.signalId, 'alpaca_paper', orderData.id || null, null, quantity, executionStatus);
      await this.invalidateUserCaches(input.userId);
      return { success: true, broker: 'alpaca_paper', orderId: orderData.id, quantity, executionStatus };
    } catch (err: any) {
      await this.markSignalExecutionFailure(input.signalId, err.message);
      throw err;
    }
  }

  private async executeSnapTradeOptionTrade(input: ExecuteSignalInput, settings: ExecutionSettings, quantity: number) {
    if (settings.live_trading_acknowledged !== 'true') {
      const message = 'Wealthsimple live trading acknowledgement is required';
      await this.markSignalExecutionFailure(input.signalId, message);
      return { success: false, broker: 'wealthsimple_snaptrade', message };
    }

    const accountId = settings.snaptrade_trading_account_id?.trim();
    if (!accountId) {
      const message = 'No Wealthsimple/SnapTrade trading account selected';
      await this.markSignalExecutionFailure(input.signalId, message);
      return { success: false, broker: 'wealthsimple_snaptrade', message };
    }

    const osiTicker = this.constructOSITicker(input.symbol, input.chosenStrike, input.winningSide, input.chosenExpiry);
    const slippagePct = Math.max(0, Number(settings.entry_slippage_pct || 3));
    const useLimitOrder = input.mark !== null && input.mark > 0 && (settings.order_type || 'LIMIT') === 'LIMIT';
    const limitPrice = useLimitOrder ? (input.mark! * (1 + slippagePct / 100)).toFixed(2) : undefined;
    const orderType: 'LIMIT' | 'MARKET' = useLimitOrder ? 'LIMIT' : 'MARKET';

    try {
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

      await this.insertExecutedPosition(input, {
        quantity,
        entryPrice: input.mark || Number(limitPrice || 1),
        isSimulated: false,
        accountId,
        executionBroker: 'wealthsimple_snaptrade',
        brokerOrderId: result.orderId || null,
        brokerTradeId: result.tradeId || null,
        executionStatus: 'PENDING',
        positionStatus: 'PENDING_ORDER',
        notes: `[Wealthsimple/SnapTrade live trade ${result.orderId || result.tradeId || 'submitted'} from Signal #${input.signalId}]`
      });

      await this.markSignalExecuted(input.signalId, 'wealthsimple_snaptrade', result.orderId || null, result.tradeId || null, quantity, 'PENDING');
      await this.invalidateUserCaches(input.userId);
      this.scheduleSnapTradePendingSync(input.userId);
      return { success: true, broker: 'wealthsimple_snaptrade', orderId: result.orderId, tradeId: result.tradeId, quantity, executionStatus: 'PENDING' };
    } catch (err: any) {
      await this.markSignalExecutionFailure(input.signalId, err.message);
      throw err;
    }
  }

  private async createSimulatedPosition(input: ExecuteSignalInput, quantity: number, reason: string) {
    await this.insertExecutedPosition(input, {
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
    await this.markSignalExecuted(input.signalId, 'simulated', null, null, quantity);
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
    notes: string;
  }) {
    const entryPrice = Math.max(Number(execution.entryPrice || input.mark || 1), 0.01);
    const premiumStopLoss = Number((entryPrice * 0.8).toFixed(2));
    const premiumTakeProfit = Number((entryPrice * 1.4).toFixed(2));

    await this.fastify.pg.query(
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
      )`,
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
        `${execution.notes} [Auto exits: premium SL $${premiumStopLoss}, premium TP $${premiumTakeProfit}, underlying SL ${input.stopUnderlying}, underlying TP ${input.targetUnderlying}]`,
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

  private async markSignalExecuted(signalId: number, broker: string, orderId: string | null, tradeId: string | null, quantity: number, executionStatus: string = 'EXECUTED') {
    await this.fastify.pg.query(
      `UPDATE signals
       SET status = 'EXECUTED',
           execution_broker = $1,
           broker_order_id = $2,
           broker_trade_id = $3,
           execution_status = $4,
           execution_error = NULL,
           contracts_requested = $5
       WHERE id = $6`,
      [broker, orderId, tradeId, executionStatus, quantity, signalId]
    );
  }

  private async markSignalExecutionFailure(signalId: number, error: string, skipped = false) {
    await this.fastify.pg.query(
      `UPDATE signals
       SET status = CASE WHEN $1 = 'SKIPPED' THEN 'CANCELLED' ELSE status END,
           execution_status = $1,
           execution_error = $2
       WHERE id = $3`,
      [skipped ? 'SKIPPED' : 'FAILED', error, signalId]
    );
  }

  private async invalidateUserCaches(userId: number) {
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);
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
