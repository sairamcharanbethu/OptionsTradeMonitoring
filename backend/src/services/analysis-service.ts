
import { FastifyInstance } from 'fastify';


interface Candle {
    start: string;
    low: number;
    high: number;
    open: number;
    close: number;
    volume: number;
}

interface AnalysisResult {
    support: number | null;
    resistance: number | null;
    stopLoss: number | null;
    takeProfit1: number | null;
    takeProfit2: number | null;
    confidences?: any;
}

export class AnalysisService {
    private fastify: FastifyInstance;
    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
    }

    public async analyzePosition(position: any): Promise<AnalysisResult> {
        const { symbol, option_type, entry_price } = position;
        const entryPrice = Number(entry_price);

        try {
            this.fastify.log.info(`[Analysis] Analyzing position ${symbol} (${option_type}) at entry $${entryPrice}...`);

            // 1. Get History (Candles)
            // We need enough data for EMA(21) and Pivots(7,7). 
            // 3-minute candles. 100 candles = 300 minutes (5 hours). 
            // Let's fetch 2 days to be safe.

            const questrade = (this.fastify as any).questrade;
            if (!questrade) throw new Error('Questrade Service not available');

            // Resolve Symbol ID
            // NOTE: The 'symbol' in position is the Option Ticker (ISO format).
            const symbolId = await questrade.getSymbolId(symbol);
            if (!symbolId) throw new Error(`Could not resolve symbol ID for ${symbol}`);

            const endTime = new Date();
            const startTime = new Date(endTime.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days back

            // Fetch 3-minute candles (using 'ThreeMinutes' if supported, else 'OneMinute' and aggregate?)
            // Questrade API Docs say 'ThreeMinutes' is valid.
            let candles: Candle[] = await questrade.getHistoricalData(symbolId, startTime, endTime, 'ThreeMinutes');

            if (!candles || candles.length < 30) {
                // Fallback to OneHour if 3m is too sparse/empty (common for options)
                this.fastify.log.warn(`[Analysis] Not enough 3m data for ${symbol}. Falling back to 1h.`);
                candles = await questrade.getHistoricalData(symbolId, startTime, endTime, 'OneHour');
                if (!candles || candles.length < 20) {
                    throw new Error('Insufficient historical data for analysis');
                }
            }

            // 2. Calculate Indicators
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);

            // EMA
            const ema9 = this.ema(closes, 9);
            const ema21 = this.ema(closes, 21);

            // ATR (14)
            const atr = this.atr(highs, lows, closes, 14);
            const currentAtr = atr[atr.length - 1] || (entryPrice * 0.01); // Fallback 1%

            // Pivots (7, 7)
            const pivotHighs = this.pivotHigh(highs, 7, 7);
            const pivotLows = this.pivotLow(lows, 7, 7);

            // 3. Logic from Pine Script
            // "Every stock option we need to find out the current resistance and support of that moment... 
            // Once we find out we will add suggested stop loss levels and take profit levels"

            // Pine Script SL/TP logic:
            // Long: Stop = Close - 1.5*ATR, Limit = Close + 2.5*ATR
            // Short: Stop = Close + 1.5*ATR, Limit = Close - 2.5*ATR
            // Since we bought the option (Long Position), we always want the option price to go UP.
            // Even if it's a PUT, the Option Price increases as the stock drops.
            // So we ALWAYS treat this as a "Long" trade on the Option Chart.
            // (Unless we are shorting/writing options, which the app doesn't seem to focus on primarily, but `quantity` > 0 usually means Long).
            // Assuming Long Call or Long Put -> We want Option Price to go UP.

            const suggestedStopLoss = entryPrice - (currentAtr * 1.5);
            const suggestedTakeProfit1 = entryPrice + (currentAtr * 2.5);
            const suggestedTakeProfit2 = entryPrice + (currentAtr * 4.0); // Arbitrary level 2

            // Support / Resistance
            // Find nearest Pivot Low below Entry (Support)
            // Find nearest Pivot High above Entry (Resistance)
            // Iterate backwards
            let support = null;
            let resistance = null;

            for (let i = pivotLows.length - 1; i >= 0; i--) {
                const p = pivotLows[i];
                if (p !== null && p < entryPrice) {
                    if (support === null || p > support) support = p;
                }
            }
            // If no support found below, use lowest low
            if (support === null) support = Math.min(...lows);

            for (let i = pivotHighs.length - 1; i >= 0; i--) {
                const p = pivotHighs[i];
                if (p !== null && p > entryPrice) {
                    if (resistance === null || p < resistance) resistance = p;
                }
            }
            // If no resistance found above, use highest high
            if (resistance === null) resistance = Math.max(...highs);

            this.fastify.log.info(`[Analysis] Result for ${symbol}: SL=${suggestedStopLoss}, TP=${suggestedTakeProfit1}, Sup=${support}, Res=${resistance}`);

            return {
                support: Number(support.toFixed(2)),
                resistance: Number(resistance.toFixed(2)),
                stopLoss: Number(Math.max(0, suggestedStopLoss).toFixed(2)),
                takeProfit1: Number(suggestedTakeProfit1.toFixed(2)),
                takeProfit2: Number(suggestedTakeProfit2.toFixed(2)),
                confidences: {
                    ema9: ema9[ema9.length - 1],
                    ema21: ema21[ema21.length - 1],
                    atr: currentAtr
                }
            };

        } catch (err: any) {
            this.fastify.log.error(`[Analysis] Failed to analyze position: ${err.message}`);
            // Return nulls but don't crash
            return {
                support: null,
                resistance: null,
                stopLoss: null,
                takeProfit1: null,
                takeProfit2: null
            };
        }
    }

    private ema(data: number[], length: number): (number | null)[] {
        const k = 2 / (length + 1);
        const result: (number | null)[] = new Array(data.length).fill(null);

        let sma = 0;
        for (let i = 0; i < length; i++) sma += data[i];

        if (data.length < length) return result;

        result[length - 1] = sma / length;

        for (let i = length; i < data.length; i++) {
            const prev = result[i - 1]!;
            result[i] = data[i] * k + prev * (1 - k);
        }
        return result;
    }

    private atr(highs: number[], lows: number[], closes: number[], length: number): (number | null)[] {
        if (highs.length < length + 1) return new Array(highs.length).fill(null);

        const trs: number[] = [];
        for (let i = 0; i < highs.length; i++) {
            if (i === 0) {
                trs.push(highs[i] - lows[i]);
            } else {
                const hl = highs[i] - lows[i];
                const hc = Math.abs(highs[i] - closes[i - 1]);
                const lc = Math.abs(lows[i] - closes[i - 1]);
                trs.push(Math.max(hl, hc, lc));
            }
        }

        // RMA (Wilder's Smoothing) is similar to EMA but with 1/length
        // Pine Script ATR uses RMA. RMA(x, y) = alpha * x + (1 - alpha) * prev
        // where alpha = 1 / y
        const alpha = 1 / length;
        const result: (number | null)[] = new Array(highs.length).fill(null);

        // First value is usually SMA of TR
        let sum = 0;
        for (let i = 0; i < length; i++) sum += trs[i];
        result[length - 1] = sum / length;

        for (let i = length; i < trs.length; i++) {
            result[i] = alpha * trs[i] + (1 - alpha) * result[i - 1]!;
        }

        return result;
    }

    private pivotHigh(data: number[], left: number, right: number): (number | null)[] {
        const result: (number | null)[] = new Array(data.length).fill(null);
        // Valid index range: [left, length - 1 - right]
        for (let i = left; i < data.length - right; i++) {
            let isPivot = true;
            // Check left
            for (let j = 1; j <= left; j++) {
                if (data[i - j] > data[i]) { isPivot = false; break; }
            }
            if (!isPivot) continue;

            // Check right
            for (let j = 1; j <= right; j++) {
                if (data[i + j] > data[i]) { isPivot = false; break; } // strict behavior > ? Pine uses >= usually? ta.pivothigh definition: strictly greater than neighbors? No, usually highest.
                // Pine `pivothigh`: "It returns the price of the pivot high point. A pivot high point is a high which is higher than `leftBars` highs before it and `rightBars` highs after it."
                // Usually implies strict inequality for exact peaks, or >=. Let's use > for now.
            }

            if (isPivot) {
                result[i] = data[i]; // The pivot is AT index i matches the chart logic.
                // NOTE: Pine script `pivothigh` returns the value at index `i`, but the pivot confirms at `i+right`. 
                // We're iterating historic data so we can see 'future'.
            }
        }
        return result;
    }

    private pivotLow(data: number[], left: number, right: number): (number | null)[] {
        const result: (number | null)[] = new Array(data.length).fill(null);
        for (let i = left; i < data.length - right; i++) {
            let isPivot = true;
            for (let j = 1; j <= left; j++) {
                if (data[i - j] < data[i]) { isPivot = false; break; }
            }
            if (!isPivot) continue;
            for (let j = 1; j <= right; j++) {
                if (data[i + j] < data[i]) { isPivot = false; break; }
            }
            if (isPivot) {
                result[i] = data[i];
            }
        }
        return result;
    }
}
