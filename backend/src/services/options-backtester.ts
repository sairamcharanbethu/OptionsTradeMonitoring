import { FastifyInstance } from 'fastify';
import YahooFinance from 'yahoo-finance2';
import { AIService } from './ai-service';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });

export interface BacktestTrade {
    date: string;
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strike: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    pnl: number;
    roi: number;
    entryTime: string;
    exitTime: string;
    exitReason: string;
    dte: '0DTE' | '1DTE';
    reasoning: string;
}

export interface BacktestResult {
    symbol: string;
    startDate: string;
    endDate: string;
    mode: 'rule-based' | 'ai';
    initialCapital: number;
    finalCapital: number;
    totalReturn: number;
    totalReturnPct: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
    tradesCount: number;
    wins: number;
    losses: number;
    trades: BacktestTrade[];
    equityCurve: Array<{ date: string; pnl: number; capital: number }>;
}

// Black-Scholes Helper functions
function normalCDF(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - p : p;
}

function normalPDF(x: number): number {
    return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

function calculateBSPrice(S: number, K: number, t: number, r: number, sigma: number, isCall: boolean): number {
    if (sigma <= 0 || t <= 0) return Math.max(0.01, isCall ? S - K : K - S);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
    const d2 = d1 - sigma * Math.sqrt(t);
    
    let price = 0;
    if (isCall) {
        price = S * normalCDF(d1) - K * Math.exp(-r * t) * normalCDF(d2);
    } else {
        price = K * Math.exp(-r * t) * normalCDF(-d2) - S * normalCDF(-d1);
    }
    return isNaN(price) || price < 0.01 ? 0.01 : price;
}

export class OptionsBacktester {
    private fastify: FastifyInstance;
    private aiService: AIService;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
        this.aiService = new AIService(fastify);
    }

    /**
     * Executes options day trading backtest over historical price bars.
     */
    async runBacktest(
        symbol: string,
        startDateStr: string,
        endDateStr: string,
        mode: 'rule-based' | 'ai' = 'rule-based',
        contractSize: number = 5
    ): Promise<BacktestResult> {
        this.fastify.log.info(`[OptionsBacktester] Running ${mode} backtest for ${symbol} from ${startDateStr} to ${endDateStr}...`);

        const start = new Date(startDateStr);
        const end = new Date(endDateStr);

        // Fetch daily bars for indicators calculations
        const dailyBars = await (yahooFinance as any).historical(symbol, {
            period1: new Date(start.getTime() - 250 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 250 days lookback for SMA200
            period2: endDateStr,
            interval: '1d'
        });

        // Fetch 15m intraday bars for option trade exit tracking
        const chartData = await (yahooFinance as any).chart(symbol, {
            period1: startDateStr,
            period2: endDateStr,
            interval: '15m'
        });

        if (!chartData || !chartData.quotes || chartData.quotes.length === 0) {
            throw new Error(`Failed to fetch historical chart bars for ${symbol}`);
        }

        const quotes = chartData.quotes;

        // Group 15m quotes by trading date (YYYY-MM-DD)
        const dailyQuotesMap: Map<string, any[]> = new Map();
        for (const q of quotes) {
            if (!q.date || q.open === null || q.close === null) continue;
            const dateStr = q.date instanceof Date ? q.date.toISOString().split('T')[0] : new Date(q.date).toISOString().split('T')[0];
            const existing = dailyQuotesMap.get(dateStr) || [];
            existing.push(q);
            dailyQuotesMap.set(dateStr, existing);
        }

        const tradingDays = Array.from(dailyQuotesMap.keys()).sort((a, b) => a.localeCompare(b));
        this.fastify.log.info(`[OptionsBacktester] Found ${tradingDays.length} trading days in range.`);

        // Enforce safety limits for AI mode to prevent burning token limits
        if (mode === 'ai' && tradingDays.length > 7) {
            throw new Error('AI Decision Mode is limited to a maximum of 7 trading days. Use Rule-Based Mode for larger backtests.');
        }

        // Initialize backtesting variables
        const initialCapital = 10000;
        let currentCapital = initialCapital;
        const trades: BacktestTrade[] = [];
        const equityCurve: Array<{ date: string; pnl: number; capital: number }> = [];
        let peakCapital = initialCapital;
        let maxDrawdown = 0;

        // Loop trading days sequentially
        for (const dateStr of tradingDays) {
            const dayQuotes = dailyQuotesMap.get(dateStr)!;
            if (dayQuotes.length < 5) continue; // Skip partial data

            // 1. Calculate technical indicators for today using historical closes
            const dayIdx = dailyBars.findIndex((b: any) => {
                const bDateStr = b.date instanceof Date ? b.date.toISOString().split('T')[0] : new Date(b.date).toISOString().split('T')[0];
                return bDateStr === dateStr;
            });

            if (dayIdx < 50) continue; // Need at least 50 days of history for EMAs/SMA

            const closesSlice = dailyBars.slice(0, dayIdx + 1).map((b: any) => b.close);
            const spotPrice = closesSlice[closesSlice.length - 1];

            // Technical Solver Indicators
            const ema9 = this.calculateEMA(closesSlice, 9);
            const ema21 = this.calculateEMA(closesSlice, 21);
            const sma50 = this.calculateSMA(closesSlice, 50);
            const sma200 = this.calculateSMA(closesSlice, 200);
            const rsi = this.calculateRSI(closesSlice, 14);

            // GEX & Greeks Proxy Model for backtesting
            // Use trend structure and volatility to approximate dealer positioning
            const isBullishTrend = spotPrice > sma50;
            const isStrongTrend = spotPrice > sma200;
            const trendStrength = Math.abs(ema9 - ema21) / spotPrice * 100; // as % of spot

            // In strong trends with low vol (tight EMAs), dealers are likely long gamma (Positive GEX)
            // In weak/volatile markets (wide EMAs), dealers are likely short gamma (Negative GEX)
            const isPositiveGex = isStrongTrend && trendStrength < 0.5;
            const simulatedNetGex = isPositiveGex ? 45000000 : -25000000;

            // Walls and flip derived from daily levels, not artificially from spot
            const gammaFlip = sma50; // Gamma flip approximated at institutional moving average
            const callWall = spotPrice * 1.015; // 1.5% above (more realistic than 2%)
            const putWall = spotPrice * 0.985;  // 1.5% below

            // Enforce maximum of 2-3 trades per day (we will take up to 2 high probability setups per day)
            let dailyTradeCount = 0;

            // Track intraday 15m intervals
            // Typically, SPY/QQQ trading hours are 9:30 AM (minutes = 570) to 4:00 PM (minutes = 960) ET
            for (let i = 0; i < dayQuotes.length; i++) {
                if (dailyTradeCount >= 2) break; // Daily limit reached

                const quote = dayQuotes[i];
                const quoteTime = new Date(quote.date);
                const etHour = quoteTime.getUTCHours() - 4; // Approx Eastern Time (adjusting for standard daylight offset in GMT)
                const etMinute = quoteTime.getUTCMinutes();
                const etTimeMinutes = etHour * 60 + etMinute;

                // 2. Scan Entries at scheduled checkpoints (Morning Session < 1:00 PM (780 mins), Afternoon >= 1:00 PM)
                // Filter setups around 9:45 AM (585 mins) and 1:30 PM (810 mins)
                const isCheckpoint = (etTimeMinutes >= 585 && etTimeMinutes <= 600) || (etTimeMinutes >= 810 && etTimeMinutes <= 825);
                if (!isCheckpoint) continue;

                const isMorning = etTimeMinutes < 13 * 60;
                const dte = isMorning ? '0DTE' : '1DTE';
                const stopLossPct = isMorning ? 10 : 20;
                const takeProfitPct = 20;

                // 3. AI or Rule-Based decision block
                let verdict: 'BUY_CALL' | 'BUY_PUT' | 'WAIT' = 'WAIT';
                let reasoning = '';

                if (mode === 'rule-based') {
                    // Quantitative Rule-Based solver
                    const emaCrossBullish = ema9 > ema21;
                    const emaCrossBearish = ema9 < ema21;
                    const rsiBullish = rsi > 50;
                    const rsiBearish = rsi < 50;

                    if (isPositiveGex) {
                        // Mean reversion regime: fade extremes at dealer walls
                        if (quote.close <= putWall * 1.005 && rsi < 45) {
                            verdict = 'BUY_CALL';
                            reasoning = `Support near Put Wall ($${putWall.toFixed(0)}) in Positive GEX with RSI ${rsi.toFixed(1)} oversold.`;
                        } else if (quote.close >= callWall * 0.995 && rsi > 55) {
                            verdict = 'BUY_PUT';
                            reasoning = `Resistance near Call Wall ($${callWall.toFixed(0)}) in Positive GEX with RSI ${rsi.toFixed(1)} overbought.`;
                        }
                    } else {
                        // Negative GEX / Trending regime: trend-following with momentum confirmation
                        if (emaCrossBullish && rsiBullish && quote.close > gammaFlip) {
                            verdict = 'BUY_CALL';
                            reasoning = `Bullish EMA crossover above Gamma Flip ($${gammaFlip.toFixed(0)}), RSI ${rsi.toFixed(1)} confirms momentum.`;
                        } else if (emaCrossBearish && rsiBearish && quote.close < gammaFlip) {
                            verdict = 'BUY_PUT';
                            reasoning = `Bearish EMA crossover below Gamma Flip ($${gammaFlip.toFixed(0)}), RSI ${rsi.toFixed(1)} confirms weakness.`;
                        } else if (emaCrossBullish && rsi > 45 && isBullishTrend) {
                            // Relaxed bullish entry in trending markets — EMA9 > EMA21 with price above SMA50
                            verdict = 'BUY_CALL';
                            reasoning = `Trending bullish: EMA9 > EMA21, price above SMA50 ($${sma50.toFixed(0)}), RSI ${rsi.toFixed(1)}.`;
                        } else if (emaCrossBearish && rsi < 55 && !isBullishTrend) {
                            // Relaxed bearish entry in downtrending markets
                            verdict = 'BUY_PUT';
                            reasoning = `Trending bearish: EMA9 < EMA21, price below SMA50 ($${sma50.toFixed(0)}), RSI ${rsi.toFixed(1)}.`;
                        }
                    }
                } else {
                    // AI Prompt execution
                    const prompt = `
                    Evaluate this historical setup:
                    ASSET: ${symbol} at $${quote.close.toFixed(2)}
                    Time: ${etHour}:${etMinute} (Target expiry: ${dte})
                    
                    TECHNICAL INDICATORS:
                    - RSI: ${rsi.toFixed(2)}
                    - EMA9: ${ema9.toFixed(2)} | EMA21: ${ema21.toFixed(2)}
                    - SMA50: ${sma50.toFixed(2)} | SMA200: ${sma200.toFixed(2)}
                    
                    DEALER LEVEL PROXIES:
                    - Net GEX: $${simulatedNetGex.toLocaleString()}
                    - Gamma Flip: $${gammaFlip.toFixed(2)}
                    - Call Wall: $${callWall.toFixed(2)}
                    - Put Wall: $${putWall.toFixed(2)}
                    
                    Make a deterministic day-trading decision (BUY_CALL, BUY_PUT, or WAIT).
                    Respond ONLY in JSON format:
                    { "verdict": "BUY_CALL" | "BUY_PUT" | "WAIT", "reasoning": "2 sentences of audit trace" }
                    `;

                    try {
                        const aiRes = await this.aiService.askTradingJSON(prompt, undefined, 160);
                        const aiVerdict = aiRes.verdict;
                        verdict = aiVerdict === 'BUY_CALL' || aiVerdict === 'BUY_PUT' || aiVerdict === 'WAIT'
                            ? aiVerdict
                            : 'WAIT';
                        reasoning = aiRes.reasoning || aiRes.analysis || '';
                    } catch (e) {
                        verdict = 'WAIT';
                    }
                }

                if (verdict === 'BUY_CALL' || verdict === 'BUY_PUT') {
                    dailyTradeCount++;
                    const optionType = verdict === 'BUY_CALL' ? 'CALL' : 'PUT';

                    // Black-Scholes Simulated Entry
                    const entrySpot = quote.close;
                    const strike = Math.round(entrySpot) + (optionType === 'CALL' ? 1 : -1);
                    const iv = 0.18; // 18% implied volatility average
                    const r = 0.05; // 5% risk-free rate
                    const tEntry = dte === '0DTE' ? 0.015 : 1.01 / 365;

                    const entryPrice = calculateBSPrice(entrySpot, strike, tEntry, r, iv, optionType === 'CALL');
                    const tradeValue = entryPrice * contractSize * 100;

                    // Skip if trade exceeds current capital
                    if (tradeValue > currentCapital) {
                        this.fastify.log.warn(`[OptionsBacktester] Insufficient capital for trade. Skip.`);
                        continue;
                    }

                    // 4. Intraday Exit Emulator
                    let exitPrice = entryPrice;
                    let exitTimeStr = '3:50 PM';
                    let exitReason = 'EOD Cutoff';
                    let exitIndex = i;
                    const underlyingStopPrice = optionType === 'CALL' ? entrySpot * 0.995 : entrySpot * 1.005;
                    const underlyingTargetPrice = optionType === 'CALL' ? entrySpot * 1.01 : entrySpot * 0.99;

                    for (let j = i + 1; j < dayQuotes.length; j++) {
                        const exitQuote = dayQuotes[j];
                        const exitQuoteTime = new Date(exitQuote.date);
                        const exitEtHour = exitQuoteTime.getUTCHours() - 4;
                        const exitEtMin = exitQuoteTime.getUTCMinutes();
                        const exitMins = exitEtHour * 60 + exitEtMin;

                        const tExit = Math.max(0.001, tEntry - ((j - i) * 15) / (24 * 60 * 365));
                        
                        // Check Take Profit first (Priority)
                        let tpTriggered = false;
                        if (optionType === 'CALL' && exitQuote.high >= underlyingTargetPrice) {
                            tpTriggered = true;
                        } else if (optionType === 'PUT' && exitQuote.low <= underlyingTargetPrice) {
                            tpTriggered = true;
                        }

                        if (tpTriggered) {
                            exitPrice = calculateBSPrice(underlyingTargetPrice, strike, tExit, r, iv, optionType === 'CALL');
                            exitTimeStr = `${exitEtHour}:${exitEtMin.toString().padStart(2, '0')}`;
                            exitReason = 'Underlying Take Profit Hit (+1.0%)';
                            exitIndex = j;
                            break;
                        }

                        // Check Stop Loss
                        let slTriggered = false;
                        if (optionType === 'CALL' && exitQuote.low <= underlyingStopPrice) {
                            slTriggered = true;
                        } else if (optionType === 'PUT' && exitQuote.high >= underlyingStopPrice) {
                            slTriggered = true;
                        }

                        if (slTriggered) {
                            exitPrice = calculateBSPrice(underlyingStopPrice, strike, tExit, r, iv, optionType === 'CALL');
                            exitTimeStr = `${exitEtHour}:${exitEtMin.toString().padStart(2, '0')}`;
                            exitReason = 'Underlying Stop Loss Hit (-0.5%)';
                            exitIndex = j;
                            break;
                        }

                        // Check Hard Cutoffs
                        if (isMorning && exitMins >= 13 * 60) {
                            // 1:00 PM morning exit cutoff
                            exitPrice = calculateBSPrice(exitQuote.close, strike, tExit, r, iv, optionType === 'CALL');
                            exitTimeStr = '1:00 PM';
                            exitReason = 'Morning Session Cutoff (1:00 PM ET)';
                            exitIndex = j;
                            break;
                        }

                        if (exitMins >= 15 * 60 + 50) {
                            // 3:50 PM EOD exit cutoff
                            exitPrice = calculateBSPrice(exitQuote.close, strike, tExit, r, iv, optionType === 'CALL');
                            exitTimeStr = '3:50 PM';
                            exitReason = 'EOD Liquidation Cutoff (3:50 PM ET)';
                            exitIndex = j;
                            break;
                        }
                    }

                    // Compute realized PnL
                    const tradePnl = (exitPrice - entryPrice) * contractSize * 100;
                    currentCapital += tradePnl;

                    // Drawdown calculations
                    if (currentCapital > peakCapital) {
                        peakCapital = currentCapital;
                    }
                    const drawdown = ((peakCapital - currentCapital) / peakCapital) * 100;
                    if (drawdown > maxDrawdown) {
                        maxDrawdown = drawdown;
                    }

                    trades.push({
                        date: dateStr,
                        symbol,
                        optionType,
                        strike,
                        entryPrice,
                        exitPrice,
                        quantity: contractSize,
                        pnl: tradePnl,
                        roi: ((exitPrice - entryPrice) / entryPrice) * 100,
                        entryTime: `${etHour}:${etMinute.toString().padStart(2, '0')}`,
                        exitTime: exitTimeStr,
                        exitReason,
                        dte,
                        reasoning
                    });

                    // Fast forward loop to exit point to prevent multiple entries on same asset
                    i = exitIndex;
                }
            }

            // Record daily equity stats
            equityCurve.push({
                date: dateStr,
                pnl: currentCapital - initialCapital,
                capital: currentCapital
            });
        }

        // Aggregate statistics
        const tradesCount = trades.length;
        const wins = trades.filter(t => t.pnl > 0).length;
        const losses = trades.filter(t => t.pnl <= 0).length;
        const winRate = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;

        const totalGains = trades.filter(t => t.pnl > 0).reduce((acc, t) => acc + t.pnl, 0);
        const totalLosses = Math.abs(trades.filter(t => t.pnl <= 0).reduce((acc, t) => acc + t.pnl, 0));
        const profitFactor = totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? 99.9 : 0;

        return {
            symbol: symbol.toUpperCase(),
            startDate: startDateStr,
            endDate: endDateStr,
            mode,
            initialCapital,
            finalCapital: currentCapital,
            totalReturn: currentCapital - initialCapital,
            totalReturnPct: ((currentCapital - initialCapital) / initialCapital) * 100,
            winRate,
            profitFactor,
            maxDrawdown,
            tradesCount,
            wins,
            losses,
            trades,
            equityCurve
        };
    }

    // Indicator helpers
    private calculateSMA(prices: number[], period: number): number {
        if (prices.length < period) return prices[prices.length - 1];
        const slice = prices.slice(-period);
        const sum = slice.reduce((a, b) => a + b, 0);
        return sum / period;
    }

    private calculateEMA(prices: number[], period: number): number {
        if (prices.length < period) return prices[prices.length - 1];
        const k = 2 / (period + 1);
        let ema = prices[0];
        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }
        return ema;
    }

    private calculateRSI(prices: number[], period: number = 14): number {
        if (prices.length < period + 1) return 50;

        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        let avgGain = 0;
        let avgLoss = 0;

        // First average
        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain += changes[i];
            else avgLoss += Math.abs(changes[i]);
        }
        avgGain /= period;
        avgLoss /= period;

        // Smooth
        for (let i = period; i < changes.length; i++) {
            const change = changes[i];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }
}
