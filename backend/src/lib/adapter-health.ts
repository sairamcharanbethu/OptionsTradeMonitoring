export type AdapterHealth = {
  status: string;
  latencyMs: number | null;
  lastGoodAt: string | null;
  lastError: string | null;
  freshnessMs: number | null;
  degradedReason: string | null;
  source: string;
};

const HEALTHY_STATUSES = new Set(['UP', 'RUNNING', 'SCANNING', 'CONNECTED', 'OK']);
const INFORMATIONAL_STATUSES = new Set(['N/A', 'DISABLED', 'IDLE', 'MARKET_CLOSED']);

export function normalizeAdapterHealth(source: string, health: Record<string, any>, checkedAt = new Date().toISOString()): AdapterHealth & Record<string, any> {
  const status = String(health.status || 'N/A').toUpperCase();
  const lastError = health.lastError ? String(health.lastError) : null;
  const lastGoodAt = health.lastGoodAt
    || health.lastMessageAt
    || health.lastMatchedAt
    || health.lastQuoteAt
    || health.lastRunAt
    || health.checkedAt
    || (HEALTHY_STATUSES.has(status) ? checkedAt : null);
  const freshnessMs = health.freshnessMs ?? ageMs(lastGoodAt, checkedAt);
  const degradedReason = health.degradedReason
    || lastError
    || (HEALTHY_STATUSES.has(status) || INFORMATIONAL_STATUSES.has(status) ? null : `${source} status is ${status}`);

  return {
    ...health,
    status,
    latencyMs: finiteNumberOrNull(health.latencyMs),
    lastGoodAt,
    lastError,
    freshnessMs,
    degradedReason,
    source
  };
}

function ageMs(timestamp: string | null, checkedAt: string): number | null {
  if (!timestamp) return null;
  const start = new Date(timestamp).getTime();
  const end = new Date(checkedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function finiteNumberOrNull(value: any): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
