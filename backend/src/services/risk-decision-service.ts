export type RiskDecisionCode =
  | 'ALLOW'
  | 'EXISTING_SIGNAL_EXECUTION'
  | 'SETUP_GRADE_NOT_EXECUTABLE'
  | 'DUPLICATE_OPEN_ENTRY'
  | 'DAILY_TRADE_LIMIT'
  | 'DAILY_LOSS_LIMIT'
  | 'CONSECUTIVE_LOSS_COOLDOWN'
  | 'PREMIUM_RISK_LIMIT'
  | 'CORRELATED_EXPOSURE_LIMIT'
  | 'EXECUTION_REALISM_TOO_LOW'
  | 'THEORETICAL_PRICING'
  | 'LIVE_TRADING_NOT_ACKNOWLEDGED'
  | 'ACCOUNT_NOT_SELECTED'
  | 'STALE_QUOTE'
  | 'MISSING_BID_ASK'
  | 'SPREAD_TOO_WIDE'
  | 'SELLABLE_BID_TOO_LOW'
  | 'MACRO_CONTRADICTION';

export type RiskDecision = {
  allowed: boolean;
  skipped: boolean;
  code: RiskDecisionCode;
  message: string;
  metadata?: Record<string, any>;
};

export type PreSubmitRiskInput = {
  signalId: number;
  broker?: string;
  side?: 'CALL' | 'PUT';
  contractLabel?: string;
  settings?: {
    live_trading_acknowledged?: string;
    snaptrade_trading_account_id?: string;
  };
  existingExecution?: any;
  setupGrade?: string | null;
  duplicateOpenEntry?: any;
  currentTradeCount?: number;
  maxTradesPerDay?: number;
  dailyRealizedPnl?: number;
  maxDailyLoss?: number;
  consecutiveLosses?: number;
  maxConsecutiveLosses?: number;
  cooldownUntil?: string | null;
  premiumRisk?: number;
  maxPremiumRisk?: number;
  correlatedOpenPositions?: number;
  maxCorrelatedPositions?: number;
  optionDetails?: any;
  quoteValidation?: {
    quote: any;
    baselineMark: number | null;
    movePct: number | null;
    stabilityMovePct: number | null;
  };
  quoteThresholds?: {
    maxQuoteAgeMs: number;
    maxSpreadPct: number;
    minBidToEntryRatio: number;
  };
  intendedEntry?: number | null;
};

export type PreSubmitRiskAssessment = {
  approved: boolean;
  denials: RiskDecision[];
  warnings: RiskDecision[];
  evidence: Record<string, any>;
};

export class RiskDecisionService {
  static allow(): RiskDecision {
    return { allowed: true, skipped: false, code: 'ALLOW', message: 'Allowed' };
  }

  static evaluatePreSubmit(input: PreSubmitRiskInput): PreSubmitRiskAssessment {
    const decisions = [
      input.existingExecution !== undefined ? this.forExistingSignalExecution(input.signalId, input.existingExecution) : this.allow(),
      input.setupGrade !== undefined ? this.forSetupGrade(input.signalId, input.setupGrade) : this.allow(),
      input.duplicateOpenEntry !== undefined ? this.forDuplicateOpenEntry(input.contractLabel || 'contract', input.duplicateOpenEntry) : this.allow(),
      input.currentTradeCount !== undefined && input.maxTradesPerDay !== undefined
        ? this.forDailyTradeLimit(input.currentTradeCount, input.maxTradesPerDay)
        : this.allow(),
      input.dailyRealizedPnl !== undefined && input.maxDailyLoss !== undefined
        ? this.forDailyLossLimit(input.dailyRealizedPnl, input.maxDailyLoss)
        : this.allow(),
      input.consecutiveLosses !== undefined && input.maxConsecutiveLosses !== undefined
        ? this.forConsecutiveLosses(input.consecutiveLosses, input.maxConsecutiveLosses, input.cooldownUntil)
        : this.allow(),
      input.premiumRisk !== undefined && input.maxPremiumRisk !== undefined
        ? this.forPremiumRisk(input.premiumRisk, input.maxPremiumRisk)
        : this.allow(),
      input.correlatedOpenPositions !== undefined && input.maxCorrelatedPositions !== undefined
        ? this.forCorrelatedExposure(input.correlatedOpenPositions, input.maxCorrelatedPositions, input.contractLabel || 'underlying')
        : this.allow(),
      input.broker === 'wealthsimple_snaptrade' && input.settings !== undefined ? this.forLiveTradingAcknowledgement(input.settings) : this.allow(),
      input.broker === 'wealthsimple_snaptrade' && input.settings !== undefined ? this.forTradingAccount(input.settings) : this.allow(),
      input.optionDetails !== undefined ? this.forTheoreticalPricing(input.optionDetails) : this.allow(),
      input.optionDetails !== undefined ? this.forExecutionRealism(input.optionDetails) : this.allow(),
      input.optionDetails !== undefined && input.side ? this.forMacroContradiction(input.optionDetails, input.side) : this.allow(),
      input.quoteValidation && input.quoteThresholds
        ? this.forEntryQuote(input.quoteValidation, input.quoteThresholds, input.intendedEntry)
        : this.allow()
    ];
    const denials = decisions.filter((decision) => !decision.allowed);
    return {
      approved: denials.length === 0,
      denials,
      warnings: [],
      evidence: {
        signalId: input.signalId,
        broker: input.broker || null,
        side: input.side || null,
        contractLabel: input.contractLabel || null,
        setupGrade: input.setupGrade ?? null,
        currentTradeCount: input.currentTradeCount ?? null,
        maxTradesPerDay: input.maxTradesPerDay ?? null,
        dailyRealizedPnl: input.dailyRealizedPnl ?? null,
        maxDailyLoss: input.maxDailyLoss ?? null,
        consecutiveLosses: input.consecutiveLosses ?? null,
        maxConsecutiveLosses: input.maxConsecutiveLosses ?? null,
        cooldownUntil: input.cooldownUntil ?? null,
        premiumRisk: input.premiumRisk ?? null,
        maxPremiumRisk: input.maxPremiumRisk ?? null,
        correlatedOpenPositions: input.correlatedOpenPositions ?? null,
        maxCorrelatedPositions: input.maxCorrelatedPositions ?? null,
        quote: input.quoteValidation?.quote ? {
          source: input.quoteValidation.quote.source || null,
          ticker: input.quoteValidation.quote.ticker || null,
          bid: input.quoteValidation.quote.bid ?? null,
          ask: input.quoteValidation.quote.ask ?? null,
          mark: input.quoteValidation.quote.mark ?? null,
          spreadPct: input.quoteValidation.quote.spreadPct ?? null,
          quoteAgeMs: input.quoteValidation.quote.quoteAgeMs ?? null,
          syntheticOnly: Boolean(input.quoteValidation.quote.syntheticOnly)
        } : null,
        baselineMark: input.quoteValidation?.baselineMark ?? null,
        movePct: input.quoteValidation?.movePct ?? null,
        stabilityMovePct: input.quoteValidation?.stabilityMovePct ?? null
      }
    };
  }

  static forExistingSignalExecution(signalId: number, existingExecution: any): RiskDecision {
    if (existingExecution && (existingExecution.broker_order_id || existingExecution.execution_status === 'PENDING' || existingExecution.execution_status === 'EXECUTED')) {
      return {
        allowed: false,
        skipped: true,
        code: 'EXISTING_SIGNAL_EXECUTION',
        message: `Signal #${signalId} already has execution status ${existingExecution.execution_status || existingExecution.status}`
      };
    }
    return this.allow();
  }

  static forSetupGrade(signalId: number, setupGrade: string | null | undefined): RiskDecision {
    if (this.isExecutableSetupGrade(setupGrade)) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'SETUP_GRADE_NOT_EXECUTABLE',
      message: `Signal #${signalId} skipped: setup grade ${setupGrade || 'N/A'} is below A/A+`
    };
  }

  static forDuplicateOpenEntry(contractLabel: string, duplicate: any): RiskDecision {
    if (!duplicate) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'DUPLICATE_OPEN_ENTRY',
      message: `Skipped duplicate entry: ${contractLabel} already exists as position #${duplicate.id} (${duplicate.status}${duplicate.execution_status ? `/${duplicate.execution_status}` : ''})`,
      metadata: { duplicatePositionId: duplicate.id }
    };
  }

  static forDailyTradeLimit(currentTradeCount: number, maxTradesPerDay: number): RiskDecision {
    if (currentTradeCount < maxTradesPerDay) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'DAILY_TRADE_LIMIT',
      message: `Daily trade limit reached (${currentTradeCount}/${maxTradesPerDay})`
    };
  }

  static forDailyLossLimit(dailyRealizedPnl: number, maxDailyLoss: number): RiskDecision {
    if (dailyRealizedPnl > -Math.abs(maxDailyLoss)) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'DAILY_LOSS_LIMIT',
      message: `Daily loss limit reached ($${Math.abs(dailyRealizedPnl).toFixed(2)} / $${Math.abs(maxDailyLoss).toFixed(2)})`
    };
  }

  static forConsecutiveLosses(consecutiveLosses: number, maxConsecutiveLosses: number, cooldownUntil?: string | null): RiskDecision {
    if (consecutiveLosses < maxConsecutiveLosses) return this.allow();
    if (cooldownUntil && Number.isFinite(Date.parse(cooldownUntil)) && Date.parse(cooldownUntil) <= Date.now()) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'CONSECUTIVE_LOSS_COOLDOWN',
      message: `Entry blocked during consecutive-loss cooldown (${consecutiveLosses}/${maxConsecutiveLosses})`,
      metadata: { cooldownUntil: cooldownUntil || null }
    };
  }

  static forPremiumRisk(premiumRisk: number, maxPremiumRisk: number): RiskDecision {
    if (premiumRisk <= Math.abs(maxPremiumRisk)) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'PREMIUM_RISK_LIMIT',
      message: `Premium risk $${premiumRisk.toFixed(2)} exceeds per-trade limit $${Math.abs(maxPremiumRisk).toFixed(2)}`,
      metadata: { premiumRisk, maxPremiumRisk: Math.abs(maxPremiumRisk) }
    };
  }

  static forCorrelatedExposure(current: number, max: number, contractLabel: string): RiskDecision {
    if (current < max) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'CORRELATED_EXPOSURE_LIMIT',
      message: `Correlated exposure limit reached for ${contractLabel} (${current}/${max})`
    };
  }

  static forLiveTradingAcknowledgement(settings: PreSubmitRiskInput['settings']): RiskDecision {
    if (settings?.live_trading_acknowledged === 'true') return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'LIVE_TRADING_NOT_ACKNOWLEDGED',
      message: 'Wealthsimple live trading acknowledgement is required'
    };
  }

  static forTradingAccount(settings: PreSubmitRiskInput['settings']): RiskDecision {
    if (String(settings?.snaptrade_trading_account_id || '').trim()) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'ACCOUNT_NOT_SELECTED',
      message: 'No Wealthsimple/SnapTrade trading account selected'
    };
  }

  static forTheoreticalPricing(optionDetails: any): RiskDecision {
    if (!this.hasTheoreticalPricing(optionDetails)) return this.allow();
    return {
      allowed: false,
      skipped: true,
      code: 'THEORETICAL_PRICING',
      message: 'Entry skipped: signal used theoretical option pricing fallback'
    };
  }

  static forExecutionRealism(optionDetails: any): RiskDecision {
    const realism = optionDetails?.decision?.grade?.executionRealism || optionDetails?.gradeDiagnostics?.executionRealism;
    if (!realism || typeof realism !== 'object') return this.allow();
    if (realism.executable !== false) return this.allow();
    const score = Number(realism.score);
    const threshold = Number(realism.threshold);
    return {
      allowed: false,
      skipped: true,
      code: 'EXECUTION_REALISM_TOO_LOW',
      message: `Entry skipped: execution realism score ${Number.isFinite(score) ? score : 'N/A'} is below ${Number.isFinite(threshold) ? threshold : 'required'} for live trading`,
      metadata: {
        score: Number.isFinite(score) ? score : null,
        threshold: Number.isFinite(threshold) ? threshold : null,
        reasons: Array.isArray(realism.reasons) ? realism.reasons.slice(0, 5) : []
      }
    };
  }

  static forEntryQuote(
    validation: NonNullable<PreSubmitRiskInput['quoteValidation']>,
    thresholds: NonNullable<PreSubmitRiskInput['quoteThresholds']>,
    intendedEntry?: number | null
  ): RiskDecision {
    const quote = validation.quote;
    if (!quote || Number(quote.mark || 0) <= 0) {
      return {
        allowed: false,
        skipped: true,
        code: 'MISSING_BID_ASK',
        message: 'Entry skipped: no usable live option quote was available'
      };
    }
    if (quote.syntheticOnly) {
      return {
        allowed: false,
        skipped: true,
        code: 'MISSING_BID_ASK',
        message: 'Entry skipped: option quote is missing a usable bid/ask spread'
      };
    }
    if (quote.quoteAgeMs !== null && quote.quoteAgeMs > thresholds.maxQuoteAgeMs) {
      return {
        allowed: false,
        skipped: true,
        code: 'STALE_QUOTE',
        message: `Entry skipped: option quote is stale (${Math.round(quote.quoteAgeMs / 1000)}s old)`,
        metadata: { quoteAgeMs: quote.quoteAgeMs, maxQuoteAgeMs: thresholds.maxQuoteAgeMs }
      };
    }
    if (!quote.bid || !quote.ask || quote.bid <= 0 || quote.ask <= 0 || quote.spreadPct === null) {
      return {
        allowed: false,
        skipped: true,
        code: 'MISSING_BID_ASK',
        message: 'Entry skipped: option quote is missing a usable bid/ask spread'
      };
    }
    if (quote.spreadPct > thresholds.maxSpreadPct) {
      return {
        allowed: false,
        skipped: true,
        code: 'SPREAD_TOO_WIDE',
        message: `Entry skipped: option spread ${quote.spreadPct}% is wider than ${thresholds.maxSpreadPct}%`,
        metadata: { spreadPct: quote.spreadPct, maxSpreadPct: thresholds.maxSpreadPct }
      };
    }
    if (intendedEntry && intendedEntry > 0 && quote.bid < intendedEntry * thresholds.minBidToEntryRatio) {
      const underwaterPct = Number(((1 - quote.bid / intendedEntry) * 100).toFixed(1));
      return {
        allowed: false,
        skipped: true,
        code: 'SELLABLE_BID_TOO_LOW',
        message: `Entry skipped: immediate sellable bid $${quote.bid.toFixed(2)} is ${underwaterPct}% below intended entry $${intendedEntry.toFixed(2)}`,
        metadata: { bid: quote.bid, intendedEntry, underwaterPct }
      };
    }
    return this.allow();
  }

  static forMacroContradiction(optionDetails: any, side: 'CALL' | 'PUT'): RiskDecision {
    const riskFlags = optionDetails?.risk_flags || optionDetails?.riskFlags;
    const directionBias = optionDetails?.decisionSnapshot?.macroSnapshot?.macroRegime?.directionBias
      || optionDetails?.macroSnapshot?.macroRegime?.directionBias
      || optionDetails?.decision?.macroRegime?.directionBias;
    const macroOpposesSide = (side === 'CALL' && directionBias === 'PUT') || (side === 'PUT' && directionBias === 'CALL');
    if (riskFlags?.macroSupportsSignal === false || macroOpposesSide) {
      return {
        allowed: false,
        skipped: true,
        code: 'MACRO_CONTRADICTION',
        message: `Entry skipped: macro context contradicts ${side} signal`,
        metadata: { directionBias: directionBias || null, macroSupportsSignal: riskFlags?.macroSupportsSignal ?? null }
      };
    }
    return this.allow();
  }

  static hasTheoreticalPricing(optionDetails: any): boolean {
    if (!optionDetails || typeof optionDetails !== 'object') return false;
    if (optionDetails.usingTheoreticalPricing || optionDetails.using_theoretical_pricing) return true;
    if (optionDetails.decision?.quote?.usingTheoreticalPricing) return true;

    const warnings = [
      ...(Array.isArray(optionDetails.pricingWarnings) ? optionDetails.pricingWarnings : []),
      ...(Array.isArray(optionDetails.gradeDiagnostics?.pricingWarnings) ? optionDetails.gradeDiagnostics.pricingWarnings : []),
      ...(Array.isArray(optionDetails.decision?.grade?.pricingWarnings) ? optionDetails.decision.grade.pricingWarnings : [])
    ];
    return warnings.some((warning) => String(warning || '').toLowerCase().includes('theoretical'));
  }

  static isExecutableSetupGrade(setupGrade: string | null | undefined): boolean {
    const normalized = String(setupGrade || '').toUpperCase();
    if (normalized.includes('A+')) return true;
    return /(^|[^A-Z])A([^A-Z+]|$)/.test(normalized);
  }
}
