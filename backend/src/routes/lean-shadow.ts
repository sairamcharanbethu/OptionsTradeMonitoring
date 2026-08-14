import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const SnapshotSchema = z.object({
  runId: z.string().min(8).max(128),
  revision: z.string().min(7).max(128),
  sequence: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  signals: z.record(z.string(), z.record(z.string(), z.any())),
  health: z.record(z.string(), z.any())
});

export async function leanShadowRoutes(fastify: FastifyInstance) {
  fastify.post('/internal/lean-shadow/snapshots', async (request, reply) => {
    const parsed = SnapshotSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid LEAN shadow snapshot', details: parsed.error.issues });
    try {
      const leanShadow = (fastify as any).leanShadow;
      await leanShadow.authenticate(request.headers as any, parsed.data);
      return await leanShadow.ingestSnapshot(parsed.data);
    } catch (error: any) {
      return reply.code(error.statusCode || 500).send({ error: error.message || 'LEAN shadow ingest failed' });
    }
  });

  fastify.get('/lean-shadow', { preHandler: (fastify as any).authenticate }, async () => {
    return (fastify as any).leanShadow.getHealth();
  });
}
