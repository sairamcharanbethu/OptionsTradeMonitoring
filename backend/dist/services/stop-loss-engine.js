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
        let lossAvoided = 0;
        // 1. Update Trailing High if current price is higher
        if (currentPrice > position.trailing_high_price) {
            newHigh = currentPrice;
            // 2. Trail Stop-Loss upward if we have a trailing percentage
            // Formula: newPeak * (1 - pct/100)
            if (position.trailing_stop_loss_pct) {
                const potentialStop = currentPrice * (1 - position.trailing_stop_loss_pct / 100);
                // Only move stop-loss UP, never down
                if (potentialStop > position.stop_loss_trigger) {
                    newStopLoss = potentialStop;
                }
            }
        }
        // 3. Check for Trigger
        if (currentPrice <= newStopLoss) {
            triggered = true;
            // Loss avoided = (Entry Price - Trigger Price) * qty [Qty handled in caller or analytics]
            // For simplicity in the engine, we return the per-unit loss avoided/realized
            lossAvoided = position.entry_price - currentPrice;
        }
        return {
            triggered,
            newStopLoss: newStopLoss !== position.stop_loss_trigger ? newStopLoss : undefined,
            newHigh: newHigh !== position.trailing_high_price ? newHigh : undefined,
            lossAvoided: triggered ? lossAvoided : undefined,
        };
    }
}
exports.StopLossEngine = StopLossEngine;
//# sourceMappingURL=stop-loss-engine.js.map