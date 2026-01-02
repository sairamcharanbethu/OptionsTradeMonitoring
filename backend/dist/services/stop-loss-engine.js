"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StopLossEngine = void 0;
class StopLossEngine {
    /**
     * Evaluates a position against a new price point.
     * If price is higher than trailing_high, stop-loss trails up.
     * If price hits stop-loss, it triggers an alert.
     */
    static evaluate(currentPrice, position) {
        let newHigh = position.trailing_high_price;
        let newStopLoss = position.stop_loss_trigger;
        let triggered = false;
        let triggerType;
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
            // 3. Trail Stop-Loss upward if we have a trailing percentage
            if (position.trailing_stop_loss_pct) {
                const potentialStop = currentPrice * (1 - position.trailing_stop_loss_pct / 100);
                if (potentialStop > position.stop_loss_trigger) {
                    newStopLoss = potentialStop;
                }
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
exports.StopLossEngine = StopLossEngine;
//# sourceMappingURL=stop-loss-engine.js.map