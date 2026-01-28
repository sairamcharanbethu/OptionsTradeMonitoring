import { FastifyInstance } from 'fastify';

import { AIService } from './ai-service';
import { spawn } from 'child_process';
import path from 'path';
import { redis } from '../lib/redis';

export interface TechnicalIndicators {
    rsi: number;
    macd: {
        macd: number;
        signal: number;
        histogram: number;
    };
    sma50: number;
    sma200: number;
    ema9: number;
    ema21: number;
    bollinger: {
        upper: number;
        lower: number;
        middle: number;
    };
}

export interface NewsHeadline {
    title: string;
    score: number;
    sentiment: 'Bullish' | 'Bearish' | 'Neutral';
    published: number;
}

export interface NewsAnalysis {
    available: boolean;
    aggregate_score: number;
    sentiment: 'Bullish' | 'Bearish' | 'Neutral';
    headline_count: number;
    headlines: NewsHeadline[];
    error?: string;
    message?: string;
}

export interface MarketIndicators {
    available: boolean;
    vix?: number;
    vix_level?: string;
    fear_greed?: {
        value: number;
        label: string;
    };
    fifty_two_week?: {
        high: number;
        low: number;
        current: number;
        distance_from_high_pct: number;
        distance_from_low_pct: number;
        position_in_range: number;
    };
    analyst_targets?: {
        mean_target: number;
        high_target?: number;
        low_target?: number;
        num_analysts: number;
        recommendation: string;
        upside_pct: number;
    };
    error?: string;
}

export interface PredictionResult {
    symbol: string;
    currentPrice: number;
    history: { date: string; close: number }[];
    indicators: TechnicalIndicators;
    newsSentiment?: NewsAnalysis;
    marketIndicators?: MarketIndicators;
    aiAnalysis: {
        verdict: 'Buy' | 'Sell' | 'Hold';
        reasoning: string;
    };
}

export class PredictionService {
    private fastify: FastifyInstance;
    private aiService: AIService;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
        this.aiService = new AIService(fastify);
    }

    async analyzeStock(symbol: string): Promise<PredictionResult> {
        try {
            const upperSymbol = symbol.toUpperCase();
            // 1. Check database cache for historical data (30-day retention)
            let historicalData: any[] = [];

            const { rows } = await this.fastify.pg.query(
                `SELECT data, fetched_at FROM stock_history_cache 
                 WHERE symbol = $1 AND fetched_at > NOW() - INTERVAL '30 days'`,
                [upperSymbol]
            );

            if (rows.length > 0) {
                const lastFetched = new Date(rows[0].fetched_at);
                const hoursSinceFetch = Math.floor((Date.now() - lastFetched.getTime()) / 1000 / 60 / 60);
                console.log(`[PredictionService] Found cached data for ${upperSymbol} (${hoursSinceFetch}h old)`);

                historicalData = rows[0].data;
                const questrade = (this.fastify as any).questrade;

                // Incremental Update: If data is older than 4 hours, fetch only the missing "gap"
                if (hoursSinceFetch >= 4) {
                    console.log(`[PredictionService] Cache stale (${hoursSinceFetch}h). Performing incremental sync...`);
                    try {
                        const symbolId = await questrade.getSymbolId(upperSymbol);
                        if (symbolId) {
                            const lastDateInCache = new Date(historicalData[historicalData.length - 1].date);
                            const nextDay = new Date(lastDateInCache);
                            nextDay.setDate(nextDay.getDate() + 1);

                            const now = new Date();

                            if (nextDay < now) {
                                const newCandles = await questrade.getHistoricalData(symbolId, nextDay, now, 'OneDay');
                                if (newCandles && newCandles.length > 0) {
                                    const mappedNew = newCandles.map((c: any) => ({
                                        date: c.start.split('T')[0],
                                        open: c.open,
                                        high: c.high,
                                        low: c.low,
                                        close: c.close,
                                        volume: c.volume
                                    }));

                                    // Merge and remove duplicates (by date)
                                    const merged = [...historicalData, ...mappedNew];
                                    const unique = Array.from(new Map(merged.map(item => [item.date, item])).values());
                                    historicalData = unique.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

                                    // Update DB with merged set
                                    await this.fastify.pg.query(
                                        `UPDATE stock_history_cache SET data = $2, fetched_at = CURRENT_TIMESTAMP WHERE symbol = $1`,
                                        [upperSymbol, JSON.stringify(historicalData)]
                                    );
                                    console.log(`[PredictionService] Incremental sync complete. Added ${mappedNew.length} new days.`);
                                }
                            }
                        }
                    } catch (syncErr: any) {
                        console.warn(`[PredictionService] Incremental sync failed (falling back to cache): ${syncErr.message}`);
                    }
                }
            } else {
                // Fetch fresh (Full 5 Years) from Questrade
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(endDate.getDate() - 1825); // 5 Years

                console.log(`[PredictionService] Bootstrapping 5-year history for ${upperSymbol}...`);

                const questrade = (this.fastify as any).questrade;
                const symbolId = await questrade.getSymbolId(upperSymbol);

                if (!symbolId) {
                    throw new Error(`Symbol ${upperSymbol} not found on Questrade.`);
                }

                const candles = await questrade.getHistoricalData(symbolId, startDate, endDate, 'OneDay');

                if (!candles || candles.length < 200) {
                    throw new Error(`Insufficient data for ${upperSymbol} from Questrade. Need at least 200 days.`);
                }

                // Map Questrade candles to expected format
                historicalData = candles.map((c: any) => ({
                    date: c.start.split('T')[0],
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume
                }));

                // Store in database with symbol_id
                await this.fastify.pg.query(
                    `INSERT INTO stock_history_cache (symbol, symbol_id, data, fetched_at) 
                     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                     ON CONFLICT (symbol) DO UPDATE SET symbol_id = $2, data = $3, fetched_at = CURRENT_TIMESTAMP`,
                    [upperSymbol, symbolId, JSON.stringify(historicalData)]
                );
                console.log(`[PredictionService] Cached 5-year history for ${upperSymbol} in database`);
            }

            // 2. Run ML Prediction (Python) - pass symbol for news sentiment
            // Assuming script is at src/scripts/predict_stock.py and we are running from dist/ or src/
            const scriptPath = path.resolve(__dirname, '../scripts/predict_stock.py');

            const mlResult = await this.runPythonScript(scriptPath, { symbol: upperSymbol, data: historicalData });

            // 3. Technical Indicators (Still useful to return for frontend charting)
            // Re-sort for our calc if needed (Python handled sorting too)
            const prices = historicalData.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
            const closes = prices.map((p: any) => p.close);
            const currentPrice = closes[closes.length - 1];

            const rsi = this.calculateRSI(closes);
            const macd = this.calculateMACD(closes);
            const sma50 = this.calculateSMA(closes, 50);
            const sma200 = this.calculateSMA(closes, 200);
            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            const bollinger = this.calculateBollingerBands(closes);

            const indicators: TechnicalIndicators = {
                rsi,
                macd,
                sma50,
                sma200,
                ema9,
                ema21,
                bollinger
            };

            // 4. AI Analysis (Augmented with ML)
            const aiAnalysis = await this.getAIAnalysis(symbol, currentPrice, indicators, mlResult);

            const finalResult: PredictionResult = {
                symbol: symbol.toUpperCase(),
                currentPrice,
                history: prices.slice(-180), // Return last 180 days for chart
                indicators,
                newsSentiment: mlResult.news_analysis,
                marketIndicators: mlResult.market_indicators,
                aiAnalysis
            };

            return finalResult;

        } catch (err: any) {
            this.fastify.log.error(err);
            throw new Error(`Prediction failed for ${symbol}: ${err.message}`);
        }
    }

    private async runPythonScript(scriptPath: string, data: any): Promise<any> {
        return new Promise((resolve, reject) => {
            // Environment-aware python command
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            const pythonProcess = spawn(pythonCmd, [scriptPath]);

            let resultString = '';
            let errorString = '';

            pythonProcess.on('error', (err) => {
                reject(new Error(`Failed to start Python process (${pythonCmd}): ${err.message}. Ensure Python is installed and in your PATH.`));
            });

            if (pythonProcess.stdin) {
                pythonProcess.stdin.on('error', (err) => {
                    console.error('[PredictionService] Stdin error:', err.message);
                });
                // Feed data to script via stdin
                pythonProcess.stdin.write(JSON.stringify(data));
                pythonProcess.stdin.end();
            }

            pythonProcess.stdout.on('data', (data) => {
                resultString += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorString += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Python script exited with code ${code}: ${errorString}`));
                }
                try {
                    const lines = resultString.trim().split('\n');
                    const jsonLine = lines[lines.length - 1];
                    const json = JSON.parse(jsonLine);

                    if (json.error) return reject(new Error(json.error));
                    resolve(json);
                } catch (e) {
                    reject(new Error(`Failed to parse Python output. Raw: ${resultString} | Error: ${e}`));
                }
            });
        });
    }

    private async getAIAnalysis(symbol: string, price: number, indicators: TechnicalIndicators, mlResult: any) {
        // Build news sentiment section if available
        let newsSentimentSection = '';
        if (mlResult.news_analysis && mlResult.news_analysis.available) {
            const news = mlResult.news_analysis;
            const topHeadlines = (news.headlines || []).slice(0, 3).map((h: any) =>
                `  - "${h.title}" (${h.sentiment}, score: ${h.score})`
            ).join('\n');

            newsSentimentSection = `
        3. NEWS SENTIMENT ANALYSIS (VADER):
        - Aggregate Score: ${news.aggregate_score} (range: -1 bearish to +1 bullish)
        - Overall News Sentiment: ${news.sentiment}
        - Headlines Analyzed: ${news.headline_count}
        ${topHeadlines ? `- Top Headlines:\n${topHeadlines}` : ''}
        `;
        }

        // Build market indicators section if available
        let marketIndicatorsSection = '';
        if (mlResult.market_indicators && mlResult.market_indicators.available) {
            const mkt = mlResult.market_indicators;
            const vixInfo = mkt.vix ? `VIX: ${mkt.vix} (${mkt.vix_level})` : '';
            const fearGreed = mkt.fear_greed ? `Fear & Greed: ${mkt.fear_greed.value}/100 (${mkt.fear_greed.label})` : '';
            const fiftyTwo = mkt.fifty_two_week ?
                `52-Week Position: ${mkt.fifty_two_week.position_in_range.toFixed(0)}% (${mkt.fifty_two_week.distance_from_high_pct.toFixed(1)}% from high)` : '';
            const analyst = mkt.analyst_targets ?
                `Analyst Target: $${mkt.analyst_targets.mean_target} (${mkt.analyst_targets.upside_pct > 0 ? '+' : ''}${mkt.analyst_targets.upside_pct.toFixed(1)}% upside) - ${mkt.analyst_targets.recommendation.toUpperCase()} (${mkt.analyst_targets.num_analysts} analysts)` : '';

            marketIndicatorsSection = `
        4. MARKET SENTIMENT & CONTEXT:
        - ${vixInfo}
        - ${fearGreed}
        - ${fiftyTwo}
        - ${analyst}
        `;
        }

        const prompt = `
        Analyze this stock combining Technical Analysis, ML predictions, News Sentiment, and Market Context.
        
        ASSET: ${symbol} at $${price.toFixed(2)}

        1. MACHINE LEARNING MODEL (Random Forest):
        - Probability of Up-trend: ${(mlResult.prediction_probability_up * 100).toFixed(1)}%
        - Combined Score (ML + News): ${((mlResult.combined_score || mlResult.prediction_probability_up) * 100).toFixed(1)}%
        - Model Sentiment: ${mlResult.sentiment}
        - Key Drivers: RSI=${mlResult.features.rsi.toFixed(1)}, Recent Trend=${mlResult.features.trend_5.toFixed(3)}
        
        2. TECHNICAL INDICATORS & MOMENTUM:
        - RSI (14): ${indicators.rsi.toFixed(2)}
        - EMA 9 (Fast): $${indicators.ema9.toFixed(2)}
        - EMA 21 (Med): $${indicators.ema21.toFixed(2)}
        - EMA/Price Alignment: Price is ${price > indicators.ema9 ? 'above' : 'below'} EMA9.
        - SMA 50: $${indicators.sma50.toFixed(2)}
        - SMA 200: $${indicators.sma200.toFixed(2)}
        - Trend: Price is ${price > indicators.sma200 ? 'above' : 'below'} SMA200 (Long term) and ${price > indicators.sma50 ? 'above' : 'below'} SMA50 (Medium term).
        ${newsSentimentSection}${marketIndicatorsSection}
        TASK: Provide a definitive trading verdict (Buy/Sell/Hold) and synthesis.
        - The SMA200 is the "Institutional Floor". If price is above, favor Buy/Hold. If below, favor Sell/Hold.
        - EMA Crossovers: If EMA 9 > EMA 21, momentum is bullish. If EMA 9 < EMA 21, it's bearish.
        - NEWS SENTIMENT: If news is strongly bullish/bearish, factor this into your recommendation.
        - VIX/FEAR & GREED: Extreme fear = potential contrarian buy, extreme greed = caution.
        - 52-WEEK POSITION: Near 52-week low may signal value, near high may signal resistance.
        - ANALYST TARGETS: Consider upside/downside potential vs current price.
        - If conflict (ML Bullish but Price < SMA200), remain cautious.
        - Be decisive. If indicators align, don't just say "no clear signal".
        
        Format: JSON { "verdict": "Buy" | "Sell" | "Hold", "reasoning": "..." }
        `;

        const result = await (this.aiService as any).askAI(prompt);
        return {
            verdict: result.verdict,
            reasoning: result.analysis || result.reasoning || ''
        };
    }

    private calculateRSI(prices: number[], period: number = 14): number {
        if (prices.length < period + 1) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        // Smoothed
        // Actually standard RSI smoothing is (prevAvg * (period-1) + current) / period
        // For simplicity on a dynamic fetch, simple avg of last 14 is often "good enough" approximation 
        // but let's do one optimization if we have data.
        // We really should loop from the beginning to make it accurate. 

        // Accurate RSI Calculation:
        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        let avgGain2 = 0;
        let avgLoss2 = 0;

        // First average
        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain2 += changes[i];
            else avgLoss2 += Math.abs(changes[i]);
        }
        avgGain2 /= period;
        avgLoss2 /= period;

        // Smooth
        for (let i = period; i < changes.length; i++) {
            const change = changes[i];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain2 = (avgGain2 * (period - 1) + gain) / period;
            avgLoss2 = (avgLoss2 * (period - 1) + loss) / period;
        }

        if (avgLoss2 === 0) return 100;
        const rs = avgGain2 / avgLoss2;
        return 100 - (100 / (1 + rs));
    }

    private calculateSMA(prices: number[], period: number): number {
        if (prices.length < period) return 0;
        const slice = prices.slice(-period);
        const sum = slice.reduce((a, b) => a + b, 0);
        return sum / period;
    }

    private calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
        const ema12 = this.calculateEMA(prices, 12);
        const ema26 = this.calculateEMA(prices, 26);
        const macdLine = ema12 - ema26;

        // We need the MACD line HISTORY to calculate Signal line (9 EMA of MACD)
        // This is complex to do efficiently with just current arrays without calculating full series.
        // Simplified approach for MVP: Calculate EMA12 and EMA26 series for the last 9 points + padding.

        const macdSeries = [];
        const lookback = 9 + 26; // minimal needed
        const startIdx = prices.length - lookback;

        if (startIdx < 0) return { macd: 0, signal: 0, histogram: 0 }; // Not enough data

        // Full series approach for correctness
        const ema12Series = this.calculateEMASeries(prices, 12);
        const ema26Series = this.calculateEMASeries(prices, 26);

        const macdLineSeries = ema12Series.map((v, i) => v - ema26Series[i]);

        // Signal is EMA9 of MACD Series
        const signalLine = this.calculateEMA(macdLineSeries, 9); // This takes the LAST value

        return {
            macd: macdLine,
            signal: signalLine,
            histogram: macdLine - signalLine
        };
    }

    private calculateEMASeries(prices: number[], period: number): number[] {
        const k = 2 / (period + 1);
        const emaSeries = [prices[0]]; // Start with SMA equivalent or just first price
        for (let i = 1; i < prices.length; i++) {
            const ema = prices[i] * k + emaSeries[i - 1] * (1 - k);
            emaSeries.push(ema);
        }
        return emaSeries;
    }

    private calculateEMA(prices: number[], period: number): number {
        const series = this.calculateEMASeries(prices, period);
        return series[series.length - 1];
    }

    private calculateBollingerBands(prices: number[], period: number = 20, multiplier: number = 2) {
        const sma = this.calculateSMA(prices, period);
        const slice = prices.slice(-period);
        const squaredDiffs = slice.map(p => Math.pow(p - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const stdDev = Math.sqrt(variance);

        return {
            middle: sma,
            upper: sma + (stdDev * multiplier),
            lower: sma - (stdDev * multiplier)
        };
    }
}
