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
async function inspect() {
    const client = await pool.connect();
    try {
        const res = await client.query(`SELECT * FROM positions WHERE status = 'OPEN' LIMIT 1`);
        console.log(JSON.stringify(res.rows[0], null, 2));
    }
    catch (err) {
        console.error(err);
    }
    finally {
        client.release();
        pool.end();
    }
}
inspect();
//# sourceMappingURL=inspect-position.js.map