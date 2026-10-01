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
  let closeRequest: { positionId: number; userId: number | null; force: boolean } | null = null;
  let rejectFreshQuote = false;
  let failUnexpectedly = false;
  const fastify = {
    authenticate: async () => {},
    addHook: () => {},
    get: () => {},
    post: (path: string, handler: (request: any, reply: any) => Promise<any>) => {
      postHandlers[path] = handler;
    },
    paperTrading: {
      setAutomationStatus: async (status: string, lane?: string) => {
        if (lane === 'NOPE') { const error: any = new Error('Paper automation control for lane NOPE is unavailable'); error.statusCode = 404; throw error; }
        return { strategy_name: lane || 'DAY_TRADING', automation_status: status };
      },
      closeOpenPosition: async (positionId: number, userId: number | null, force: boolean) => {
        closeRequest = { positionId, userId, force };
        if (failUnexpectedly) {
          const error: any = new Error('insert or update violates a foreign key');
          error.code = '23503';
          error.constraint = 'paper_orders_decision_id_fkey';
          error.paperCloseStage = 'INSERT_EXIT_ORDER';
          throw error;
        }
        if (rejectFreshQuote && !force) {
          const error: any = new Error('Manual paper close requires a fresh quote');
          error.statusCode = 409;
          error.code = 'PAPER_FRESH_QUOTE_REQUIRED';
          throw error;
        }
        return { positionId, status: 'CLOSED', intent: force ? 'MANUAL_FORCE_EXIT' : 'MANUAL_EXIT' };
      }
    },
    log: { error() {} }
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
  const result = await closeHandler({ user: { id: 7, role: 'ADMIN' }, params: { positionId: '91' }, body: {} }, acceptedReply);
  const acceptedClose = closeRequest as { positionId: number; userId: number | null; force: boolean } | null;
  assert(Boolean(acceptedClose), 'admin close must reach the paper ledger service');
  if (!acceptedClose) throw new Error('Admin close request was not captured');
  assert(acceptedClose.positionId === 91 && acceptedClose.userId === 7 && acceptedClose.force === false, 'admin close must pass the exact position and actor ids');
  assert(result.status === 'CLOSED' && result.intent === 'MANUAL_EXIT', 'admin close must return the ledger result');

  rejectFreshQuote = true;
  const staleReply = replyMock();
  const staleResult = await closeHandler({ user: { id: 7, role: 'ADMIN' }, params: { positionId: '91' }, body: {} }, staleReply);
  assert(staleReply.statusCode === 409, 'a stale quote must preserve its response status');
  assert(staleResult.code === 'PAPER_FRESH_QUOTE_REQUIRED', 'a stale quote response must advertise the force-close path');

  closeRequest = null;
  const forcedResult = await closeHandler({ user: { id: 7, role: 'ADMIN' }, params: { positionId: '91' }, body: { force: true } }, replyMock());
  const forcedClose = closeRequest as { positionId: number; userId: number | null; force: boolean } | null;
  assert(Boolean(forcedClose?.force), 'an explicit force flag must reach the paper ledger service');
  assert(forcedResult.intent === 'MANUAL_FORCE_EXIT', 'the force route must return the forced ledger result');

  rejectFreshQuote = false;
  failUnexpectedly = true;
  const failedReply = replyMock();
  const failedResult = await closeHandler({ user: { id: 7, role: 'ADMIN' }, params: { positionId: '91' }, body: {} }, failedReply);
  assert(failedReply.statusCode === 500, 'an unexpected ledger failure must remain a server error');
  assert(failedResult.code === 'PAPER_CLOSE_FAILED', 'an unexpected close failure must return an actionable application code');
  assert(/Refresh the paper account/.test(failedResult.error), 'an uncertain close must tell the user to refresh before retrying');
  assert(failedResult.diagnostic.stage === 'INSERT_EXIT_ORDER', 'an unexpected close failure must disclose its safe transaction stage');
  assert(failedResult.diagnostic.databaseCode === '23503', 'an unexpected close failure must disclose its PostgreSQL error class');
  assert(failedResult.diagnostic.constraint === 'paper_orders_decision_id_fkey', 'an unexpected close failure must disclose its constraint without exposing SQL');
  // Per-lane automation toggle.
  const laneHandler = postHandlers['/lanes/:lane/:action'];
  assert(typeof laneHandler === 'function', 'The per-lane toggle route is registered');
  const paused = replyMock();
  const pausedResult = await laneHandler({ user: { role: 'ADMIN', id: 1 }, params: { lane: 'SWING_NOAI', action: 'pause' } }, paused);
  assert(pausedResult.strategy_name === 'SWING_NOAI' && pausedResult.automation_status === 'PAUSED', 'Pausing a variant lane targets that lane');
  const resumed = replyMock();
  const resumedResult = await laneHandler({ user: { role: 'ADMIN', id: 1 }, params: { lane: 'SWING', action: 'resume' } }, resumed);
  assert(resumedResult.automation_status === 'ACTIVE', 'Resuming sets ACTIVE');
  const badAction = replyMock();
  await laneHandler({ user: { role: 'ADMIN', id: 1 }, params: { lane: 'SWING', action: 'stop' } }, badAction);
  assert(badAction.statusCode === 400, 'Unknown actions are rejected');
  const unknownLane = replyMock();
  await laneHandler({ user: { role: 'ADMIN', id: 1 }, params: { lane: 'NOPE', action: 'pause' } }, unknownLane);
  assert(unknownLane.statusCode === 404, 'An unknown lane is a 404, not a 500');
  const nonAdmin = replyMock();
  await laneHandler({ user: { role: 'USER', id: 2 }, params: { lane: 'SWING', action: 'pause' } }, nonAdmin);
  assert(nonAdmin.statusCode === 403, 'Non-admins cannot toggle lanes');

  console.log('All paper account route tests passed!');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
