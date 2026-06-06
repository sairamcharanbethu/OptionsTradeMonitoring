import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });

async function test() {
    try {
        console.log("Testing yahoo-finance2 v3 options fetch for SPY...\n");
        const chain: any = await yahooFinance.options('SPY');
        
        // v3 returns flat OptionsResult: { quote, options[], expirationDates[], strikes[] }
        console.log("Top-level Keys:", Object.keys(chain));
        console.log("underlyingSymbol:", chain.underlyingSymbol);
        console.log("expirationDates count:", chain.expirationDates?.length);
        console.log("strikes count:", chain.strikes?.length);
        console.log("hasMiniOptions:", chain.hasMiniOptions);
        console.log("quote.regularMarketPrice:", chain.quote?.regularMarketPrice);
        console.log("options array length:", chain.options?.length);

        if (chain.options && chain.options.length > 0) {
            const front = chain.options[0];
            console.log("\n--- Front Expiry ---");
            console.log("expirationDate:", front.expirationDate);
            console.log("calls count:", front.calls?.length);
            console.log("puts count:", front.puts?.length);

            if (front.calls?.length > 0) {
                const sample = front.calls[0];
                console.log("\nSample Call:", JSON.stringify(sample, null, 2));
            }
        }
    } catch (e: any) {
        console.error("Options fetch FAILED:", e.message);
    }
}

test();
