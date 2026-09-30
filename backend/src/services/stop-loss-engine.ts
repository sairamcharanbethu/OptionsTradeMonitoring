export interface PositionEvaluationResult {
  triggered: boolean;
  triggerType?: 'STOP_LOSS' | 'TAKE_PROFIT';
  newStopLoss?: number;
  newHigh?: number;
  lossAvoided?: number;
}

export function roundProtectiveStop(value: number): number {
  return Math.ceil(Number(value) * 100 - 1e-9) / 100;
}

export class StopLossEngine {
  /**
   * Profit-lock ladder for swing positions (premium-based).
   *
   * Once the premium peak prints a rung, the trailing floor ratchets up and
   * never comes back down, so a trade that works a little but then stalls
   * exits flat or better instead of fading into a loser. The first rung is
   * intentionally clear of typical intraday premium noise; both rungs are
   * one-line tunables if live results say otherwise.
   */
  public static readonly PROFIT_LOCK_TRIGGER_MULT = 1.2;
  public static readonly PROFIT_LOCK_RUNG2_MULT = 1.5;
  public static readonly PROFIT_LOCK_RUNG2_FLOOR_MULT = 1.25;

  public static profitLockFloor(entryPrice: number, premiumHigh: number): number {
    const entry = Number(entryPrice);
    const high = Number(premiumHigh);
    if (!(entry > 0) || !(high > 0)) return 0;
    if (high >= entry * StopLossEngine.PROFIT_LOCK_RUNG2_MULT) {
      return entry * StopLossEngine.PROFIT_LOCK_RUNG2_FLOOR_MULT;
    }
    if (high >= entry * StopLossEngine.PROFIT_LOCK_TRIGGER_MULT) {
      return entry;
    }
    return 0;
  }

  /**
   * Evaluates a position against a new price point.
   * If price is higher than trailing_high, stop-loss trails up.
   * If price hits stop-loss, it triggers an alert.
   */
  static evaluate(
    currentPrice: number,
    position: {
      entry_price: number;
      stop_loss_trigger: number;
      take_profit_trigger?: number;
      trailing_high_price: number;
      trailing_stop_loss_pct?: number;
      trailing_floor_price?: number;
    }
  ): PositionEvaluationResult {
    let newHigh = position.trailing_high_price;
    let newStopLoss = position.stop_loss_trigger;
    let triggered = false;
    let triggerType: 'STOP_LOSS' | 'TAKE_PROFIT' | undefined;
    let lossAvoided = 0;

    // 1. Check Take Profit first (Priority)
    if (position.take_profit_trigger && currentPrice >= Number(position.take_profit_trigger)) {
      return {
        triggered: true,
        triggerType: 'TAKE_PROFIT'
      };
    }

    // 2. Update Trailing High if current price is higher
    if (currentPrice > position.trailing_high_price) {
      newHigh = currentPrice;
    }

    // 3. Trail Stop-Loss upward if we have a trailing percentage. Evaluate
    // from the recorded high even on activation so the first stop is armed.
    const trailingPct = Number(position.trailing_stop_loss_pct || 0);
    if (trailingPct > 0 && trailingPct < 100) {
      const potentialStop = roundProtectiveStop(newHigh * (1 - trailingPct / 100));
      const configuredFloor = Number(position.trailing_floor_price || 0);
      const nextStop = configuredFloor > 0 ? Math.max(potentialStop, configuredFloor) : potentialStop;
      if (nextStop > newStopLoss) {
        newStopLoss = nextStop;
      }
    }

    // 4. Check for Stop Loss Trigger
    if (currentPrice <= newStopLoss) {
      triggered = true;
      triggerType = 'STOP_LOSS';
      lossAvoided = position.entry_price - currentPrice;
    }

    return {
      triggered,
      triggerType,
      newStopLoss: newStopLoss !== position.stop_loss_trigger ? newStopLoss : undefined,
      newHigh: newHigh !== position.trailing_high_price ? newHigh : undefined,
      lossAvoided: triggered && triggerType === 'STOP_LOSS' ? lossAvoided : undefined,
    };
  }
}
