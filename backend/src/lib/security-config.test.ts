import { AUTH_RATE_LIMIT, DEFAULT_ALLOWED_ORIGINS, GLOBAL_RATE_LIMIT, apiDocsEnabled, makeCorsOriginCheck, parseAllowedOrigins, resolveJwtExpiresIn } from './security-config';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function allows(check: ReturnType<typeof makeCorsOriginCheck>, origin: string | undefined): boolean {
  let result: boolean | undefined;
  check(origin, (_err, allow) => { result = Boolean(allow); });
  return Boolean(result);
}

async function runTests() {
  console.log('Running security config tests...');
  assert(JSON.stringify(parseAllowedOrigins(undefined)) === JSON.stringify(DEFAULT_ALLOWED_ORIGINS), 'Blank env falls back to the defaults');
  assert(JSON.stringify(parseAllowedOrigins(' https://a.example/ , http://b.example:8080,garbage,,')) === JSON.stringify(['https://a.example', 'http://b.example:8080']), 'Origins are trimmed, de-slashed and garbage dropped');
  assert(parseAllowedOrigins('https://a.example,https://a.example').length === 1, 'Duplicates collapse');

  const check = makeCorsOriginCheck(['https://options.ssmedia.ca']);
  assert(allows(check, undefined), 'No-origin requests (curl, server-to-server) are allowed');
  assert(allows(check, 'https://options.ssmedia.ca'), 'Allowlisted origin passes');
  assert(allows(check, 'https://OPTIONS.ssmedia.ca/'), 'Origin match is case-insensitive and ignores a trailing slash');
  assert(!allows(check, 'https://evil.example'), 'Unknown origin is refused');

  assert(resolveJwtExpiresIn(undefined) === '12h', 'JWT lifetime defaults to 12h');
  assert(resolveJwtExpiresIn('30m') === '30m' && resolveJwtExpiresIn('3600') === '3600', 'Valid lifetimes pass through');
  assert(resolveJwtExpiresIn('forever') === '12h', 'Garbage lifetime falls back to 12h');

  assert(apiDocsEnabled({ NODE_ENV: 'development' } as any) === true, 'Docs on in development');
  assert(apiDocsEnabled({ NODE_ENV: 'production' } as any) === false, 'Docs off in production by default');
  assert(apiDocsEnabled({ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' } as any) === true, 'Docs can be forced on');

  assert(GLOBAL_RATE_LIMIT.max === 300 && AUTH_RATE_LIMIT.max === 10, 'Rate-limit ceilings are the documented values');
  assert(AUTH_RATE_LIMIT.keyGenerator({ ip: '1.2.3.4', body: { username: ' Sai ' } }) === '1.2.3.4:sai', 'Auth limiter keys by IP and normalised username');
  assert(AUTH_RATE_LIMIT.keyGenerator({ ip: '1.2.3.4', body: {} }) === '1.2.3.4:', 'Auth limiter tolerates a missing username');
  console.log('All security config tests passed!');
}

runTests().catch((err) => { console.error(err); process.exit(1); });
