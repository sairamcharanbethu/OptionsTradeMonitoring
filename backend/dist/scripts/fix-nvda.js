"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = __importDefault(require("pg"));
const { Pool } = pg_1.default;
const pool = new Pool({
    connectionString: 'postgres://user:password@localhost:5432/options_monitoring',
});
async function fix() {
    const client = await pool.connect();
    try {
        console.log('Fixing NVDA expiration date...');
        await client.query(`UPDATE positions SET expiration_date = '2026-03-20' WHERE symbol = 'NVDA'`);
        console.log('Update complete.');
    }
    catch (err) {
        console.error(err);
    }
    finally {
        client.release();
        pool.end();
    }
}
fix();
//# sourceMappingURL=fix-nvda.js.map