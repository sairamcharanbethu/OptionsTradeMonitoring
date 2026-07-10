import { FastifyInstance } from 'fastify';
import YahooFinance from 'yahoo-finance2';
import { getSettingsWithGlobalFallback, resolveMcpTradingEnabled } from '../lib/settings-utils';
import { redis } from '../lib/redis';
import { IbkrMarketDataService } from './ibkr-market-data-service';
import { SnaptradeService } from './snaptrade-service';
import { TradeLifecycleService } from './trade-lifecycle-service';
import { TradeRedisService } from './trade-redis-service';

export type OptionEntryAction = 'BUY_TO_OPEN' | 'SELL_TO_OPEN';
export type OptionOrderType = 'MARKET' | 'LIMIT';

export type ManualOptionOrderInput = {
  symbol: string;
  optionType: 'CALL' | 'PUT';
  strike: number;
  expiration: string;
  quantity: number;
  orderType: OptionOrderType;
  limitPrice?: number | null;
  underlyingStopPrice?: number | null;
  action?: OptionEntryAction;
  clientOrderId?: string;
  source?: 'manual-entry' | 'mcp';
};

export type ManualOptionOrderResult = {
  success: true;
  reusedIdempotencyResult?: boolean;
  orderId: string | null;
  tradeId: string | null;
  optionSymbol: string;
  position: any;
};

type ManualEntrySettings = {
  slippagePct: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
};

const SETTING_KEYS = {
  slippagePct: 'manual_entry_slippage_pct',
  takeProfitPct: 'manual_entry_take_profit_pct',
  stopLossPct: 'manual_entry_stop_loss_pct'
};

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const MAX_ENTRY_QUOTE_AGE_MS = 60_000;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const MCP_MARKET_PENDING_ENTRY_PRICE = 0.01;

function normalizeSettings(settings: Record<string, string>): ManualEntrySettings {
  const slippagePct = Number(settings[SETTING_KEYS.slippagePct] || 3);
  const takeProfitPct = Number(settings[SETTING_KEYS.takeProfitPct] || 0);
  const stopLossPct = Number(settings[SETTING_KEYS.stopLossPct] || 0);

  return {
    slippagePct: Number.isFinite(slippagePct) && slippagePct >= 0 ? slippagePct : 3,
    takeProfitPct: Number.isFinite(takeProfitPct) && takeProfitPct > 0 ? takeProfitPct : null,
    stopLossPct: Number.isFinite(stopLossPct) && stopLossPct > 0 ? stopLossPct : null
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRegularUsMarketSession(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  if (['Sat', 'Sun'].includes(get('weekday'))) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
  const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
  const [year, month, day] = dateStr.split('-');
  const side = type === 'CALL' ? 'C' : 'P';
  return `${symbol.toUpperCase()}${year.slice(-2)}${month}${day}${side}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
}

function toQuotePayload(quote: any) {
  return {
    ticker: quote?.ticker || quote?.symbol || null,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    last: quote?.last ?? null,
    mark: quote?.mark ?? null,
    spreadPct: quote?.spreadPct ?? null,
    quoteAgeMs: quote?.quoteAgeMs ?? null,
    timestamp: quote?.timestamp || new Date().toISOString()
  };
}

function assertUsableEntryQuote(quote: any, intendedEntry: number | null, orderType: OptionOrderType, action: OptionEntryAction) {
  if (!quote || Number(quote.mark || 0) <= 0) {
    throw new Error('A live IBKR quote is required before submitting the order.');
  }
  if (Number(quote.bid || 0) <= 0 || Number(quote.ask || 0) <= 0) {
    throw new Error('Manual option order blocked: selected contract is missing live bid/ask.');
  }
  const quoteAgeMs = quote.quoteAgeMs === null || quote.quoteAgeMs === undefined ? null : Number(quote.quoteAgeMs);
  if (quoteAgeMs !== null && quoteAgeMs > MAX_ENTRY_QUOTE_AGE_MS && (isRegularUsMarketSession() || orderType === 'MARKET')) {
    const ageSeconds = Math.round(quoteAgeMs / 1000);
    const reason = orderType === 'MARKET'
      ? 'market orders require a fresh quote'
      : 'market is open and quote is stale';
    throw new Error(`Manual option order blocked: selected contract quote is stale (${ageSeconds}s old; ${reason}).`);
  }
  if (quote.spreadPct !== null && quote.spreadPct !== undefined && Number(quote.spreadPct) > 15) {
    throw new Error(`Manual option order blocked: bid/ask spread ${Number(quote.spreadPct).toFixed(1)}% is too wide.`);
  }
  if (action === 'BUY_TO_OPEN' && intendedEntry && Number(quote.bid || 0) / intendedEntry < 0.9) {
    throw new Error('Manual option order blocked: live bid is too far below intended entry.');
  }
  if (action === 'SELL_TO_OPEN' && intendedEntry && intendedEntry < Number(quote.bid || 0) * 0.9) {
    throw new Error('Manual option order blocked: limit premium is too far below the current bid.');
  }
}

async function fetchUnderlyingPrice(symbol: string): Promise<number | null> {
  try {
    const quote = await yahooFinance.quote(symbol);
    const price = Number((quote as any)?.regularMarketPrice || (quote as any)?.postMarketPrice || (quote as any)?.preMarketPrice || 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

function idempotencyKey(userId: number, clientOrderId: string) {
  return `MCP_ORDER_IDEMPOTENCY:${userId}:${clientOrderId}`;
}

export class ManualOptionOrderService {
  constructor(private fastify: FastifyInstance) {}

  constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    return constructOSITicker(symbol, strike, type, expiration);
  }

  toQuotePayload(quote: any) {
    return toQuotePayload(quote);
  }

  async getOptionQuote(userId: number, input: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strike: number;
    expiration: string;
  }) {
    const marketData = new IbkrMarketDataService(this.fastify);
    return marketData.getOptionQuote(userId, {
      symbol: input.symbol.toUpperCase(),
      expiration: input.expiration,
      right: input.optionType === 'CALL' ? 'call' : 'put',
      strike: input.strike
    });
  }

  async getGuardrails(userId: number) {
    const settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
    return {
      userId,
      enabled: resolveMcpTradingEnabled(settings),
      authMode: 'app_jwt',
      allowedActions: ['BUY_TO_OPEN', 'SELL_TO_OPEN'],
      allowedOrderTypes: ['LIMIT', 'MARKET'],
      limitPremiumRequired: true,
      premiumSemantics: 'LIMIT premium is submitted as the exact limit price.',
      liveTradingAcknowledged: settings.live_trading_acknowledged === 'true',
      hasSelectedSnapTradeAccount: Boolean(String(settings.snaptrade_trading_account_id || '').trim()),
      quoteValidation: {
        requiredForMcpOrders: false,
        mode: 'MCP orders relay directly to SnapTrade/Wealthsimple without IBKR quote validation.',
        getOptionQuoteAvailable: true
      },
      shortOpenGuard: 'Broker eligibility and margin checks are delegated to SnapTrade/Wealthsimple.'
    };
  }

  async submit(userId: number, rawInput: ManualOptionOrderInput): Promise<ManualOptionOrderResult> {
    const input = {
      ...rawInput,
      symbol: rawInput.symbol.toUpperCase(),
      action: rawInput.action || 'BUY_TO_OPEN'
    };

    const cached = input.clientOrderId ? await redis.get(idempotencyKey(userId, input.clientOrderId)) : null;
    if (cached) {
      return { ...JSON.parse(cached), reusedIdempotencyResult: true };
    }

    const settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
    const manualSettings = normalizeSettings(settings);
    const isMcpRelay = input.source === 'mcp';

    if (settings.live_trading_acknowledged !== 'true') {
      throw new Error('Live trading acknowledgement is required before placing manual option orders.');
    }
    const accountId = String(settings.snaptrade_trading_account_id || '').trim();
    if (!accountId) throw new Error('No Wealthsimple/SnapTrade trading account selected in settings.');
    if (input.orderType === 'LIMIT' && (!input.limitPrice || input.limitPrice <= 0)) {
      throw new Error('A positive premium is required for LIMIT orders.');
    }

    const contractKey = TradeRedisService.contractKey({
      symbol: input.symbol,
      optionType: input.optionType,
      strike: input.strike,
      expiration: input.expiration
    });
    const entryLock = await TradeRedisService.acquireLock(TradeRedisService.keys.entryLock(userId, contractKey), 30);
    if (!entryLock.acquired) throw new Error('An entry request is already in progress for this contract.');

    try {
      const existing = await (this.fastify as any).pg.query(
        `SELECT id, status, execution_status
         FROM positions
         WHERE user_id = $1
           AND symbol = $2
           AND option_type = $3
           AND strike_price = $4
           AND expiration_date::date = $5::date
           AND status IN ('OPEN', 'PENDING_ORDER')
         LIMIT 1`,
        [userId, input.symbol, input.optionType, input.strike, input.expiration]
      );
      if (existing.rows[0]) {
        throw new Error(`An active ${input.symbol} ${input.optionType} ${input.strike} ${input.expiration} trade already exists.`);
      }

      let quote: any = null;
      if (!isMcpRelay) {
        const firstQuote = await this.getOptionQuote(userId, input);
        assertUsableEntryQuote(firstQuote, input.orderType === 'LIMIT' && input.limitPrice ? Number(input.limitPrice) : Number(firstQuote?.mark || 0), input.orderType, input.action);

        await wait(750);
        quote = await this.getOptionQuote(userId, input);
        assertUsableEntryQuote(quote, input.orderType === 'LIMIT' && input.limitPrice ? Number(input.limitPrice) : Number(quote?.mark || 0), input.orderType, input.action);

        const movePct = Number(firstQuote?.mark || 0) > 0
          ? Number((((Number(quote!.mark) - Number(firstQuote!.mark)) / Number(firstQuote!.mark)) * 100).toFixed(2))
          : 0;
        if (Math.abs(movePct) > 8) {
          throw new Error(`Manual option order blocked: premium moved ${movePct}% during quote validation.`);
        }

        if (input.orderType === 'LIMIT' && Number(input.limitPrice) < Number(quote!.bid || 0)) {
          throw new Error('Limit premium is below the current bid.');
        }
        const maxLimit = Number((Number(quote!.ask) * (1 + Math.max(manualSettings.slippagePct, 3) / 100)).toFixed(2));
        if (input.orderType === 'LIMIT' && Number(input.limitPrice) > maxLimit) {
          throw new Error(`Limit premium is above the protected maximum ${maxLimit.toFixed(2)}.`);
        }
      }

      const osiTicker = constructOSITicker(input.symbol, input.strike, input.optionType, input.expiration);
      const entryState = TradeLifecycleService.entrySubmittedStatus(input.orderType);
      const brokerFillPending = isMcpRelay && input.orderType === 'MARKET';
      const entryPrice = isMcpRelay
        ? (brokerFillPending ? MCP_MARKET_PENDING_ENTRY_PRICE : Number(Number(input.limitPrice).toFixed(2)))
        : Number(quote!.mark.toFixed(2));
      const isShortOpen = input.action === 'SELL_TO_OPEN';
      const takeProfitTrigger = !brokerFillPending && !isShortOpen && manualSettings.takeProfitPct
        ? Number((entryPrice * (1 + manualSettings.takeProfitPct / 100)).toFixed(2))
        : null;
      const stopLossDisplay = !brokerFillPending && !isShortOpen && manualSettings.stopLossPct
        ? Number((entryPrice * (1 - manualSettings.stopLossPct / 100)).toFixed(2))
        : null;
      const underlyingStopPrice = input.underlyingStopPrice
        ? Number(Number(input.underlyingStopPrice).toFixed(2))
        : null;
      const underlyingPrice = await fetchUnderlyingPrice(input.symbol);
      const sourceLabel = input.source === 'mcp' ? 'MCP' : 'Manual Entry';

      const insertResult = await (this.fastify as any).pg.query(
        `INSERT INTO positions (
          user_id, symbol, option_type, strike_price, expiration_date,
          entry_price, quantity, stop_loss_trigger, take_profit_trigger,
          trailing_high_price, trailing_stop_loss_pct, current_price, underlying_price, underlying_stop_price,
          status, is_simulated, account_id, notes, execution_broker,
          broker_order_id, broker_trade_id, execution_account_id, execution_status, contracts_requested,
          entry_action, exit_action,
          analysis_data, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, NULL, $8,
          $6, NULL, $6, $12, $13,
          'PENDING_ORDER', FALSE, $9, $10, 'wealthsimple_snaptrade',
          NULL, NULL, $9, 'ENTRY_SUBMITTING', $7,
          $14, $15,
          $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING *`,
        [
          userId,
          input.symbol,
          input.optionType,
          input.strike,
          input.expiration,
          entryPrice,
          input.quantity,
          takeProfitTrigger,
          accountId,
          `[${sourceLabel}] ${input.orderType} ${input.action} preparing. ${brokerFillPending ? 'Broker fill price pending.' : `Stop loss display ${stopLossDisplay === null ? 'not set' : `$${stopLossDisplay}`}.`} Underlying stop ${underlyingStopPrice === null ? 'not set' : `$${underlyingStopPrice}`}.`,
          {
            manualEntry: {
              enabled: input.source !== 'mcp',
              source: input.source || 'manual-entry',
              clientOrderId: input.clientOrderId || null,
              action: input.action,
              orderType: input.orderType,
              limitPrice: input.limitPrice || null,
              takeProfitPct: isShortOpen ? null : manualSettings.takeProfitPct,
              stopLossPct: isShortOpen ? null : manualSettings.stopLossPct,
              initialTakeProfitTrigger: takeProfitTrigger,
              stopLossDisplay,
              underlyingStopPrice,
              quote: quote ? toQuotePayload(quote) : null,
              quoteValidation: isMcpRelay ? 'skipped_mcp_relay' : 'ibkr_live_quote',
              brokerFillPending
            }
          },
          underlyingPrice,
          underlyingStopPrice,
          input.action,
          TradeLifecycleService.exitActionForEntryAction(input.action)
        ]
      );
      const positionId = insertResult.rows[0]?.id;

      let order: any;
      try {
        const snaptrade = new SnaptradeService(this.fastify);
        order = await snaptrade.placeOptionOrder(
          userId,
          accountId,
          osiTicker,
          input.action,
          input.quantity,
          input.orderType,
          input.orderType === 'LIMIT' ? Number(input.limitPrice).toFixed(2) : undefined,
          { skipImpact: true }
        );
      } catch (err: any) {
        await (this.fastify as any).pg.query(
          `UPDATE positions
           SET status = 'CLOSED',
               execution_status = 'ENTRY_FAILED',
               execution_error = $1,
               notes = COALESCE(notes, '') || $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [err.message || String(err), ` [${sourceLabel} broker submit failed: ${err.message || String(err)}]`, positionId]
        );
        await TradeRedisService.recordEvent((this.fastify as any).pg, {
          userId,
          positionId,
          eventType: input.source === 'mcp' ? 'MCP_ENTRY_ORDER_FAILED' : 'MANUAL_ENTRY_ORDER_FAILED',
          message: err.message || String(err),
          metadata: { contract: osiTicker, quantity: input.quantity, orderType: input.orderType, action: input.action }
        });
        throw err;
      }

      const { rows } = await (this.fastify as any).pg.query(
        `UPDATE positions
         SET broker_order_id = $1,
             broker_trade_id = $2,
             execution_status = $3,
             notes = COALESCE(notes, '') || $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING *`,
        [
          order.orderId || null,
          order.tradeId || null,
          entryState.executionStatus,
          ` [${sourceLabel} SnapTrade order submitted${order.orderId ? `: ${order.orderId}` : ''}]`,
          positionId
        ]
      );

      await TradeRedisService.recordEvent((this.fastify as any).pg, {
        userId,
        positionId,
        eventType: input.source === 'mcp' ? 'MCP_ENTRY_ORDER_SUBMITTED' : 'MANUAL_ENTRY_ORDER_SUBMITTED',
        message: `${sourceLabel} Wealthsimple ${input.orderType} ${input.action} submitted`,
        metadata: {
          orderId: order.orderId || null,
          tradeId: order.tradeId || null,
          contract: osiTicker,
          quantity: input.quantity,
          action: input.action,
          orderType: input.orderType,
          limitPrice: input.limitPrice || null,
          quote: quote ? toQuotePayload(quote) : null,
          quoteValidation: isMcpRelay ? 'skipped_mcp_relay' : 'ibkr_live_quote',
          brokerFillPending
        }
      });
      await TradeRedisService.rebuildOpenTrades((this.fastify as any).pg, userId, this.fastify);
      await TradeRedisService.requestBrokerSync(userId);
      (this.fastify as any).ibkrMarketDataStreamer?.syncSubscriptions?.().catch((err: any) => {
        this.fastify.log.warn(`[ManualOptionOrderService] Failed to refresh stream subscriptions after entry: ${err.message}`);
      });

      const result: ManualOptionOrderResult = {
        success: true,
        orderId: order.orderId || null,
        tradeId: order.tradeId || null,
        optionSymbol: osiTicker,
        position: rows[0]
      };
      if (input.clientOrderId) {
        await redis.set(idempotencyKey(userId, input.clientOrderId), JSON.stringify(result), IDEMPOTENCY_TTL_SECONDS);
      }
      return result;
    } finally {
      await TradeRedisService.releaseLock(entryLock);
    }
  }
}
