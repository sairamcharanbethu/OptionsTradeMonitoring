import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { IbkrMarketDataService } from '../services/ibkr-market-data-service';
import { SnaptradeService } from '../services/snaptrade-service';
import { TradeLifecycleService } from '../services/trade-lifecycle-service';
import { TradeRedisService } from '../services/trade-redis-service';

const ManualEntrySettingsSchema = z.object({
  defaultTicker: z.string().trim().max(12).optional(),
  contracts: z.coerce.number().int().min(1).max(100).optional(),
  trimCount: z.coerce.number().int().min(1).max(100).optional(),
  slippagePct: z.coerce.number().min(0).max(100).optional(),
  orderType: z.enum(['MARKET', 'LIMIT']).optional(),
  takeProfitPct: z.coerce.number().min(0).max(1000).optional().nullable(),
  stopLossPct: z.coerce.number().min(0).max(100).optional().nullable()
});

const ChainQuerySchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  optionType: z.enum(['CALL', 'PUT']),
  dte: z.coerce.number().int().min(0).max(2)
});

const QuoteQuerySchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  optionType: z.enum(['CALL', 'PUT']),
  strike: z.coerce.number().positive(),
  expiration: z.string().trim().min(8).max(20)
});

const OrderSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  optionType: z.enum(['CALL', 'PUT']),
  strike: z.coerce.number().positive(),
  expiration: z.string().trim().min(8).max(20),
  quantity: z.coerce.number().int().min(1).max(100),
  orderType: z.enum(['MARKET', 'LIMIT']),
  limitPrice: z.coerce.number().positive().optional().nullable(),
  underlyingStopPrice: z.coerce.number().positive().optional().nullable()
});

const TrimSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(100).optional()
});

type ManualEntrySettings = {
  defaultTicker: string;
  contracts: number;
  trimCount: number;
  slippagePct: number;
  orderType: 'MARKET' | 'LIMIT';
  takeProfitPct: number | null;
  stopLossPct: number | null;
};

const SETTING_KEYS = {
  defaultTicker: 'manual_entry_default_ticker',
  contracts: 'manual_entry_contracts',
  trimCount: 'manual_entry_trim_count',
  slippagePct: 'manual_entry_slippage_pct',
  orderType: 'manual_entry_order_type',
  takeProfitPct: 'manual_entry_take_profit_pct',
  stopLossPct: 'manual_entry_stop_loss_pct'
};

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const MAX_ENTRY_QUOTE_AGE_MS = 60_000;

function normalizeSettings(settings: Record<string, string>): ManualEntrySettings {
  const contracts = Number(settings[SETTING_KEYS.contracts] || 1);
  const trimCount = Number(settings[SETTING_KEYS.trimCount] || 1);
  const slippagePct = Number(settings[SETTING_KEYS.slippagePct] || 3);
  const takeProfitPct = Number(settings[SETTING_KEYS.takeProfitPct] || 0);
  const stopLossPct = Number(settings[SETTING_KEYS.stopLossPct] || 0);
  const orderType = settings[SETTING_KEYS.orderType] === 'MARKET' ? 'MARKET' : 'LIMIT';

  return {
    defaultTicker: String(settings[SETTING_KEYS.defaultTicker] || 'QQQ').trim().toUpperCase(),
    contracts: Number.isFinite(contracts) && contracts > 0 ? Math.min(Math.floor(contracts), 100) : 1,
    trimCount: Number.isFinite(trimCount) && trimCount > 0 ? Math.min(Math.floor(trimCount), 100) : 1,
    slippagePct: Number.isFinite(slippagePct) && slippagePct >= 0 ? slippagePct : 3,
    orderType,
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

function assertUsableEntryQuote(quote: any, intendedEntry: number | null, orderType: 'MARKET' | 'LIMIT') {
  if (!quote || Number(quote.mark || 0) <= 0) {
    throw new Error('A live IBKR quote is required before submitting the order.');
  }
  if (Number(quote.bid || 0) <= 0 || Number(quote.ask || 0) <= 0) {
    throw new Error('Manual entry blocked: selected contract is missing live bid/ask.');
  }
  const quoteAgeMs = quote.quoteAgeMs === null || quote.quoteAgeMs === undefined ? null : Number(quote.quoteAgeMs);
  if (quoteAgeMs !== null && quoteAgeMs > MAX_ENTRY_QUOTE_AGE_MS && (isRegularUsMarketSession() || orderType === 'MARKET')) {
    const ageSeconds = Math.round(quoteAgeMs / 1000);
    const reason = orderType === 'MARKET'
      ? 'market orders require a fresh quote'
      : 'market is open and quote is stale';
    throw new Error(`Manual entry blocked: selected contract quote is stale (${ageSeconds}s old; ${reason}).`);
  }
  if (quote.spreadPct !== null && quote.spreadPct !== undefined && Number(quote.spreadPct) > 15) {
    throw new Error(`Manual entry blocked: bid/ask spread ${Number(quote.spreadPct).toFixed(1)}% is too wide.`);
  }
  if (intendedEntry && Number(quote.bid || 0) / intendedEntry < 0.9) {
    throw new Error('Manual entry blocked: live bid is too far below intended entry.');
  }
}

function calculateDte(expiration: string, now = new Date()): number {
  const [year, month, day] = String(expiration).split('T')[0].split('-').map(Number);
  if (!year || !month || !day) return -1;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiryUtc = Date.UTC(year, month - 1, day);
  return Math.ceil((expiryUtc - todayUtc) / 86400000);
}

function constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
  const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
  const [year, month, day] = dateStr.split('-');
  const side = type === 'CALL' ? 'C' : 'P';
  return `${symbol.toUpperCase()}${year.slice(-2)}${month}${day}${side}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
}

function toQuotePayload(quote: any) {
  const bid = quote?.bid == null ? null : Number(quote.bid);
  const ask = quote?.ask == null ? null : Number(quote.ask);
  const mark = quote?.mark == null ? null : Number(quote.mark);
  return {
    ticker: quote?.ticker || null,
    bid,
    ask,
    last: quote?.last == null ? null : Number(quote.last),
    mark,
    spreadPct: quote?.spreadPct == null ? null : Number(quote.spreadPct),
    quoteAgeMs: quote?.quoteAgeMs ?? null,
    timestamp: quote?.timestamp || null
  };
}

function finitePrice(value: any): number | null {
  const raw = value && typeof value === 'object' && 'raw' in value ? value.raw : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchUnderlyingPrice(symbol: string): Promise<number | null> {
  try {
    const quote = await (yahooFinance as any).quote(symbol);
    return (
      finitePrice(quote?.regularMarketPrice) ??
      finitePrice(quote?.postMarketPrice) ??
      finitePrice(quote?.preMarketPrice)
    );
  } catch {
    try {
      const quote = await (yahooFinance as any).quoteSummary(symbol, { modules: ['price'] });
      return (
        finitePrice(quote?.price?.regularMarketPrice) ??
        finitePrice(quote?.price?.postMarketPrice) ??
        finitePrice(quote?.price?.preMarketPrice)
      );
    } catch {
      return null;
    }
  }
}

export async function manualEntryRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);
  const marketData = new IbkrMarketDataService(fastify);

  fastify.get('/settings', async (request) => {
    const { id: userId } = (request as any).user;
    const settings = await getSettingsWithGlobalFallback((fastify as any).pg, userId);
    return normalizeSettings(settings);
  });

  fastify.post('/settings', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const parsed = ManualEntrySettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid manual entry settings' });

    const values = {
      [SETTING_KEYS.defaultTicker]: String(parsed.data.defaultTicker || 'QQQ').trim().toUpperCase(),
      [SETTING_KEYS.contracts]: String(parsed.data.contracts || 1),
      [SETTING_KEYS.trimCount]: String(parsed.data.trimCount || 1),
      [SETTING_KEYS.slippagePct]: String(parsed.data.slippagePct ?? 3),
      [SETTING_KEYS.orderType]: parsed.data.orderType || 'LIMIT',
      [SETTING_KEYS.takeProfitPct]: parsed.data.takeProfitPct ? String(parsed.data.takeProfitPct) : '',
      [SETTING_KEYS.stopLossPct]: parsed.data.stopLossPct ? String(parsed.data.stopLossPct) : ''
    };

    try {
      const entries = Object.entries(values);
      const placeholders = entries.map((_, index) => {
        const offset = index * 2;
        return `($1, $${offset + 2}, $${offset + 3}, CURRENT_TIMESTAMP)`;
      }).join(', ');
      await (fastify as any).pg.query(
        `INSERT INTO settings (user_id, key, value, updated_at)
         VALUES ${placeholders}
         ON CONFLICT (user_id, key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [userId, ...entries.flatMap(([key, value]) => [key, value])]
      );
      return normalizeSettings(values as Record<string, string>);
    } catch (err) {
      throw err;
    }
  });

  fastify.get('/chain', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const parsed = ChainQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'symbol, optionType, and DTE are required' });

    const symbol = parsed.data.symbol.toUpperCase();
    const right = parsed.data.optionType === 'CALL' ? 'call' : 'put';
    const expirations = await marketData.getOptionExpirations(symbol);
    const expiration = expirations.find((candidate) => calculateDte(candidate) === parsed.data.dte);
    if (!expiration) return reply.code(404).send({ error: `No ${parsed.data.dte} DTE expiration found for ${symbol}` });

    const chain = await marketData.getOptionChainSnapshot(userId, symbol, expiration, right);
    const strikes = [...new Set(chain.map((quote) => Number(quote.strike)).filter((strike) => Number.isFinite(strike) && strike > 0))]
      .sort((a, b) => a - b);
    if (strikes.length === 0) return reply.code(404).send({ error: 'No strikes found for selected contract' });

    const underlyingPrice = await fetchUnderlyingPrice(symbol);
    const centerIndex = underlyingPrice
      ? strikes.reduce((bestIndex, strike, index) => (
          Math.abs(strike - underlyingPrice) < Math.abs(strikes[bestIndex] - underlyingPrice) ? index : bestIndex
        ), 0)
      : Math.floor(strikes.length / 2);
    const start = Math.max(0, centerIndex - 10);
    const end = Math.min(strikes.length, centerIndex + 11);
    const selectedStrikes = strikes.slice(start, end);
    const chainByStrike = new Map(chain.map((quote) => [Number(quote.strike), quote]));

    return {
      symbol,
      optionType: parsed.data.optionType,
      dte: parsed.data.dte,
      expiration,
      underlyingPrice,
      strikes: selectedStrikes.map((strike) => {
        const quote = chainByStrike.get(strike);
        return {
          strike,
          ticker: quote?.ticker || constructOSITicker(symbol, strike, parsed.data.optionType, expiration),
          bid: quote?.bid ?? null,
          ask: quote?.ask ?? null,
          mark: quote?.mark ?? null,
          spreadPct: quote?.spreadPct ?? null,
          volume: quote?.volume ?? null,
          openInterest: quote?.openInterest ?? null,
          delta: quote?.delta ?? null
        };
      })
    };
  });

  fastify.get('/quote', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const parsed = QuoteQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'symbol, optionType, strike, and expiration are required' });

    const quote = await marketData.getOptionQuote(userId, {
      symbol: parsed.data.symbol.toUpperCase(),
      expiration: parsed.data.expiration,
      right: parsed.data.optionType === 'CALL' ? 'call' : 'put',
      strike: parsed.data.strike
    });
    if (!quote) return reply.code(404).send({ error: 'No live quote found for selected contract' });
    return toQuotePayload(quote);
  });

  fastify.post('/orders', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const parsed = OrderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid manual entry order' });

    const input = parsed.data;
    const symbol = input.symbol.toUpperCase();
    const settings = await getSettingsWithGlobalFallback((fastify as any).pg, userId);
    const manualSettings = normalizeSettings(settings);

    if (settings.live_trading_acknowledged !== 'true') {
      return reply.code(400).send({ error: 'Live trading acknowledgement is required before placing manual entries.' });
    }
    const accountId = String(settings.snaptrade_trading_account_id || '').trim();
    if (!accountId) return reply.code(400).send({ error: 'No Wealthsimple/SnapTrade trading account selected in settings.' });
    if (input.orderType === 'LIMIT' && (!input.limitPrice || input.limitPrice <= 0)) {
      return reply.code(400).send({ error: 'A positive limit price is required for LIMIT orders.' });
    }

    const contractKey = TradeRedisService.contractKey({
      symbol,
      optionType: input.optionType,
      strike: input.strike,
      expiration: input.expiration
    });
    const entryLock = await TradeRedisService.acquireLock(TradeRedisService.keys.entryLock(userId, contractKey), 30);
    if (!entryLock.acquired) return reply.code(409).send({ error: 'An entry request is already in progress for this contract.' });

    try {
      const existing = await (fastify as any).pg.query(
        `SELECT id, status, execution_status
         FROM positions
         WHERE user_id = $1
           AND symbol = $2
           AND option_type = $3
           AND strike_price = $4
           AND expiration_date::date = $5::date
           AND status IN ('OPEN', 'PENDING_ORDER')
         LIMIT 1`,
        [userId, symbol, input.optionType, input.strike, input.expiration]
      );
      if (existing.rows[0]) {
        return reply.code(409).send({ error: `An active ${symbol} ${input.optionType} ${input.strike} ${input.expiration} trade already exists.` });
      }

      const firstQuote = await marketData.getOptionQuote(userId, {
        symbol,
        expiration: input.expiration,
        right: input.optionType === 'CALL' ? 'call' : 'put',
        strike: input.strike
      });
      assertUsableEntryQuote(firstQuote, input.orderType === 'LIMIT' && input.limitPrice ? Number(input.limitPrice) : Number(firstQuote?.mark || 0), input.orderType);

      await wait(750);
      const quote = await marketData.getOptionQuote(userId, {
        symbol,
        expiration: input.expiration,
        right: input.optionType === 'CALL' ? 'call' : 'put',
        strike: input.strike
      });
      assertUsableEntryQuote(quote, input.orderType === 'LIMIT' && input.limitPrice ? Number(input.limitPrice) : Number(quote?.mark || 0), input.orderType);

      const movePct = Number(firstQuote?.mark || 0) > 0
        ? Number((((Number(quote!.mark) - Number(firstQuote!.mark)) / Number(firstQuote!.mark)) * 100).toFixed(2))
        : 0;
      if (Math.abs(movePct) > 8) {
        return reply.code(400).send({ error: `Manual entry blocked: premium moved ${movePct}% during quote validation.` });
      }

      if (input.orderType === 'LIMIT' && Number(input.limitPrice) < Number(quote!.bid || 0)) {
        return reply.code(400).send({ error: 'Limit price is below the current bid.' });
      }
      const maxLimit = Number((Number(quote!.ask) * (1 + Math.max(manualSettings.slippagePct, 3) / 100)).toFixed(2));
      if (input.orderType === 'LIMIT' && Number(input.limitPrice) > maxLimit) {
        return reply.code(400).send({ error: `Limit price is above the protected maximum ${maxLimit.toFixed(2)}.` });
      }

      const osiTicker = constructOSITicker(symbol, input.strike, input.optionType, input.expiration);
      const entryState = TradeLifecycleService.entrySubmittedStatus(input.orderType);
      const entryPrice = Number(quote!.mark.toFixed(2));
      const takeProfitTrigger = manualSettings.takeProfitPct
        ? Number((entryPrice * (1 + manualSettings.takeProfitPct / 100)).toFixed(2))
        : null;
      const stopLossDisplay = manualSettings.stopLossPct
        ? Number((entryPrice * (1 - manualSettings.stopLossPct / 100)).toFixed(2))
        : null;
      const underlyingStopPrice = input.underlyingStopPrice
        ? Number(Number(input.underlyingStopPrice).toFixed(2))
        : null;
      const underlyingPrice = await fetchUnderlyingPrice(symbol);

      const insertResult = await (fastify as any).pg.query(
        `INSERT INTO positions (
          user_id, symbol, option_type, strike_price, expiration_date,
          entry_price, quantity, stop_loss_trigger, take_profit_trigger,
          trailing_high_price, trailing_stop_loss_pct, current_price, underlying_price, underlying_stop_price,
          status, is_simulated, account_id, notes, execution_broker,
          broker_order_id, broker_trade_id, execution_account_id, execution_status, contracts_requested,
          analysis_data, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, NULL, $8,
          $6, NULL, $6, $12, $13,
          'PENDING_ORDER', FALSE, $9, $10, 'wealthsimple_snaptrade',
          NULL, NULL, $9, 'ENTRY_SUBMITTING', $7,
          $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING *`,
        [
          userId,
          symbol,
          input.optionType,
          input.strike,
          input.expiration,
          entryPrice,
          input.quantity,
          takeProfitTrigger,
          accountId,
          `[Manual Entry] ${input.orderType} BUY_TO_OPEN preparing. Stop loss display ${stopLossDisplay === null ? 'not set' : `$${stopLossDisplay}`}. Underlying stop ${underlyingStopPrice === null ? 'not set' : `$${underlyingStopPrice}`}.`,
          {
            manualEntry: {
              enabled: true,
              orderType: input.orderType,
              limitPrice: input.limitPrice || null,
              takeProfitPct: manualSettings.takeProfitPct,
              stopLossPct: manualSettings.stopLossPct,
              initialTakeProfitTrigger: takeProfitTrigger,
              stopLossDisplay,
              underlyingStopPrice,
              quote: toQuotePayload(quote)
            }
          },
          underlyingPrice,
          underlyingStopPrice
        ]
      );
      const positionId = insertResult.rows[0]?.id;

      let order: any;
      try {
        const snaptrade = new SnaptradeService(fastify);
        order = await snaptrade.placeOptionOrder(
          userId,
          accountId,
          osiTicker,
          'BUY_TO_OPEN',
          input.quantity,
          input.orderType,
          input.orderType === 'LIMIT' ? Number(input.limitPrice).toFixed(2) : undefined,
          { skipImpact: true }
        );
      } catch (err: any) {
        await (fastify as any).pg.query(
          `UPDATE positions
           SET status = 'CLOSED',
               execution_status = 'ENTRY_FAILED',
               execution_error = $1,
               notes = COALESCE(notes, '') || $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [err.message || String(err), ` [Manual Entry broker submit failed: ${err.message || String(err)}]`, positionId]
        );
        await TradeRedisService.recordEvent((fastify as any).pg, {
          userId,
          positionId,
          eventType: 'MANUAL_ENTRY_ORDER_FAILED',
          message: err.message || String(err),
          metadata: { contract: osiTicker, quantity: input.quantity, orderType: input.orderType }
        });
        throw err;
      }

      const { rows } = await (fastify as any).pg.query(
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
          ` [Manual Entry SnapTrade order submitted${order.orderId ? `: ${order.orderId}` : ''}]`,
          positionId
        ]
      );

      await TradeRedisService.recordEvent((fastify as any).pg, {
        userId,
        positionId,
        eventType: 'MANUAL_ENTRY_ORDER_SUBMITTED',
        message: `Manual Wealthsimple ${input.orderType} entry submitted`,
        metadata: {
          orderId: order.orderId || null,
          tradeId: order.tradeId || null,
          contract: osiTicker,
          quantity: input.quantity,
          orderType: input.orderType,
          limitPrice: input.limitPrice || null,
          quote: toQuotePayload(quote)
        }
      });
      await TradeRedisService.rebuildOpenTrades((fastify as any).pg, userId, fastify);
      await TradeRedisService.requestBrokerSync(userId);
      (fastify as any).ibkrMarketDataStreamer?.syncSubscriptions?.().catch((err: any) => {
        fastify.log.warn(`[ManualEntry] Failed to refresh stream subscriptions after entry: ${err.message}`);
      });

      return {
        success: true,
        orderId: order.orderId || null,
        tradeId: order.tradeId || null,
        optionSymbol: osiTicker,
        position: rows[0]
      };
    } catch (err: any) {
      fastify.log.warn(`[ManualEntry] Order failed for user ${userId}: ${err.message}`);
      return reply.code(400).send({ error: err.message || 'Failed to submit manual entry order' });
    } finally {
      await TradeRedisService.releaseLock(entryLock);
    }
  });

  fastify.post('/positions/:id/trim', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const parsed = TrimSchema.safeParse(request.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid manual entry trim request' });

    const settings = await getSettingsWithGlobalFallback((fastify as any).pg, userId);
    const manualSettings = normalizeSettings(settings);
    const requestedQuantity = parsed.data.quantity || manualSettings.trimCount;
    const exitLock = await TradeRedisService.acquireLock(TradeRedisService.keys.exitLock(id));
    if (!exitLock.acquired) return reply.code(409).send({ error: 'A trim request is already in progress for this trade' });

    try {
      const client = await (fastify as any).pg.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT *
           FROM positions
           WHERE id = $1
             AND user_id = $2
             AND execution_broker = 'wealthsimple_snaptrade'
           FOR UPDATE`,
          [id, userId]
        );
        const position = rows[0];
        if (!position) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Manual entry trade not found' });
        }

        const analysisData = typeof position.analysis_data === 'string'
          ? (() => {
              try { return JSON.parse(position.analysis_data); } catch { return null; }
            })()
          : position.analysis_data;
        const isManualEntry = Boolean(analysisData?.manualEntry?.enabled) || String(position.notes || '').includes('[Manual Entry]');
        if (!isManualEntry) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Manual entry trade not found' });
        }

        try {
          TradeLifecycleService.assertCanRequestExit(position);
        } catch (err: any) {
          await client.query('ROLLBACK');
          return reply.code(TradeLifecycleService.isBrokerExitReviewStatus(position.execution_status) ? 409 : 400).send({ error: err.message });
        }

        const currentQty = Number(position.quantity || 0);
        const trimQty = Math.min(Number(requestedQuantity), currentQty);
        if (!Number.isFinite(trimQty) || trimQty <= 0 || !Number.isFinite(currentQty) || currentQty <= 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Invalid trim quantity' });
        }

        const accountId = String(position.execution_account_id || position.account_id || '').trim();
        if (!accountId) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'No Wealthsimple account id is attached to this trade' });
        }

        try {
          const osiTicker = constructOSITicker(position.symbol, Number(position.strike_price), position.option_type, position.expiration_date);
          const snaptrade = new SnaptradeService(fastify);
          const order = await snaptrade.placeOptionOrder(
            userId,
            accountId,
            osiTicker,
            'SELL_TO_CLOSE',
            trimQty,
            'MARKET',
            undefined,
            { skipImpact: true }
          );

          const fullClose = trimQty >= currentQty;
          const updatedPosition = await TradeLifecycleService.markExitSubmitted(
            client,
            id,
            order,
            {
              reason: fullClose ? 'MANUAL_TRIM_FULL' : 'MANUAL_TRIM',
              orderType: 'MARKET',
              trimQuantity: fullClose ? null : trimQty,
              note: ` [Manual Entry MARKET trim submitted for ${trimQty}/${currentQty} contract(s)${order.orderId ? `: ${order.orderId}` : ''}]`
            }
          );

          await TradeRedisService.recordEvent(client, {
            userId,
            positionId: id,
            eventType: fullClose ? 'MANUAL_ENTRY_TRIM_FULL_REQUESTED' : 'MANUAL_ENTRY_TRIM_REQUESTED',
            message: fullClose ? 'Manual Entry full trim submitted' : 'Manual Entry trim submitted',
            metadata: { orderId: order.orderId || null, tradeId: order.tradeId || null, quantity: trimQty, currentQty, orderType: 'MARKET' }
          });
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades((fastify as any).pg, userId, fastify);
          await TradeRedisService.requestBrokerSync(userId);
          return updatedPosition;
        } catch (err: any) {
          await TradeLifecycleService.markExitSubmissionFailure(client, id, err.message || String(err), 'Manual Entry trim failed');
          await TradeRedisService.recordEvent(client, {
            userId,
            positionId: id,
            eventType: 'MANUAL_ENTRY_TRIM_FAILED',
            message: err.message || String(err),
            metadata: { requestedQuantity }
          });
          await client.query('COMMIT');
          await TradeRedisService.rebuildOpenTrades((fastify as any).pg, userId, fastify);
          return reply.code(400).send({ error: err.message || 'Failed to submit manual entry trim order' });
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await TradeRedisService.releaseLock(exitLock);
    }
  });
}
