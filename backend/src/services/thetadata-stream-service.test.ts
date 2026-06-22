import { ThetaDataStreamService } from './thetadata-stream-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
}

async function testMissingStreamUrlDisablesThetaDataStream() {
  const service = new ThetaDataStreamService(createFastifyMock()) as any;

  assert(service.normalizeStreamUrl('', '') === '', 'Blank stream URL should stay disabled');
  assert(service.normalizeStreamUrl('ws://127.0.0.1:25520/v1/events', '') === 'ws://127.0.0.1:25520/v1/events', 'ThetaData v3 local stream URL should be enabled');
  assert(service.normalizeStreamUrl('ws://localhost:25520/v1/events', '') === 'ws://localhost:25520/v1/events', 'ThetaData v3 localhost stream URL should be enabled');
  assert(service.normalizeStreamUrl('ws://127.0.0.1:25510/v1/events', '') === '', 'Old local HTTP port must not be used as stream URL');
  assert(service.normalizeStreamUrl('ws://thetadata:25520/v1/events', '') === '', 'Old sidecar stream URL should not be used in integrated backend mode');
  assert(service.normalizeStreamUrl('ws://example.internal:25503/v3/stream', '') === 'ws://example.internal:25503/v3/stream', 'Explicit non-stale stream URL should be preserved');
}

async function runTests() {
  console.log('Running ThetaDataStreamService tests...');
  await testMissingStreamUrlDisablesThetaDataStream();
  console.log('All ThetaDataStreamService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
