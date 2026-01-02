"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = __importDefault(require("pg"));
const { Pool } = pg_1.default;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring',
});
async function migrate() {
    const client = await pool.connect();
    try {
        console.log('Running Greeks migration...');
        const queries = [
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS delta DECIMAL(10, 4);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS theta DECIMAL(10, 4);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS gamma DECIMAL(10, 4);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS vega DECIMAL(10, 4);`,
            `ALTER TABLE positions ADD COLUMN IF NOT EXISTS iv DECIMAL(10, 4);`
        ];
        for (const query of queries) {
            await client.query(query);
            console.log(`Executed: ${query}`);
        }
        console.log('Migration complete.');
    }
    catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
    finally {
        client.release();
        await pool.end();
    }
}
migrate();
//# sourceMappingURL=migrate-greeks.js.map