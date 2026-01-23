
import yahooFinance from 'yahoo-finance2';
import { FastifyInstance } from 'fastify';

import { AIService } from './ai-service';
import { spawn } from 'child_process';
import path from 'path';

export interface TechnicalIndicators {
    rsi: number;
    macd: {
        macd: number;
        signal: number;
        histogram: number;
    };
    sma50: number;
    sma200: number;
    bollinger: {
        upper: number;
        lower: number;
        middle: number;
    };
}

export interface PredictionResult {
    symbol: string;
    currentPrice: number;
    history: { date: string; close: number }[];
    indicators: TechnicalIndicators;
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
            // 1. Fetch Historical Data (Last 500 days for better training context)
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 730); // 2 years

            const result = await yahooFinance.historical(symbol, {
                period1: startDate,
                interval: '1d'
            });

            if (!result || !Array.isArray(result) || (result as any[]).length < 200) {
                throw new Error(`Insufficient data for ${symbol}. Need at least 200 days of history.`);
            }

            // Clean data for Python
            const historicalData = (result as any[]).map(row => ({
                date: row.date.toISOString().split('T')[0],
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume
            }));

            // 2. Run ML Prediction (Python)
            // Assuming script is at src/scripts/predict_stock.py and we are running from dist/ or src/
            const scriptPath = path.resolve(__dirname, '../scripts/predict_stock.py');

            const mlResult = await this.runPythonScript(scriptPath, historicalData);

            // 3. Technical Indicators (Still useful to return for frontend charting)
            // Re-sort for our calc if needed (Python handled sorting too)
            const prices = historicalData.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
            const closes = prices.map((p: any) => p.close);
            const currentPrice = closes[closes.length - 1];

            const rsi = this.calculateRSI(closes);
            const macd = this.calculateMACD(closes);
            const sma50 = this.calculateSMA(closes, 50);
            const sma200 = this.calculateSMA(closes, 200);
            const bollinger = this.calculateBollingerBands(closes);

            const indicators: TechnicalIndicators = {
                rsi,
                macd,
                sma50,
                sma200,
                bollinger
            };

            // 4. AI Analysis (Augmented with ML)
            const aiAnalysis = await this.getAIAnalysis(symbol, currentPrice, indicators, mlResult);

            return {
                symbol: symbol.toUpperCase(),
                currentPrice,
                history: prices.slice(-180), // Return last 180 days for chart
                indicators,
                aiAnalysis
            };

        } catch (err: any) {
            this.fastify.log.error(err);
            throw new Error(`Prediction failed for ${symbol}: ${err.message}`);
        }
    }

    private async runPythonScript(scriptPath: string, data: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            // Use python3 to ensure compatibility in Docker environment
            const pythonProcess = spawn('python3', [scriptPath]);

            let resultString = '';
            let errorString = '';

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
                    // Extract JSON from stdout (in case of extra prints)
                    const lines = resultString.trim().split('\n');
                    const jsonLine = lines[lines.length - 1];
                    const json = JSON.parse(jsonLine);

                    if (json.error) return reject(new Error(json.error));
                    resolve(json);
                } catch (e) {
                    reject(new Error(`Failed to parse Python output. Raw: ${resultString} | Error: ${e}`));
                }
            });

            // Send data to stdin
            pythonProcess.stdin.write(JSON.stringify(data));
            pythonProcess.stdin.end();
        });
    }

    private async getAIAnalysis(symbol: string, price: number, indicators: TechnicalIndicators, mlResult: any) {
        const prompt = `
        Analyze this stock combining Technical Analysis and Machine Learning predictions.
        
        ASSET: ${symbol} at $${price.toFixed(2)}

        1. MACHINE LEARNING MODEL (Random Forest Simulation):
        - Probability of Up-trend: ${(mlResult.prediction_probability_up * 100).toFixed(1)}%
        - Model Sentiment: ${mlResult.sentiment}
        - Key Drivers: RSI=${mlResult.features.rsi.toFixed(1)}, Recent Trend=${mlResult.features.trend_5.toFixed(3)}
        
        2. TECHNICAL INDICATORS:
        - RSI (14): ${indicators.rsi.toFixed(2)}
        - MACD: ${indicators.macd.macd.toFixed(2)} (Signal: ${indicators.macd.signal.toFixed(2)})
        - SMA 50: $${indicators.sma50.toFixed(2)}
        - SMA 200: $${indicators.sma200.toFixed(2)}
        - Trend: Price is ${price > indicators.sma200 ? 'above' : 'below'} SMA200 (Long term) and ${price > indicators.sma50 ? 'above' : 'below'} SMA50 (Medium term).

        TASK: Provide a final trading verdict (Buy/Sell/Hold) and synthesis.
        - Weigh the ML probability heavily but verify with technicals.
        - If ML is bullish (>55%) and Price > SMA200, it's a strong signal.
        - If conflict (ML Bullish but Price < SMA200), suggest caution or 'Hold'.
        
        Format: JSON { "verdict": "Buy" | "Sell" | "Hold", "reasoning": "..." }
        `;

        return (this.aiService as any).askAI(prompt);
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
