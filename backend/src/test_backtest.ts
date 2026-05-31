import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// Replicating the FIXED backtester logic
function calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;
    const changes = [];
    for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period; i < changes.length; i++) {
        const gain = changes[i] > 0 ? changes[i] : 0;
        const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

async function test() {
    const symbol = 'SPY';
    const startDateStr = '2026-05-01';
    const endDateStr = '2026-05-30';

    const start = new Date(startDateStr);
    const dailyBars: any = await yahooFinance.historical(symbol, {
        period1: new Date(start.getTime() - 250 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        period2: endDateStr,
        interval: '1d'
    });

    const chartData: any = await yahooFinance.chart(symbol, {
        period1: startDateStr,
        period2: endDateStr,
        interval: '15m'
    });
    const quotes = chartData.quotes;

    const dailyQuotesMap: Map<string, any[]> = new Map();
    for (const q of quotes) {
        if (!q.date || q.open === null || q.close === null) continue;
        const dateStr = q.date instanceof Date ? q.date.toISOString().split('T')[0] : new Date(q.date).toISOString().split('T')[0];
        const existing = dailyQuotesMap.get(dateStr) || [];
        existing.push(q);
        dailyQuotesMap.set(dateStr, existing);
    }
    const tradingDays = Array.from(dailyQuotesMap.keys()).sort();

    let totalEntries = 0;

    for (const dateStr of tradingDays) {
        const dayQuotes = dailyQuotesMap.get(dateStr)!;
        if (dayQuotes.length < 5) continue;

        const dayIdx = dailyBars.findIndex((b: any) => {
            const bDateStr = b.date instanceof Date ? b.date.toISOString().split('T')[0] : new Date(b.date).toISOString().split('T')[0];
            return bDateStr === dateStr;
        });
        if (dayIdx < 50) continue;

        const closesSlice = dailyBars.slice(0, dayIdx + 1).map((b: any) => b.close);
        const spotPrice = closesSlice[closesSlice.length - 1];
        const ema9 = calculateEMA(closesSlice, 9);
        const ema21 = calculateEMA(closesSlice, 21);
        const sma50 = calculateSMA(closesSlice, 50);
        const sma200 = calculateSMA(closesSlice, 200);
        const rsi = calculateRSI(closesSlice, 14);

        // NEW FIXED LOGIC
        const isBullishTrend = spotPrice > sma50;
        const isStrongTrend = spotPrice > sma200;
        const trendStrength = Math.abs(ema9 - ema21) / spotPrice * 100;
        const isPositiveGex = isStrongTrend && trendStrength < 0.5;
        const gammaFlip = sma50;
        const callWall = spotPrice * 1.015;
        const putWall = spotPrice * 0.985;

        let dayEntries = 0;

        for (let i = 0; i < dayQuotes.length; i++) {
            if (dayEntries >= 2) break;
            const quote = dayQuotes[i];
            const quoteTime = new Date(quote.date);
            const etHour = quoteTime.getUTCHours() - 4;
            const etMinute = quoteTime.getUTCMinutes();
            const etTimeMinutes = etHour * 60 + etMinute;
            const isCheckpoint = (etTimeMinutes >= 585 && etTimeMinutes <= 600) || (etTimeMinutes >= 810 && etTimeMinutes <= 825);
            if (!isCheckpoint) continue;

            const emaCrossBullish = ema9 > ema21;
            const emaCrossBearish = ema9 < ema21;

            let verdict = 'WAIT';
            let reason = '';

            if (isPositiveGex) {
                if (quote.close <= putWall * 1.005 && rsi < 45) {
                    verdict = 'BUY_CALL';
                    reason = `Pos GEX: near put wall`;
                } else if (quote.close >= callWall * 0.995 && rsi > 55) {
                    verdict = 'BUY_PUT';
                    reason = `Pos GEX: near call wall`;
                }
            } else {
                if (emaCrossBullish && rsi > 50 && quote.close > gammaFlip) {
                    verdict = 'BUY_CALL';
                    reason = `Neg GEX: EMA bull + above gamma flip`;
                } else if (emaCrossBearish && rsi < 50 && quote.close < gammaFlip) {
                    verdict = 'BUY_PUT';
                    reason = `Neg GEX: EMA bear + below gamma flip`;
                } else if (emaCrossBullish && rsi > 45 && isBullishTrend) {
                    verdict = 'BUY_CALL';
                    reason = `Trending bull: EMA9>EMA21 + above SMA50`;
                } else if (emaCrossBearish && rsi < 55 && !isBullishTrend) {
                    verdict = 'BUY_PUT';
                    reason = `Trending bear: EMA9<EMA21 + below SMA50`;
                }
            }

            if (verdict !== 'WAIT') {
                dayEntries++;
                totalEntries++;
                console.log(`✅ ${dateStr} ET=${etHour}:${etMinute.toString().padStart(2,'0')} | ${verdict} | ${reason} | gex=${isPositiveGex ? 'POS' : 'NEG'} trend=${trendStrength.toFixed(2)}%`);
            }
        }
    }

    console.log(`\n=== RESULT: ${totalEntries} trades generated across ${tradingDays.length} trading days ===`);
}

test();
