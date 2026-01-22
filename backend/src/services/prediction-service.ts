
import yahooFinance from 'yahoo-finance2';
import { FastifyInstance } from 'fastify';
import { AIService } from './ai-service';

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
            // 1. Fetch Historical Data (Last 200 days needed for SMA200 + buffer)
            const queryOptions = { period1: '2023-01-01', interval: '1d' as const }; // Simple start date, or we calc 300 days ago

            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 400); // Fetch ~1 year+ to be safe for 200 SMA

            const result = await yahooFinance.historical(symbol, {
                period1: startDate,
                interval: '1d'
            });

            if (!result || !Array.isArray(result) || (result as any[]).length < 200) {
                throw new Error(`Insufficient data for ${symbol}. Need at least 200 days of history.`);
            }

            // Sort by date ascending just in case
            const prices = (result as any[]).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

            const closes = prices.map(p => p.close);
            const currentPrice = closes[closes.length - 1];

            // 2. Calculate Indicators
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

            // 3. AI Analysis
            const aiAnalysis = await this.getAIAnalysis(symbol, currentPrice, indicators);

            return {
                symbol: symbol.toUpperCase(),
                currentPrice,
                history: prices.slice(-180).map(p => ({
                    date: p.date.toISOString().split('T')[0],
                    close: p.close
                })), // Return last 180 days for chart
                indicators,
                aiAnalysis
            };

        } catch (err: any) {
            this.fastify.log.error(err);
            throw new Error(`Prediction failed for ${symbol}: ${err.message}`);
        }
    }

    private async getAIAnalysis(symbol: string, price: number, indicators: TechnicalIndicators) {
        const prompt = `
        Analyze this stock based on technical indicators:
        Symbol: ${symbol}
        Price: $${price.toFixed(2)}
        
        Indicators:
        - RSI (14): ${indicators.rsi.toFixed(2)} (Overbought > 70, Oversold < 30)
        - MACD: Line ${indicators.macd.macd.toFixed(2)}, Signal ${indicators.macd.signal.toFixed(2)} (Diff: ${indicators.macd.histogram.toFixed(2)})
        - SMA 50: $${indicators.sma50.toFixed(2)}
        - SMA 200: $${indicators.sma200.toFixed(2)}
        - Bollinger Bands: Upper $${indicators.bollinger.upper.toFixed(2)}, Lower $${indicators.bollinger.lower.toFixed(2)}

        Trend Context:
        - Price vs SMA50: ${price > indicators.sma50 ? 'Above (Bullish)' : 'Below (Bearish)'}
        - Price vs SMA200: ${price > indicators.sma200 ? 'Above (Bullish)' : 'Below (Bearish)'}
        - SMA50 vs SMA200: ${indicators.sma50 > indicators.sma200 ? 'Golden Cross zone' : 'Death Cross zone'}

        Task: Provide a trading verdict (Buy/Sell/Hold) and a concise reasoning paragraph explaining the technical setup.
        Format: JSON { "verdict": "Buy" | "Sell" | "Hold", "reasoning": "..." }
        `;

        // We can temporarily expose a public method or just cast to any to access the internal generation
        // Or better, add a generic 'analyze' method to AIService. 
        // For now, I'll reuse the private generateAnalysisInternal via a new public method or direct access if protected.
        // Looking at AIService, it has generateAnalysis but it expects specific options interface. 
        // I should probably add a generic method to AIService or just abuse the existing one with dummy data?
        // No, let's look at AIService again. It allows adding a generic method. 
        // Since I cannot modify AIService easily without context switch, I will try to extend it or assuming I can modify it.
        // Actually, I am writing this NEW file. I should modify AIService in the next step to support this, 
        // OR simply cast to any to call 'generateAnalysisInternal' if it was public/protected? 
        // It's private. 
        // I will MODIFY AIService in the next step to expose a generic `askAI(prompt: string)` method.
        // For now, I will assume `aiService.askAI(prompt)` exists.

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
