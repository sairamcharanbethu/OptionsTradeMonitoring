export type OptionSide = 'CALL' | 'PUT';

export type SignalGradeDiagnostics = {
  baseScore: number;
  macroScore: number;
  macroConfidenceAdjustment: number;
  pricingPenalty: number;
  finalConfidence: number;
  setupGrade: string;
  gradeKey: 'A+' | 'A' | 'B' | 'UNKNOWN';
  executable: boolean;
  thresholds: {
    standard: number;
    full: number;
    fullMacro: number;
  };
  reasons: string[];
  warnings: string[];
  blockers: string[];
  pricingWarnings: string[];
};

export type SignalDecision = {
  signalId?: number;
  symbol: string;
  side: OptionSide;
  createdAt: string;
  contract: {
    ticker: string | null;
    strike: number | null;
    expiry: string | null;
  };
  quote: {
    mark: number | null;
    bid: number | null;
    ask: number | null;
    spreadPct: number | null;
    volume: number | null;
    openInterest: number | null;
    usingTheoreticalPricing: boolean;
  };
  grade: SignalGradeDiagnostics;
};

export type TradingDataEvent =
  | { type: 'QUOTE_SELECTED'; createdAt: string; symbol: string; data: unknown };

export type TradingDomainEvent =
  | { type: 'SIGNAL_GENERATED'; createdAt: string; signalId: number; symbol: string; data: SignalDecision }
  | { type: 'EXECUTION_SKIPPED'; createdAt: string; signalId: number; userId: number; reason: string }
  | { type: 'EXECUTION_REQUESTED'; createdAt: string; signalId: number; userId: number; broker: string };

export type TradingCommand =
  | { type: 'EXECUTE_SIGNAL'; createdAt: string; signalId: number; userId: number };

export type TradingMessage = TradingDataEvent | TradingDomainEvent | TradingCommand;

type TradingMessageHandler<T extends TradingMessage = TradingMessage> = (message: T) => void | Promise<void>;

class InProcessTradingEventBus {
  private readonly handlers = new Map<string, TradingMessageHandler[]>();
  private readonly cache = new Map<string, unknown>();

  subscribe<T extends TradingMessage>(type: T['type'], handler: TradingMessageHandler<T>) {
    const existing = this.handlers.get(type) || [];
    existing.push(handler as TradingMessageHandler);
    this.handlers.set(type, existing);

    return () => {
      const current = this.handlers.get(type) || [];
      this.handlers.set(type, current.filter((item) => item !== handler));
    };
  }

  getCached<T = unknown>(key: string): T | null {
    return (this.cache.has(key) ? this.cache.get(key) : null) as T | null;
  }

  publish(message: TradingMessage, cacheWrites: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(cacheWrites)) {
      this.cache.set(key, value);
    }

    const handlers = this.handlers.get(message.type) || [];
    for (const handler of handlers) {
      Promise.resolve(handler(message)).catch(() => {
        // Handlers are intentionally isolated; callers should not fail because
        // a secondary observer could not process an event.
      });
    }
  }
}

export const tradingEventBus = new InProcessTradingEventBus();
