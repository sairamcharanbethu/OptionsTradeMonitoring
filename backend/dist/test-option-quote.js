"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const yahoo_finance2_1 = __importDefault(require("yahoo-finance2"));
async function test() {
    const yahooFinance = new yahoo_finance2_1.default();
    try {
        // AAPL 170 Call for Jan 17, 2025 (Ticker format might vary)
        // Yahoo format often: AAPL250117C00170000
        const result = await yahooFinance.quote('AAPL250117C00170000');
        console.log('Successfully fetched quote for option contract');
        console.log('Price:', result.regularMarketPrice);
    }
    catch (err) {
        console.error('Failed to fetch quote:', err.message);
    }
}
test();
//# sourceMappingURL=test-option-quote.js.map