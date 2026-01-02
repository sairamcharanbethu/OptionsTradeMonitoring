"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fetch_1 = __importDefault(require("node-fetch"));
async function verifyForcePoll() {
    try {
        console.log('Triggering Force Poll...');
        const response = await (0, node_fetch_1.default)('http://localhost:3001/api/market/force-poll', {
            method: 'POST'
        });
        if (response.ok) {
            const data = await response.json();
            console.log('Success:', data);
        }
        else {
            console.error('Failed:', response.status, response.statusText);
            const text = await response.text();
            console.error('Response:', text);
        }
    }
    catch (error) {
        console.error('Error:', error);
    }
}
verifyForcePoll();
//# sourceMappingURL=verify-force-poll.js.map