/**
 * Manual ZeroGEX replay archive. Run inside the backend container (it has the
 * settings DB and the API key):
 *
 *   npx ts-node src/scripts/archive-zerogex-replay.ts            # archive every retained session not yet stored
 *   npx ts-node src/scripts/archive-zerogex-replay.ts --force    # re-fetch all retained sessions
 *   npx ts-node src/scripts/archive-zerogex-replay.ts --status   # list archived sessions
 *
 * Uses DATABASE_URL and (settings.zerogex_api_key || ZEROGEX_API_KEY).
 */
import { Pool } from 'pg';
import { ZeroGexArchiveService } from '../services/zerogex-archive-service';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const fastify: any = { pg: pool, log: { info: console.log, warn: console.warn, error: console.error } };
  await ZeroGexArchiveService.ensureSchema(pool);
  const service = new ZeroGexArchiveService(fastify);
  const args = new Set(process.argv.slice(2));
  if (args.has('--status')) {
    console.log(JSON.stringify(await service.status(), null, 2));
  } else {
    const summary = await service.backfill({ force: args.has('--force') });
    console.log(JSON.stringify(summary, null, 2));
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
