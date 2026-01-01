"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const API_URL = 'http://localhost:3000/api/market-data/update-price';
async function simulate(symbol, startPrice) {
    console.log(`--- Starting Simulation for ${symbol} ---`);
    const prices = [
        startPrice,
        startPrice + 5, // Peak starting
        startPrice + 10, // New High
        startPrice + 15, // Top Peak
        startPrice + 12, // Initial drop
        startPrice + 8, // Triggering stop loss (if 10% from 115 = 103.5)
    ];
    for (const price of prices) {
        console.log(`\nUpdating ${symbol} to $${price}...`);
        try {
            const res = await axios_1.default.post(API_URL, { symbol, price });
            console.log('Result:', res.data);
        }
        catch (err) {
            console.error('Error:', err.response?.data || err.message);
        }
        // Small delay to simulate time passing
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log('\n--- Simulation Complete ---');
}
// Example usage: npm run simulate -- TSLA 100
const args = process.argv.slice(2);
const symbol = args[0] || 'AAPL';
const start = Number(args[1]) || 150;
simulate(symbol, start);
//# sourceMappingURL=simulate-prices.js.map