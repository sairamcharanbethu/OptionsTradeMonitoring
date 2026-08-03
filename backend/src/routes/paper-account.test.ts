import { paperAccountRoutes } from './paper-account';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function replyMock() {
  return {
    statusCode: 200,
    payload: null as any,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload: any) {
      this.payload = payload;
      return payload;
    }
  };
}

async function runTests() {
  console.log('Running paper account route tests...');
  const postHandlers: Record<string, (request: any, reply: any) => Promise<any>> = {};
  let closeRequest: { positionId: number; userId: number | null } | null = null;
  const fastify = {
    authenticate: async () => {},
    addHook: () => {},
    get: () => {},
    post: (path: string, handler: (request: any, reply: any) => Promise<any>) => {
      postHandlers[path] = handler;
    },
    paperTrading: {
      closeOpenPosition: async (positionId: number, userId: number | null) => {
        closeRequest = { positionId, userId };
        return { positionId, status: 'CLOSED', intent: 'MANUAL_EXIT' };
      }
    }
  } as any;
  await paperAccountRoutes(fastify);
  const closeHandler = postHandlers['/positions/:positionId/close'];
  assert(Boolean(closeHandler), 'manual paper close route must be registered');

  const forbiddenReply = replyMock();
  await closeHandler({ user: { id: 3, role: 'USER' }, params: { positionId: '91' } }, forbiddenReply);
  assert(forbiddenReply.statusCode === 403, 'non-admin users must not close the shared paper position');
  assert(closeRequest === null, 'an unauthorized close must not reach the paper ledger service');

  const invalidReply = replyMock();
  await closeHandler({ user: { id: 7, role: 'ADMIN' }, params: { positionId: 'invalid' } }, invalidReply);
  assert(invalidReply.statusCode === 400, 'invalid position ids must be rejected at the route boundary');
  assert(closeRequest === null, 'an invalid close must not reach the paper ledger service');

  const acceptedReply = replyMock();
  const result = await closeHandler({ user: { id: 7, role: 'ADMIN' }, params: { positionId: '91' } }, acceptedReply);
  const acceptedClose = closeRequest as { positionId: number; userId: number | null } | null;
  assert(Boolean(acceptedClose), 'admin close must reach the paper ledger service');
  if (!acceptedClose) throw new Error('Admin close request was not captured');
  assert(acceptedClose.positionId === 91 && acceptedClose.userId === 7, 'admin close must pass the exact position and actor ids');
  assert(result.status === 'CLOSED' && result.intent === 'MANUAL_EXIT', 'admin close must return the ledger result');
  console.log('All paper account route tests passed!');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
