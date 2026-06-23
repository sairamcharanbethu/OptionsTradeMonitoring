export type RiskDecisionCode =
  | 'ALLOW'
  | 'EXISTING_SIGNAL_EXECUTION'
  | 'SETUP_GRADE_NOT_EXECUTABLE'
  | 'DUPLICATE_OPEN_ENTRY'
  | 'DAILY_TRADE_LIMIT'
  | 'EXECUTION_REALISM_TOO_LOW'
  | 'THEORETICAL_PRICING'
  | 'LIVE_TRADING_NOT_ACKNOWLEDGED'
  | 'ACCOUNT_NOT_SELECTED'
  | 'STALE_QUOTE'
  | 'MISSING_BID_ASK'
  | 'SPREAD_TOO_WIDE'
  | 'SELLABLE_BID_TOO_LOW'
  | 'PREMIUM_JUMP'
  | 'QUOTE_STABILITY_MOVE'
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
    maxPremiumJumpPct: number;
    maxStabilityMovePct: number;
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
    if (validation.baselineMark && validation.baselineMark > 0 && validation.movePct !== null && validation.movePct > thresholds.maxPremiumJumpPct) {
      return {
        allowed: false,
        skipped: true,
        code: 'PREMIUM_JUMP',
        message: `Entry skipped: premium jumped ${validation.movePct.toFixed(1)}% from signal mark $${validation.baselineMark.toFixed(2)} to $${quote.mark.toFixed(2)}`,
        metadata: { movePct: validation.movePct, maxPremiumJumpPct: thresholds.maxPremiumJumpPct }
      };
    }
    if (validation.stabilityMovePct !== null && Math.abs(validation.stabilityMovePct) > thresholds.maxStabilityMovePct) {
      return {
        allowed: false,
        skipped: true,
        code: 'QUOTE_STABILITY_MOVE',
        message: `Entry skipped: premium moved ${Math.abs(validation.stabilityMovePct).toFixed(1)}% during quote stability check`,
        metadata: { stabilityMovePct: validation.stabilityMovePct, maxStabilityMovePct: thresholds.maxStabilityMovePct }
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
