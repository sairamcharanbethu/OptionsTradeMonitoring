export type RiskDecisionCode =
  | 'ALLOW'
  | 'EXISTING_SIGNAL_EXECUTION'
  | 'SETUP_GRADE_NOT_EXECUTABLE'
  | 'DUPLICATE_OPEN_ENTRY'
  | 'DAILY_TRADE_LIMIT'
  | 'EXECUTION_REALISM_TOO_LOW'
  | 'THEORETICAL_PRICING';

export type RiskDecision = {
  allowed: boolean;
  skipped: boolean;
  code: RiskDecisionCode;
  message: string;
  metadata?: Record<string, any>;
};

export class RiskDecisionService {
  static allow(): RiskDecision {
    return { allowed: true, skipped: false, code: 'ALLOW', message: 'Allowed' };
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
