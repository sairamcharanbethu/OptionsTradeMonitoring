import assert from 'node:assert/strict';
import { wallReactionRoutes } from './wall-reaction';

function reply() {
  return { statusCode: 200, payload: null as any, code(value: number) { this.statusCode = value; return this; }, send(value: any) { this.payload = value; return value; } };
}

async function run() {
  const post: Record<string, Function> = {};
  const calls: string[] = [];
  const fastify: any = {
    authenticate: async () => {}, addHook: () => {}, get: () => {}, post: (path: string, handler: Function) => { post[path] = handler; },
    wallReactionPaper: {
      arm: async (id: string) => { calls.push(`arm:${id}`); return { status: 'ARMED' }; },
      setAutomationStatus: async (status: string) => { calls.push(`status:${status}`); return { automation_status: status }; },
      closePosition: async (id: number) => { calls.push(`close:${id}`); return { status: 'CLOSED' }; }
    }
  };
  await wallReactionRoutes(fastify);
  const forbidden = reply();
  await post['/candidates/:candidateId/arm']({ user: { role: 'USER' }, params: { candidateId: 'abc' } }, forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(calls, []);
  const accepted = await post['/candidates/:candidateId/arm']({ user: { id: 7, role: 'ADMIN' }, params: { candidateId: 'abc' } }, reply());
  assert.equal(accepted.status, 'ARMED');
  assert.deepEqual(calls, ['arm:abc']);
  const invalid = reply();
  await post['/paper-account/positions/:positionId/close']({ user: { role: 'ADMIN' }, params: { positionId: 'nope' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(calls, ['arm:abc']);
  console.log('All WallReaction route tests passed!');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
