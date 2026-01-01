"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const yahoo_finance2_1 = __importDefault(require("yahoo-finance2"));
async function test() {
    const yahooFinance = new yahoo_finance2_1.default({
        // @ts-ignore
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    try {
        const result = await yahooFinance.options('AAPL');
        console.log('Successfully fetched options for AAPL');
        console.log('Number of entries in chain:', result.options.length);
        if (result.options[0]) {
            console.log('First expiration:', result.options[0].expirationDate);
        }
    }
    catch (err) {
        console.error('Failed to fetch options:', err);
    }
}
test();
//# sourceMappingURL=test-options.js.map