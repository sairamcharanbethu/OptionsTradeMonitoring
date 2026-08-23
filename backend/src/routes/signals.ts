import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { AIService } from '../services/ai-service';
import { KillSwitchService } from '../services/kill-switch-service';
import { redis } from '../lib/redis';
import { randomUUID } from 'crypto';

const UpdateStatusSchema = z.object({
  status: z.enum(['PENDING', 'PENDING_TRIGGER', 'EXECUTED', 'CANCELLED'])
});

const SignalIdSchema = z.object({
  id: z.coerce.number().int().positive()
});

const StrategyFamilyHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

export async function signalRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/strategy-history', {
    schema: {
      tags: ['Signals'],
      summary: 'Get strategy setup history',
      description: 'Return recent signal-only setups with user execution, position outcome, and compact lifecycle events.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    try {
      const { rows } = await fastify.pg.query(
        `SELECT
           s.id,
           s.strategy_setup_id AS setup_id,
           s.signal_type AS side,
           s.strategy_name,
           s.lifecycle_status,
           s.status AS signal_status,
           s.current_price::double precision AS spot,
           s.entry_trigger::double precision,
           s.stop_loss::double precision AS invalidation,
           s.target_price::double precision AS target,
           s.confidence_score,
           s.option_details,
           s.option_details->'decision_telemetry'->'entry_structure_context' AS entry_structure_context,
           s.option_details->'decision_telemetry'->'strategy_family_context' AS strategy_family_context,
           s.option_details->'decision_telemetry'->'trendline_context' AS trendline_context,
           s.no_trade_reasons,
           s.created_at,
           s.activated_at,
           sue.status AS user_execution_status,
           sue.execution_broker,
           sue.execution_status,
           sue.execution_error,
           sue.contracts_requested,
           latest_position.id AS position_id,
           latest_position.status AS position_status,
           latest_position.entry_price::double precision,
           latest_position.current_price::double precision AS position_current_price,
           latest_position.exit_price::double precision,
           latest_position.realized_pnl::double precision,
           latest_position.quantity,
           latest_position.expiration_date,
           latest_position.created_at AS position_created_at,
           latest_position.updated_at AS position_updated_at,
           COALESCE(events.lifecycle_events, '[]'::json) AS lifecycle_events
         FROM signals s
         LEFT JOIN signal_user_executions sue
           ON sue.signal_id = s.id AND sue.user_id = $1
         LEFT JOIN LATERAL (
           SELECT p.*
           FROM positions p
           WHERE p.user_id = $1
             AND (
               p.signal_id = s.id
               OR (s.strategy_setup_id IS NOT NULL AND p.strategy_setup_id = s.strategy_setup_id)
             )
           ORDER BY p.created_at DESC
           LIMIT 1
         ) latest_position ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(
             json_build_object(
               'id', event.id,
               'status', event.lifecycle_status,
               'state', event.signal_snapshot->>'state',
               'phase', event.signal_snapshot->>'signal_phase',
               'entryAllowed', COALESCE((event.signal_snapshot->'lifecycle'->>'entry_allowed')::boolean, false),
               'targetsHit', COALESCE((event.signal_snapshot->'lifecycle'->>'targets_hit')::integer, 0),
               'closeReason', event.signal_snapshot->'lifecycle'->>'close_reason',
               'blockers', COALESCE(event.signal_snapshot->'blockers', '[]'::jsonb),
               'entryStructure', COALESCE(event.signal_snapshot->'decision_telemetry'->'entry_structure_context', '{}'::jsonb),
               'strategyFamilyContext', COALESCE(event.signal_snapshot->'decision_telemetry'->'strategy_family_context', '{}'::jsonb),
               'trendlineContext', COALESCE(event.signal_snapshot->'decision_telemetry'->'trendline_context', '{}'::jsonb),
               'createdAt', event.created_at
             )
             ORDER BY event.created_at ASC, event.id ASC
           ) AS lifecycle_events
           FROM strategy_signal_events event
           WHERE event.setup_id = s.strategy_setup_id
         ) events ON TRUE
         WHERE s.engine_version = 'signal-only-v2'
           AND s.strategy_setup_id IS NOT NULL
         ORDER BY s.created_at DESC
         LIMIT 25`,
        [userId]
      );
      return rows;
    } catch (err: any) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch strategy setup history' });
    }
  });

  fastify.get('/strategy-family-history', {
    schema: {
      tags: ['Signals'],
      summary: 'Get shadow strategy family candidate history',
      description: 'Return deduplicated ORB_INDEX and VWAP_TREND candidates from the replay journal without creating authoritative signals.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const parsed = StrategyFamilyHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Strategy family history limit must be between 1 and 200' });
    }
    const strategyEngine = (fastify as any).strategyEngine;
    if (!strategyEngine?.getStrategyFamilyHistory) {
      return reply.code(503).send({ error: 'Strategy family history is unavailable' });
    }
    try {
      return await strategyEngine.getStrategyFamilyHistory(parsed.data.limit);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to read strategy family history' });
    }
  });

  fastify.get('/:id/risk-assessment', {
    schema: {
      tags: ['Signals'],
      summary: 'Explain setup risk in plain language',
      description: 'Generate an on-demand advisory AI risk assessment for a persisted strategy setup.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const parsed = SignalIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'A valid signal id is required' });

    const { id: userId } = (request as any).user;
    const settings = await getSettingsWithGlobalFallback(fastify.pg, userId);
    if (settings.day_trading_ai_enabled === 'false') {
      return reply.code(409).send({ error: 'AI risk management is disabled in Day Trading settings' });
    }

    const { rows } = await fastify.pg.query(
      `SELECT id, symbol, signal_type, current_price::double precision, entry_trigger::double precision,
              stop_loss::double precision, target_price::double precision, confidence_score, setup_grade,
              lifecycle_status, entry_allowed, no_trade_reasons, option_details, indicators, volatility, gex,
              strategy_snapshot
       FROM signals
       WHERE id = $1 AND engine_version = 'signal-only-v2'
       LIMIT 1`,
      [parsed.data.id]
    );
    const signal = rows[0];
    if (!signal) return reply.code(404).send({ error: 'Strategy setup not found' });

    const strategyEngine = (fastify as any).strategyEngine;
    if (!strategyEngine?.assertSignalReviewable) {
      return reply.code(503).send({ error: 'Live strategy validation is unavailable' });
    }
    const reviewFreshness = await strategyEngine.assertSignalReviewable(signal.id);

    const cacheKey = `AI_RISK_REVIEW:${userId}:${signal.id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        await redis.del(cacheKey);
      }
    }
    const lockKey = `${cacheKey}:LOCK`;
    const lockValue = randomUUID();
    const lockAcquired = await redis.setNX(lockKey, lockValue, 30);
    if (redis.isReady() && !lockAcquired) {
      return reply.code(429).send({ error: 'This setup is already being reviewed. Please wait a moment.' });
    }

    const option = signal.option_details || {};
    const plannedContracts = Math.max(0, Number(option.planned_contracts || 0));
    const plannedLimit = Math.max(0, Number(option.planned_limit_price || option.mark || 0));
    const plannedDebit = Math.max(0, Number(option.planned_total_debit || (plannedLimit * plannedContracts * 100)));
    const prompt = `You are an options day-trading risk explainer. Explain the supplied strategy setup in very simple language.
You are advisory only. Never replace, loosen, or invent the strategy trigger, invalidation, target, quantity, debit ceiling, or manual approval.
Do not promise an outcome. Describe a plausible path and the explicit failure condition.

SETUP:
${JSON.stringify({
  symbol: signal.symbol,
  side: signal.signal_type,
  lifecycle: signal.lifecycle_status,
  entryAllowed: signal.entry_allowed,
  spot: signal.current_price,
  trigger: signal.entry_trigger,
  invalidation: signal.stop_loss,
  target: signal.target_price,
  confidence: signal.confidence_score,
  grade: signal.setup_grade,
  blockers: signal.no_trade_reasons || [],
  option: {
    ticker: option.ticker,
    expiry: option.expiry,
    strike: option.strike,
    quoteFresh: reviewFreshness.optionQuoteFresh,
    quoteAgeSeconds: reviewFreshness.optionQuoteAgeSeconds,
    bid: reviewFreshness.optionQuoteFresh ? option.bid : null,
    ask: reviewFreshness.optionQuoteFresh ? option.ask : null,
    plannedLimit,
    plannedContracts,
    plannedDebit
  },
  technicals: signal.indicators || {},
  volatility: signal.volatility || {},
  strategyContext: {
    strategy: signal.strategy_snapshot?.strategy,
    state: signal.strategy_snapshot?.state,
    phase: signal.strategy_snapshot?.signal_phase,
    confirmations: signal.strategy_snapshot?.confirmations || signal.indicators?.confirmations || [],
    blockers: signal.strategy_snapshot?.blockers || signal.no_trade_reasons || [],
    lifecycle: signal.strategy_snapshot?.lifecycle || option.lifecycle || {},
    gex: signal.strategy_snapshot?.gex || signal.gex || {},
    zeroGexDecision: signal.strategy_snapshot?.zerogex_decision || {},
    strategyPolicy: signal.strategy_snapshot?.strategy_policy || {},
    paperPolicy: signal.strategy_snapshot?.paper_policy || {}
  }
})}

Respond ONLY with this JSON shape. Each sentence must be 22 words or fewer and use plain English:
{
  "verdict":"ALIGNED|MIXED|CONFLICTED|WAIT",
  "summary":"one sentence",
  "likely_path":"one sentence describing what price must do next",
  "if_right":"one sentence describing the planned favorable outcome",
  "if_wrong":"one sentence anchored to the supplied invalidation",
  "action":"one sentence stating the safest action now",
  "gex_read":"one sentence explaining how GEX supports or conflicts with the setup",
  "supporting_factors":["up to three short facts from supplied data"],
  "risk_flags":["up to three short risks from supplied data"]
}`;

    try {
      const raw = await new AIService(fastify).askTradingJSON(prompt, userId, 350);
      const allowedVerdicts = new Set(['ALIGNED', 'MIXED', 'CONFLICTED', 'WAIT']);
      const plain = (value: unknown, fallback: string) => {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return (text || fallback).slice(0, 220);
      };
      const assessment = {
        verdict: reviewFreshness.optionQuoteFresh
          ? (allowedVerdicts.has(String(raw.verdict).toUpperCase()) ? String(raw.verdict).toUpperCase() : 'MIXED')
          : 'WAIT',
        summary: reviewFreshness.optionQuoteFresh
          ? plain(raw.summary || raw.analysis, 'Treat this setup cautiously and follow the frozen strategy plan.')
          : 'The directional setup can be reviewed, but execution must wait for a fresh option quote.',
        likelyPath: plain(raw.likely_path, 'Wait for the strategy trigger and confirmation before considering entry.'),
        ifRight: plain(raw.if_right, 'The position should progress toward the strategy target while protection remains active.'),
        ifWrong: plain(raw.if_wrong, signal.stop_loss ? `The setup fails if SPY reaches ${signal.stop_loss}.` : 'Exit when the strategy invalidates the setup.'),
        action: reviewFreshness.optionQuoteFresh
          ? plain(raw.action, signal.entry_allowed ? 'Use only the planned size and protected limit.' : 'Stay flat until the strategy permits entry.')
          : 'Stay flat until IBKR supplies a fresh bid and ask for the selected option.',
        gexRead: plain(raw.gex_read, 'GEX does not provide a clear additional edge for this setup.'),
        supportingFactors: (Array.isArray(raw.supporting_factors) ? raw.supporting_factors : [])
          .slice(0, 3)
          .map((value: unknown) => plain(value, ''))
          .filter(Boolean),
        riskFlags: [
          ...(!reviewFreshness.optionQuoteFresh ? ['Selected option quote is stale or missing; execution is blocked.'] : []),
          ...(Array.isArray(raw.risk_flags) ? raw.risk_flags : [])
        ]
          .slice(0, 3)
          .map((value: unknown) => plain(value, ''))
          .filter(Boolean),
        maxPlannedLoss: plannedDebit > 0 ? Number(plannedDebit.toFixed(2)) : null,
        generatedAt: new Date().toISOString()
      };
      await redis.set(cacheKey, JSON.stringify(assessment), 10);
      return assessment;
    } catch (err: any) {
      fastify.log.warn(`[Signals] AI risk assessment failed for signal #${signal.id}: ${err.message || String(err)}`);
      return reply.code(502).send({ error: err.message || 'AI risk assessment failed' });
    } finally {
      if (lockAcquired) await redis.delIfValue(lockKey, lockValue);
    }
  });

  // GET /api/signals - Fetch latest 100 signals
  fastify.get('/', {
    schema: {
      tags: ['Signals'],
      summary: 'Get day trading signals',
      description: 'Retrieve latest trade signals from the database.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              symbol: { type: 'string' },
              signal_type: { type: 'string' },
              trade_bias: { type: 'string' },
              current_price: { type: 'number' },
              entry_trigger: { type: 'number', nullable: true },
              stop_loss: { type: 'number', nullable: true },
              target_price: { type: 'number', nullable: true },
              confidence_score: { type: 'integer' },
              setup_grade: { type: 'string', nullable: true },
              status: { type: 'string' },
              indicators: { type: 'object', nullable: true, additionalProperties: true },
              gex: { type: 'object', nullable: true, additionalProperties: true },
              volatility: { type: 'object', nullable: true, additionalProperties: true },
              no_trade_reasons: { type: 'array', items: { type: 'string' }, nullable: true },
              option_expiration_date: { type: 'string', format: 'date', nullable: true },
              market_date: { type: 'string', nullable: true },
              news_context: { type: 'string', nullable: true },
              ai_coach_commentary: { type: 'string', nullable: true },
              token_usage: { type: 'object', nullable: true, additionalProperties: true },
              ml_probability: { type: 'number', nullable: true },
              option_details: { type: 'object', nullable: true, additionalProperties: true },
              execution_broker: { type: 'string', nullable: true },
              broker_order_id: { type: 'string', nullable: true },
              broker_trade_id: { type: 'string', nullable: true },
              execution_status: { type: 'string', nullable: true },
              execution_error: { type: 'string', nullable: true },
              contracts_requested: { type: 'integer', nullable: true },
              execution: {
                type: 'object',
                nullable: true,
                properties: {
                  status: { type: 'string', nullable: true },
                  broker: { type: 'string', nullable: true },
                  order_id: { type: 'string', nullable: true },
                  trade_id: { type: 'string', nullable: true },
                  status_detail: { type: 'string', nullable: true },
                  error: { type: 'string', nullable: true },
                  contracts_requested: { type: 'integer', nullable: true }
                }
              },
              engine_version: { type: 'string', nullable: true },
              strategy_name: { type: 'string', nullable: true },
              strategy_setup_id: { type: 'string', nullable: true },
              lifecycle_status: { type: 'string', nullable: true },
              entry_allowed: { type: 'boolean' },
              activated_at: { type: 'string', format: 'date-time', nullable: true },
              policy_fingerprint: { type: 'string', nullable: true },
              strategy_snapshot: { type: 'object', nullable: true, additionalProperties: true },
              created_at: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id: userId } = (request as any).user;
      await fastify.pg.query(`
        UPDATE signals older
        SET status = 'CANCELLED'
        WHERE older.status IN ('PENDING', 'PENDING_TRIGGER')
          AND older.signal_type != 'NONE'
          AND EXISTS (
            SELECT 1
            FROM signals newer
            WHERE newer.symbol = older.symbol
              AND newer.signal_type != 'NONE'
              AND newer.status IN ('PENDING', 'PENDING_TRIGGER')
              AND newer.created_at > older.created_at
          )
      `);
      await fastify.pg.query(`
        UPDATE signal_user_executions sue
        SET status = 'CANCELLED',
            updated_at = CURRENT_TIMESTAMP
        FROM signals s
        WHERE sue.signal_id = s.id
          AND s.status = 'CANCELLED'
          AND sue.status = 'PENDING'
          AND sue.execution_broker IS NULL
          AND sue.broker_order_id IS NULL
          AND sue.execution_status IS NULL
      `);
      await fastify.pg.query(`
        UPDATE signal_user_executions sue
        SET status = CASE
              WHEN p.execution_status IN ('FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'PARTIAL_CANCELED', 'EXPIRED') THEN 'CANCELLED'
              ELSE 'EXECUTED'
            END,
            execution_status = p.execution_status,
            execution_error = p.execution_error,
            broker_trade_id = COALESCE(sue.broker_trade_id, p.broker_trade_id),
            updated_at = CURRENT_TIMESTAMP
        FROM positions p
        WHERE p.user_id = sue.user_id
          AND p.broker_order_id = sue.broker_order_id
          AND p.broker_order_id IS NOT NULL
          AND sue.execution_broker = 'wealthsimple_snaptrade'
          AND p.execution_broker = 'wealthsimple_snaptrade'
          AND COALESCE(sue.execution_status, '') <> COALESCE(p.execution_status, '')
      `);
      const query = `
        SELECT 
          s.id, 
          s.symbol, 
          s.signal_type, 
          s.trade_bias, 
          s.current_price::double precision, 
          s.entry_trigger::double precision, 
          s.stop_loss::double precision, 
          s.target_price::double precision, 
          s.confidence_score, 
          s.setup_grade, 
          s.status AS status,
          s.indicators, 
          s.gex, 
          s.volatility, 
          s.no_trade_reasons, 
          s.option_expiration_date, 
          s.market_date, 
          s.news_context,
          s.ai_coach_commentary,
          s.token_usage,
          s.ml_probability::double precision AS ml_probability,
          s.option_details,
          sue.status AS user_execution_status,
          sue.execution_broker,
          sue.broker_order_id,
          sue.broker_trade_id,
          sue.execution_status,
          sue.execution_error,
          sue.contracts_requested,
          s.engine_version,
          s.strategy_name,
          s.strategy_setup_id,
          s.lifecycle_status,
          s.entry_allowed,
          s.activated_at,
          s.policy_fingerprint,
          s.strategy_snapshot,
          s.created_at 
        FROM signals s
        LEFT JOIN signal_user_executions sue
          ON sue.signal_id = s.id AND sue.user_id = $1
        WHERE s.signal_type != 'NONE'
        ORDER BY s.created_at DESC 
        LIMIT 100
      `;
      const { rows } = await fastify.pg.query(query, [userId]);
      return rows.map((row: any) => {
        const execution = row.user_execution_status
          || row.execution_broker
          || row.broker_order_id
          || row.broker_trade_id
          || row.execution_status
          || row.execution_error
          ? {
              status: row.user_execution_status || null,
              broker: row.execution_broker || null,
              order_id: row.broker_order_id || null,
              trade_id: row.broker_trade_id || null,
              status_detail: row.execution_status || null,
              error: row.execution_error || null,
              contracts_requested: row.contracts_requested ?? null
            }
          : null;
        return { ...row, execution };
      });
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to fetch trade signals' });
    }
  });

  // GET /api/signals/logs - Fetch latest 100 scanner logs
  fastify.get('/logs', {
    schema: {
      tags: ['Signals'],
      summary: 'Get scanner logs',
      description: 'Retrieve latest day trading scanner runs and execution logs.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              symbol: { type: 'string' },
              spot_price: { type: 'number' },
              regime: { type: 'string' },
              vix: { type: 'number', nullable: true },
              gex_available: { type: 'boolean' },
              indicators: { type: 'object', nullable: true, additionalProperties: true },
              outcome: { type: 'string' },
              no_trade_reasons: { type: 'array', items: { type: 'string' }, nullable: true },
              created_at: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const query = `
        SELECT 
          id, 
          symbol, 
          spot_price::double precision, 
          regime, 
          vix::double precision, 
          gex_available, 
          indicators, 
          outcome, 
          no_trade_reasons, 
          created_at 
        FROM scanner_logs 
        ORDER BY created_at DESC 
        LIMIT 100
      `;
      const { rows } = await fastify.pg.query(query);
      return rows;
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to fetch scanner logs' });
    }
  });

  fastify.get('/macro', {
    schema: {
      tags: ['Signals'],
      summary: 'Get live macro metrics',
      description: 'Fetch the current macro snapshot used by the scanner scoring guards.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          properties: {
            generatedAt: { type: 'string', format: 'date-time' },
            vixQuote: { type: 'number', nullable: true },
            vixChangePercent: { type: 'number', nullable: true },
            vix3mQuote: { type: 'number', nullable: true },
            vixTermStructure: { type: 'object', nullable: true, additionalProperties: true },
            tenYearYield: { type: 'number', nullable: true },
            tenYearChangePercent: { type: 'number', nullable: true },
            tenYearChangeBps: { type: 'number', nullable: true },
            dxy: { type: 'object', nullable: true, additionalProperties: true },
            oil: { type: 'object', nullable: true, additionalProperties: true },
            gold: { type: 'object', nullable: true, additionalProperties: true },
            assessments: { type: 'object', nullable: true, additionalProperties: true }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const scanner = (fastify as any).scanner;
      if (!scanner?.getCurrentMacroSnapshot) {
        return (reply as any).code(503).send({ error: 'Scanner service not initialized' });
      }
      return scanner.getCurrentMacroSnapshot();
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: err.message || 'Failed to fetch live macro metrics' });
    }
  });

  fastify.get('/strategy-state', {
    schema: {
      tags: ['Signals'],
      summary: 'Get current signal-only-v2 strategy state',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          additionalProperties: true
        }
      }
    }
  }, async (request, reply) => {
    const strategyEngine = (fastify as any).strategyEngine;
    if (!strategyEngine) {
      return (reply as any).code(503).send({ error: 'Strategy engine adapter not initialized' });
    }
    const state = strategyEngine.getCurrentState();
    // Overlay a live kill-switch evaluation so the UI never shows a stale
    // "not blocked" while entries are actually halted.
    try {
      const { id: userId } = (request as any).user || {};
      if (userId != null) {
        const live = await KillSwitchService.evaluate((fastify as any).pg, 'live', userId);
        state.entryBlocked = live.halted;
        state.entryBlockedReason = live.reason || null;
        if (typeof strategyEngine.noteEntryBlockState === 'function') {
          strategyEngine.noteEntryBlockState(live.halted, live.reason || null);
        }
      }
    } catch (err: any) {
      fastify.log.warn(`[Signals] Kill-switch overlay failed: ${err?.message || err}`);
    }
    return state;
  });

  // PUT /api/signals/:id/status - Update signal status
  fastify.put('/:id/status', {
    schema: {
      tags: ['Signals'],
      summary: 'Update signal status',
      description: 'Set signal status to EXECUTED, CANCELLED, PENDING_TRIGGER, or PENDING.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' }
        }
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['PENDING', 'PENDING_TRIGGER', 'EXECUTED', 'CANCELLED'] }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            status: { type: 'string' },
            execution_status: { type: 'string', nullable: true },
            execution_broker: { type: 'string', nullable: true },
            broker_order_id: { type: 'string', nullable: true },
            broker_trade_id: { type: 'string', nullable: true },
            quantity: { type: 'integer', nullable: true }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: number };
      const { status } = UpdateStatusSchema.parse(request.body);
      const { id: userId } = (request as any).user;

      if (status === 'EXECUTED') {
        const strategyEngine = (fastify as any).strategyEngine;
        if (strategyEngine?.assertSignalExecutable) {
          await strategyEngine.assertSignalExecutable(id);
        }
        const scanner = (fastify as any).scanner;
        if (!scanner) {
          return (reply as any).code(500).send({ error: 'Scanner service not initialized' });
        }

        const executionResult = await scanner.executeSignalForUser(userId, id);
        if (executionResult && executionResult.success === false) {
          return (reply as any).code(400).send({ error: executionResult.message || 'Signal execution was not placed' });
        }

        return {
          id,
          status: 'EXECUTED',
          execution_status: executionResult?.executionStatus || null,
          execution_broker: executionResult?.broker || null,
          broker_order_id: executionResult?.orderId || null,
          broker_trade_id: executionResult?.tradeId || null,
          quantity: executionResult?.quantity || null
        };
      } else {
        const { rows: signalRows } = await fastify.pg.query('SELECT id FROM signals WHERE id = $1', [id]);

        if (signalRows.length === 0) {
          return (reply as any).code(404).send({ error: 'Signal not found' });
        }

        const { rows } = await fastify.pg.query(
          `INSERT INTO signal_user_executions (signal_id, user_id, status, updated_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (signal_id, user_id) DO UPDATE
           SET status = EXCLUDED.status,
               updated_at = CURRENT_TIMESTAMP
           RETURNING signal_id AS id, status`,
          [id, userId, status]
        );

        return rows[0];
      }
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(err.statusCode || 500).send({ error: err.message || 'Failed to update signal status' });
    }
  });

  // DELETE /api/signals - Clear all signals and logs
  fastify.delete('/', {
    schema: {
      tags: ['Signals'],
      summary: 'Clear all signals and logs',
      description: 'Wipe all records from the signals and scanner_logs tables.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { role } = (request as any).user;
      if (role !== 'ADMIN') {
        return (reply as any).code(403).send({ error: 'Admin access required' });
      }

      await fastify.pg.query('DELETE FROM signal_user_executions');
      await fastify.pg.query('DELETE FROM signals');
      await fastify.pg.query('DELETE FROM scanner_logs');
      return { success: true, message: 'All day trading signals and logs cleared successfully.' };
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to clear signals' });
    }
  });

  // POST /api/signals/seed - Seed database with mock signals
  fastify.post('/seed', {
    schema: {
      tags: ['Signals'],
      summary: 'Seed sample trade signals',
      description: 'Inserts dummy setups into the signals table for testing.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            insertedCount: { type: 'integer' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { role } = (request as any).user;
      if (role !== 'ADMIN') {
        return (reply as any).code(403).send({ error: 'Admin access required' });
      }

      await client.query('BEGIN');

      const today = new Date().toISOString().split('T')[0];
      const marketDateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });

      // Signal 1: QQQ Breakout CALL
      const sig1 = [
        'QQQ', 'CALL', 'BUY_CALL_ON_BREAKOUT', 482.50, 483.00, 481.20, 486.00, 88, 'A+ / FULL', 'PENDING',
        JSON.stringify({ vwap: 481.80, ema9: 482.10, ema21: 481.50, atr14: 1.25, openingRangeHigh: 482.80, openingRangeLow: 480.90, megaCaps: { AAPL: 1.25, MSFT: 0.45, NVDA: 2.10 } }),
        JSON.stringify({ netGex: 450000, regime: 'BULLISH', flipStrike: 480.00, callWall: 485.00, putWall: 475.00, flowDirection: 'BUYING_PRESSURE' }),
        JSON.stringify({ vixQuote: 13.42, vixChangePercent: -2.5 }),
        [], today, marketDateStr,
        JSON.stringify({
          ticker: 'QQQ260610C483.00',
          side: 'CALL',
          strike: 483.00,
          expiry: today,
          bid: 1.45,
          ask: 1.55,
          spread: 0.10,
          spreadPct: 6.67,
          mark: 1.50,
          volume: 12500,
          openInterest: 8500,
          suggestedStopLoss: 1.20,
          suggestedTakeProfit: 2.10,
          usingTheoreticalPricing: false
        })
      ];

      // Signal 2: SPY Rebound PUT
      const sig2 = [
        'SPY', 'PUT', 'BUY_PUT_ON_RIP', 528.10, 527.80, 529.50, 524.00, 75, 'B / LOTTO', 'PENDING',
        JSON.stringify({ vwap: 528.90, ema9: 528.20, ema21: 528.50, atr14: 1.95, openingRangeHigh: 530.10, openingRangeLow: 527.50, megaCaps: { AAPL: -0.65, MSFT: -1.20, NVDA: 0.15 } }),
        JSON.stringify({ netGex: -120000, regime: 'BEARISH', flipStrike: 530.00, callWall: 535.00, putWall: 525.00, flowDirection: 'SELLING_PRESSURE' }),
        JSON.stringify({ vixQuote: 13.42, vixChangePercent: -2.5 }),
        [], today, marketDateStr,
        JSON.stringify({
          ticker: 'SPY260610P528.00',
          side: 'PUT',
          strike: 528.00,
          expiry: today,
          bid: 1.90,
          ask: 2.00,
          spread: 0.10,
          spreadPct: 5.13,
          mark: 1.95,
          volume: 8200,
          openInterest: 5300,
          suggestedStopLoss: 1.56,
          suggestedTakeProfit: 2.73,
          usingTheoreticalPricing: false
        })
      ];

      // Signal 3: Blocked Setup
      const sig3 = [
        'QQQ', 'NONE', 'NO_TRADE', 482.50, null, null, null, 40, 'C / LOTTO', 'CANCELLED',
        JSON.stringify({ vwap: 482.30, ema9: 482.40, ema21: 482.50, atr14: 1.25, megaCaps: { AAPL: 0.10, MSFT: -0.20, NVDA: 0.35 } }),
        JSON.stringify({ netGex: 25000, regime: 'CONSOLIDATING', flipStrike: 480.00 }),
        JSON.stringify({ vixQuote: 13.42, vixChangePercent: -2.5 }),
        ['RSI overbought (>70) on 5m chart', 'Inside Opening Range 15m bracket', 'GEX Flip Strike too close'],
        today, marketDateStr,
        JSON.stringify({
          ticker: 'QQQ260610C483.00',
          side: 'CALL',
          strike: 483.00,
          expiry: today,
          bid: 0.45,
          ask: 0.55,
          spread: 0.10,
          spreadPct: 20.00,
          mark: 0.50,
          volume: 150,
          openInterest: 300,
          suggestedStopLoss: 0.40,
          suggestedTakeProfit: 0.70,
          usingTheoreticalPricing: true
        })
      ];

      const query = `
        INSERT INTO signals (
          symbol, signal_type, trade_bias, current_price, entry_trigger, stop_loss, target_price, confidence_score, setup_grade, status,
          indicators, gex, volatility, no_trade_reasons, option_expiration_date, market_date, option_details
        ) VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17),
        ($18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34),
        ($35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51)
      `;

      await client.query(query, [...sig1, ...sig2, ...sig3]);
      await client.query('COMMIT');

      return { success: true, insertedCount: 3 };
    } catch (err: any) {
      await client.query('ROLLBACK');
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to seed sample signals' });
    } finally {
      client.release();
    }
  });

  // GET /api/signals/health - Check health of all external APIs
  fastify.get('/health', {
    schema: {
      tags: ['Signals'],
      summary: 'Get day trading API health metrics',
      description: 'Check connectivity status and response times of third-party options and market data APIs.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    try {
      const { id: userId } = (request as any).user;
      const scanner = (fastify as any).scanner;
      if (!scanner) {
        return (reply as any).code(500).send({ error: 'Scanner service not initialized' });
      }
      const health = await scanner.runHealthCheck(userId);
      return health;
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to evaluate API health' });
    }
  });

  // POST /api/signals/trigger - retired along with the legacy in-process scanner.
  // signal-only-v2 (the Python strategy engine) is the sole signal source.
  fastify.post('/trigger', {
    schema: {
      tags: ['Signals'],
      summary: 'Manually trigger a scan cycle (retired)',
      description: 'The legacy scanner has been removed; signal-only-v2 is the sole signal source.',
      security: [{ bearerAuth: [] }]
    }
  }, async (_request, reply) => {
    return (reply as any).code(409).send({
      error: 'The legacy scanner has been retired; signal-only-v2 is the sole signal source.'
    });
  });
}
