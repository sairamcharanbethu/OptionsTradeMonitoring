/**
 * Central place for the HTTP hardening knobs so index.ts stays declarative and
 * the parsing is unit-testable.
 *
 *   CORS_ALLOWED_ORIGINS  comma-separated origins; default = production site + Vite dev.
 *   JWT_EXPIRES_IN        token lifetime accepted by @fastify/jwt (default 12h).
 *   ENABLE_API_DOCS       'true' serves Swagger UI even in production.
 */

export const DEFAULT_ALLOWED_ORIGINS = ['https://options.ssmedia.ca', 'http://localhost:5173'];

export function parseAllowedOrigins(raw: string | undefined | null, fallback: string[] = DEFAULT_ALLOWED_ORIGINS): string[] {
  const entries = String(raw ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => /^https?:\/\/[^\s/]+$/i.test(value));
  return entries.length > 0 ? Array.from(new Set(entries)) : [...fallback];
}

/** CORS origin callback: allow same-host/no-origin requests (curl, server-to-server) and the allowlist. */
export function makeCorsOriginCheck(allowed: string[]) {
  const set = new Set(allowed.map((value) => value.toLowerCase()));
  // Callback shape matches @fastify/cors OriginFunction (second arg is the allowed origin value).
  type OriginValue = boolean | string | RegExp | Array<boolean | string | RegExp>;
  return (origin: string | undefined, callback: (err: Error | null, allow: OriginValue) => void) => {
    if (!origin) return callback(null, true);
    callback(null, set.has(origin.replace(/\/+$/, '').toLowerCase()));
  };
}

export function resolveJwtExpiresIn(raw: string | undefined | null, fallback = '12h'): string {
  const value = String(raw ?? '').trim();
  // @fastify/jwt accepts a number of seconds or an ms-style string ("12h", "30m", "7d").
  return /^(\d+|\d+(\.\d+)?\s*(ms|s|m|h|d|w|y))$/i.test(value) ? value : fallback;
}

export function apiDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.ENABLE_API_DOCS || '').trim().toLowerCase() === 'true') return true;
  return env.NODE_ENV !== 'production';
}

/** Global ceiling per client IP; generous because the SPA polls several endpoints. */
export const GLOBAL_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

/** Credential endpoints: keyed by IP + submitted username so one IP cannot spray many accounts. */
export const AUTH_RATE_LIMIT = {
  max: 10,
  timeWindow: '15 minutes',
  keyGenerator: (request: { ip?: string; body?: any }) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
    return `${request.ip || 'unknown'}:${username}`;
  }
} as const;

/** WebSocket clients only ever send a token and small commands. */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
