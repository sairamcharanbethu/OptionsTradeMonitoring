import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Database,
  RadioTower,
  RefreshCw,
  Router,
  Search,
  ServerCrash,
  ShieldCheck,
  Siren,
  Zap
} from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

type ApiHealth = Awaited<ReturnType<typeof api.getSignalsHealth>>;
type ServiceHealth = Awaited<ReturnType<typeof api.getServicesHealth>>;
type HealthSeverity = 'critical' | 'warning' | 'ok' | 'info';

type DiagnosticItem = {
  id: string;
  area: string;
  title: string;
  status?: string | null;
  severity: HealthSeverity;
  endpoint?: string | null;
  latencyMs?: number | null;
  freshnessMs?: number | null;
  lastSeen?: string | null;
  evidence?: unknown;
  cause: string;
  nextStep: string;
  actionCommand?: string | null;
};

const IGNORED_COMPONENTS_STORAGE_KEY = 'systemHealthIgnoredComponents';

const loadIgnoredComponents = () => {
  try {
    const raw = window.localStorage.getItem(IGNORED_COMPONENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set<string>(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set<string>();
  }
};

const saveIgnoredComponents = (ignored: Set<string>) => {
  try {
    window.localStorage.setItem(IGNORED_COMPONENTS_STORAGE_KEY, JSON.stringify(Array.from(ignored).sort()));
  } catch {
    // Browser storage is optional; the live health payload remains unchanged.
  }
};

const formatRelativeTime = (timestamp?: string | null) => {
  if (!timestamp) return 'No recent data';
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return 'Invalid timestamp';
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)}h ago`;
  return `${Math.round(diffSeconds / 86400)}d ago`;
};

const formatDurationMs = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
};

const statusTone = (status?: string | null) => {
  const normalized = String(status || '').toUpperCase();
  if (['UP', 'RUNNING', 'SCANNING', 'CONNECTED', 'OK'].includes(normalized)) return 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10';
  if (['DEGRADED', 'MARKET_CLOSED', 'IDLE', 'STOPPED'].includes(normalized)) return 'text-amber-500 border-amber-500/30 bg-amber-500/10';
  if (['N/A', 'DISABLED'].includes(normalized)) return 'text-muted-foreground border-border bg-muted/40';
  return 'text-red-500 border-red-500/30 bg-red-500/10';
};

const severityTone = (severity: HealthSeverity) => {
  if (severity === 'critical') return 'border-red-500/30 bg-red-500/10 text-red-500';
  if (severity === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-500';
  if (severity === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500';
  return 'border-border bg-muted/40 text-muted-foreground';
};

const severityForStatus = (status?: string | null): HealthSeverity => {
  const normalized = String(status || '').toUpperCase();
  if (['UP', 'RUNNING', 'SCANNING', 'CONNECTED', 'OK'].includes(normalized)) return 'ok';
  if (['N/A', 'DISABLED', 'IDLE', 'MARKET_CLOSED'].includes(normalized)) return 'info';
  if (['DEGRADED', 'STOPPED'].includes(normalized)) return 'warning';
  return 'critical';
};

const compactValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 'None';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const causeFromError = (fallback: string, error?: string | null) => {
  const lower = String(error || '').toLowerCase();
  if (!error) return fallback;
  if (lower.includes('not configured') || lower.includes('key') || lower.includes('password')) return 'Missing or invalid credentials/configuration.';
  if (lower.includes('timeout') || lower.includes('econn') || lower.includes('network')) return 'Network timeout or service unreachable.';
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) return 'Authentication or entitlement failure.';
  if (lower.includes('404')) return 'Endpoint path or upstream route mismatch.';
  if (lower.includes('429') || lower.includes('rate')) return 'Rate limit or upstream throttling.';
  if (lower.includes('subscription') || lower.includes('permission_denied')) return 'Data entitlement or subscription mismatch.';
  return fallback;
};

const isHealthyStatus = (status?: string | null) => {
  const normalized = String(status || '').toUpperCase();
  return ['UP', 'RUNNING', 'SCANNING', 'CONNECTED', 'OK'].includes(normalized);
};

const isInformationalStatus = (status?: string | null) => {
  const normalized = String(status || '').toUpperCase();
  return ['N/A', 'DISABLED', 'IDLE', 'MARKET_CLOSED'].includes(normalized);
};

const statusSummary = (status?: string | null, error?: string | null, fallback = 'Runtime status check.') => {
  if (error) return causeFromError(fallback, error);
  if (isHealthyStatus(status)) return 'Healthy. No active error reported.';
  if (isInformationalStatus(status)) return 'Inactive or optional in the current runtime state.';
  return fallback;
};

const adapterReason = (value: any, fallback: string) => value?.degradedReason || value?.lastError || fallback;
const adapterLastSeen = (value: any, fallback?: string | null) => value?.lastGoodAt || fallback || null;

const apiLabel = (name: string) => {
  const labels: Record<string, string> = {
    yahooFinance: 'Yahoo Finance',
    sscgexPortal: 'SSCGEX Portal',
    ibkr: 'IBKR Gateway',
    openRouter: 'OpenRouter AI',
    discord: 'Discord Webhook'
  };
  return labels[name] || name;
};

const buildDiagnostics = (apiHealth: ApiHealth | null, services: ServiceHealth | null): DiagnosticItem[] => {
  const items: DiagnosticItem[] = [];

  if (apiHealth) {
    Object.entries(apiHealth).forEach(([name, value]) => {
      const status = value?.status || 'N/A';
      const lastError = value?.lastError || null;
      items.push({
        id: `api:${name}`,
        area: 'External API',
        title: apiLabel(name),
        status,
        severity: severityForStatus(status),
        endpoint: value?.endpoint || null,
        latencyMs: value?.latencyMs ?? null,
        freshnessMs: value?.freshnessMs ?? null,
        lastSeen: adapterLastSeen(value, value?.checkedAt || null),
        evidence: value?.degradedReason || lastError,
        cause: statusSummary(status, adapterReason(value, lastError || ''), 'External dependency check needs attention.'),
        nextStep: isHealthyStatus(status)
          ? 'No action needed.'
          : status === 'N/A'
            ? 'Configure the service only if this dependency is required.'
            : 'Check credentials, entitlement, endpoint reachability, and upstream status.',
        actionCommand: name === 'openRouter'
          ? 'Check Settings -> AI model and OpenRouter key, then refresh this page.'
          : name === 'sscgexPortal'
            ? 'Check Settings -> SSCGEX password, then run a manual scan.'
            : null
      });
    });
  }

  if (services) {
    const scannerStatus = services.scanner?.status || 'N/A';
    const scannerWindow = services.scanner?.window;
    const scannerWindowLabel = scannerWindow
      ? `${scannerWindow.start}-${scannerWindow.cutoff} ${scannerWindow.timezone}`
      : 'configured trading window';
    const scannerCause = services.scanner?.lastSkippedReason
      ? 'Scanner is intentionally skipping or gated by schedule/settings.'
      : scannerStatus === 'SCANNING'
        ? `Scanner is enabled and inside ${scannerWindowLabel}. It is waiting for the next scheduled or manual scan cycle.`
        : scannerStatus === 'RUNNING'
          ? 'Scanner is actively processing a scan cycle right now.'
          : scannerStatus === 'MARKET_CLOSED'
            ? `Scanner is healthy but outside ${scannerWindowLabel}.`
            : scannerStatus === 'DISABLED'
              ? 'Scanner is disabled in Day Trading settings.'
              : 'Scanner runtime state.';
    const scannerNextStep = scannerStatus === 'SCANNING' || scannerStatus === 'RUNNING'
      ? 'No action needed unless the latest scan log stops updating during market hours.'
      : scannerStatus === 'MARKET_CLOSED'
        ? 'No action needed. It will resume when the trading window opens.'
        : 'Check market window, scanner enabled flag, eligible source user, and the latest scan log.';

    items.push({
      id: 'service:scanner',
      area: 'Runtime',
      title: 'Signal Scanner',
      status: scannerStatus,
      severity: severityForStatus(scannerStatus),
      endpoint: '/api/signals/trigger',
      freshnessMs: services.scanner?.freshnessMs ?? null,
      lastSeen: adapterLastSeen(services.scanner, services.scanner?.lastScanAt || services.generatedAt),
      evidence: services.scanner?.degradedReason || services.scanner?.lastSkippedReason || null,
      cause: scannerCause,
      nextStep: scannerNextStep,
      actionCommand: 'Open Settings -> Day Trading, confirm scanner enabled and trading window.'
    });

    items.push({
      id: 'service:poller',
      area: 'Runtime',
      title: 'Market Poller',
      status: services.poller?.running ? 'RUNNING' : 'STOPPED',
      severity: services.poller?.running ? 'ok' : 'warning',
      endpoint: 'backend MarketPoller',
      freshnessMs: services.poller?.freshnessMs ?? null,
      lastSeen: adapterLastSeen(services.poller, services.generatedAt),
      evidence: services.poller?.degradedReason || (services.poller?.running ? null : 'Poller reports stopped.'),
      cause: services.poller?.degradedReason || (services.poller?.running ? 'Poller is running.' : 'Fallback market sync loop is not running.'),
      nextStep: 'Restart backend if the poller should be active.',
      actionCommand: 'docker compose restart trade-staging-backend'
    });

    items.push({
      id: 'service:liveExitMonitor',
      area: 'Trading',
      title: 'Live Exit Monitor',
      status: services.liveExitMonitor?.status || 'N/A',
      severity: services.liveExitMonitor?.lastError ? 'critical' : severityForStatus(services.liveExitMonitor?.status),
      endpoint: `stream provider: ${services.liveExitMonitor?.provider || 'none'}`,
      freshnessMs: services.liveExitMonitor?.freshnessMs ?? null,
      lastSeen: adapterLastSeen(services.liveExitMonitor, services.liveExitMonitor?.lastQuoteAt || services.generatedAt),
      evidence: services.liveExitMonitor?.degradedReason || services.liveExitMonitor?.lastError || null,
      cause: causeFromError('Live exit quote processing error.', services.liveExitMonitor?.degradedReason || services.liveExitMonitor?.lastError),
      nextStep: 'Check the active stream, open option subscriptions, and quote timestamps.',
      actionCommand: 'Open /system-health and compare Live Exit Monitor with the active stream last message time.'
    });

    const ibkr = services.marketData?.ibkr;
    const ibkrPort = ibkr?.port || (ibkr?.mode === 'paper' ? 4004 : 4003);
    const ibkrMode = ibkr?.mode || (ibkrPort === 4004 ? 'paper' : 'live');
    items.push({
      id: 'market:ibkr',
      area: 'Market Data',
      title: 'IBKR Gateway',
      status: ibkr?.status || 'N/A',
      severity: ibkr?.lastError ? 'critical' : severityForStatus(ibkr?.status),
      endpoint: `${ibkr?.host || 'ib_gateway'}:${ibkrPort}`,
      latencyMs: ibkr?.latencyMs ?? null,
      freshnessMs: ibkr?.freshnessMs ?? null,
      lastSeen: adapterLastSeen(ibkr, services.generatedAt),
      evidence: ibkr?.degradedReason || ibkr?.lastError || null,
      cause: statusSummary(ibkr?.status, ibkr?.degradedReason || ibkr?.lastError, `IBKR ${ibkrMode} Gateway is not reachable or market data is unavailable.`),
      nextStep: isHealthyStatus(ibkr?.status)
        ? `No action needed. IBKR ${ibkrMode} market data is reachable on port ${ibkrPort}.`
        : `Verify IB Gateway is logged in ${ibkrMode} mode, port ${ibkrPort} is reachable, and market-data subscriptions are active.`,
      actionCommand: 'Run the IBKR TypeScript smoke test from the backend container.'
    });

    Object.entries(services.streams || {}).forEach(([name, stream]) => {
      const isActive = services.liveExitMonitor?.provider === name || Boolean(stream?.connected || (stream?.activeSubscriptions ?? 0) > 0 || stream?.lastMessageAt);
      const streamTitle = name === 'ibkr' ? 'IBKR' : 'Alpaca';
      const streamEndpoint = name === 'ibkr'
        ? 'IBKR Gateway TCP market-data stream'
        : 'Alpaca market-data stream';
      items.push({
        id: `stream:${name}`,
        area: 'Stream',
        title: `${streamTitle} Quote Stream`,
        status: isActive ? stream?.status || 'N/A' : 'DISABLED',
        severity: isActive && stream?.lastError ? 'critical' : severityForStatus(isActive ? stream?.status : 'DISABLED'),
        endpoint: streamEndpoint,
        freshnessMs: stream?.freshnessMs ?? null,
        lastSeen: adapterLastSeen(stream, stream?.lastMessageAt || services.generatedAt),
        evidence: stream?.degradedReason || stream?.lastError || `${stream?.activeSubscriptions ?? 0} active subscriptions, ${stream?.reconnectAttempts ?? 0} reconnect attempts`,
        cause: stream?.degradedReason || stream?.lastError ? causeFromError('Quote stream connection or message parsing failed.', stream?.degradedReason || stream?.lastError) : statusSummary(isActive ? stream?.status : 'DISABLED', null, 'Stream status and subscription state.'),
        nextStep: name === 'ibkr'
          ? 'Confirm IB Gateway is logged in and open/manual option contracts are subscribed.'
          : 'Alpaca stream is optional unless selected as active provider.',
        actionCommand: name === 'ibkr'
          ? 'Check IBKR_HOST, IBKR_PORT, and live market-data subscriptions.'
          : 'No action needed unless Alpaca is intentionally used as active provider.'
      });
    });

    const broker = services.snaptradePendingOrders;
    items.push({
      id: 'broker:snaptradePendingOrders',
      area: 'Broker',
      title: 'SnapTrade Pending Orders',
      status: broker?.status || 'N/A',
      severity: broker?.lastError ? 'critical' : severityForStatus(broker?.status),
      endpoint: 'SnapTrade order status sync',
      freshnessMs: broker?.freshnessMs ?? null,
      lastSeen: adapterLastSeen(broker, broker?.lastRunAt || broker?.queuedSyncLastRunAt || services.generatedAt),
      evidence: broker?.degradedReason || broker?.lastError || broker?.lastResult || null,
      cause: causeFromError('Broker reconciliation is failing or stale.', broker?.degradedReason || broker?.lastError),
      nextStep: 'Check SnapTrade connection status, selected trading account, and pending order IDs.',
      actionCommand: 'Open Settings -> SnapTrade, refresh accounts, then use Command Center on stale trades.'
    });

    items.push({
      id: 'broker:watchdog',
      area: 'Broker',
      title: 'Broker Watchdog',
      status: (broker?.lastWatchdogResult?.entryStale || broker?.lastWatchdogResult?.exitStale) ? 'DEGRADED' : 'OK',
      severity: (broker?.lastWatchdogResult?.entryStale || broker?.lastWatchdogResult?.exitStale) ? 'warning' : 'ok',
      endpoint: 'backend order watchdog',
      lastSeen: broker?.lastRunAt || services.generatedAt,
      evidence: broker?.lastWatchdogResult || null,
      cause: 'Detects stale pending broker entries/exits.',
      nextStep: 'Use the command center to verify stale broker orders before retrying exits.',
      actionCommand: 'Open the affected trade in Command Center and refresh broker proof.'
    });

    items.push({
      id: 'runtime:tradeRedis',
      area: 'Runtime',
      title: 'Trade Redis',
      status: services.tradeRedis?.status || 'N/A',
      severity: services.tradeRedis?.status === 'DEGRADED' ? 'warning' : severityForStatus(services.tradeRedis?.status),
      endpoint: 'redis://trade-staging-redis:6379',
      freshnessMs: services.tradeRedis?.freshnessMs ?? null,
      lastSeen: adapterLastSeen(services.tradeRedis, services.tradeRedis?.generatedAt || services.generatedAt),
      evidence: services.tradeRedis?.degradedReason || services.tradeRedis?.metrics || null,
      cause: services.tradeRedis?.degradedReason || (services.tradeRedis?.status === 'DEGRADED' ? 'Redis is reachable but queue/lock telemetry indicates degradation.' : 'Redis cache, locks, and broker sync queue.'),
      nextStep: 'Check Redis container health, queue depth, and lock denial spikes.',
      actionCommand: 'docker compose ps trade-staging-redis && docker compose logs --tail=80 trade-staging-redis'
    });

    if (services.postgres) {
      items.push({
        id: 'runtime:postgres',
        area: 'Runtime',
        title: 'Postgres',
        status: services.postgres.status || 'N/A',
        severity: services.postgres.lastError ? 'critical' : severityForStatus(services.postgres.status),
        endpoint: 'Primary database connection',
        latencyMs: services.postgres.latencyMs ?? null,
        freshnessMs: services.postgres.freshnessMs ?? null,
        lastSeen: adapterLastSeen(services.postgres, services.generatedAt),
        evidence: services.postgres.degradedReason || services.postgres.lastError || null,
        cause: statusSummary(services.postgres.status, services.postgres.degradedReason || services.postgres.lastError, 'Database connectivity check needs attention.'),
        nextStep: 'Check database network path, credentials, and primary host reachability.',
        actionCommand: 'docker compose logs --tail=80 trade-staging-backend'
      });
    }
  }

  return items;
};

function StatusPill({ status, ignored = false }: { status?: string | null; ignored?: boolean }) {
  if (ignored) {
    return (
      <Badge variant="outline" className="border-border bg-muted/40 font-mono text-[10px] text-muted-foreground">
        IGNORED
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={`font-mono text-[10px] ${statusTone(status)}`}>
      {status || 'N/A'}
    </Badge>
  );
}

function MetricCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail?: string; icon: any }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</div>
          <div className="mt-1 truncate font-mono text-xl font-semibold">{value}</div>
        </div>
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
      </div>
      {detail && <div className="mt-2 break-words text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function EvidenceBlock({ value }: { value?: unknown }) {
  const text = compactValue(value);
  return (
    <pre className="max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
      {text}
    </pre>
  );
}

function CommandBlock({ value }: { value: string }) {
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
      {value}
    </pre>
  );
}

function DiagnosticRow({
  item,
  ignored,
  onToggleIgnored
}: {
  item: DiagnosticItem;
  ignored: boolean;
  onToggleIgnored: (componentKey: string) => void;
}) {
  const hasEvidence = item.evidence !== null && item.evidence !== undefined && item.evidence !== '';
  const detailLabel = item.severity === 'critical' || item.severity === 'warning' ? 'Likely Cause' : 'Current State';

  return (
    <div className="grid min-w-0 gap-3 px-4 py-3 lg:grid-cols-[minmax(180px,1.1fr)_minmax(220px,1.2fr)_minmax(240px,1.4fr)_auto] lg:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium">{item.title}</span>
          <StatusPill status={item.status} ignored={ignored} />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{item.area} · {formatRelativeTime(item.lastSeen)}</div>
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">Endpoint</div>
        <div className="mt-1 break-all font-mono text-xs">{item.endpoint || 'Internal runtime check'}</div>
        {item.latencyMs !== null && item.latencyMs !== undefined && (
          <div className="mt-1 text-xs text-muted-foreground">{item.latencyMs}ms latency</div>
        )}
        {item.freshnessMs !== null && item.freshnessMs !== undefined && (
          <div className="mt-1 text-xs text-muted-foreground">{formatDurationMs(item.freshnessMs)} freshness</div>
        )}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">{detailLabel}</div>
        <div className="mt-1 text-xs">{item.cause}</div>
        {hasEvidence && (
          <>
            <div className="mt-2 text-[10px] font-semibold uppercase text-muted-foreground">Evidence</div>
            <div className="mt-1"><EvidenceBlock value={item.evidence} /></div>
          </>
        )}
        {item.actionCommand && (
          <>
            <div className="mt-2 text-[10px] font-semibold uppercase text-muted-foreground">Run or check</div>
            <div className="mt-1 min-w-0"><CommandBlock value={item.actionCommand} /></div>
          </>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 w-fit px-2 text-xs"
        onClick={() => onToggleIgnored(item.id)}
      >
        {ignored ? 'Unignore' : 'Ignore'}
      </Button>
    </div>
  );
}

function RootCauseCard({ item }: { item: DiagnosticItem }) {
  const Icon = item.severity === 'critical' ? ServerCrash : item.severity === 'warning' ? AlertTriangle : CheckCircle2;
  return (
    <div className={`rounded-md border p-4 ${severityTone(item.severity)}`}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="break-words text-sm font-semibold">{item.title}</div>
            <StatusPill status={item.status} />
          </div>
          <div className="mt-2 break-words text-xs">{item.cause}</div>
          <div className="mt-2 break-all font-mono text-[11px] opacity-90">{item.endpoint || item.area}</div>
          <div className="mt-3 text-xs font-medium">Next: {item.nextStep}</div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export default function SystemHealthPage() {
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null);
  const [services, setServices] = useState<ServiceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ignoredComponents, setIgnoredComponents] = useState<Set<string>>(() => loadIgnoredComponents());

  const loadHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const [apiStatus, serviceStatus] = await Promise.all([
        api.getSignalsHealth(),
        api.getServicesHealth()
      ]);
      setApiHealth(apiStatus);
      setServices(serviceStatus);
    } catch (err: any) {
      setError(err.message || 'Failed to load system health');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHealth();
    const timer = window.setInterval(loadHealth, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleIgnoredComponent = (componentKey: string) => {
    setIgnoredComponents((current) => {
      const next = new Set(current);
      if (next.has(componentKey)) next.delete(componentKey);
      else next.add(componentKey);
      saveIgnoredComponents(next);
      return next;
    });
  };

  const resetIgnoredComponents = () => {
    const next = new Set<string>();
    saveIgnoredComponents(next);
    setIgnoredComponents(next);
  };

  const diagnostics = useMemo(() => buildDiagnostics(apiHealth, services), [apiHealth, services]);
  const activeDiagnostics = diagnostics.filter((item) => !ignoredComponents.has(item.id));
  const failures = activeDiagnostics.filter((item) => item.severity === 'critical');
  const warnings = activeDiagnostics.filter((item) => item.severity === 'warning');
  const problematicEndpoints = activeDiagnostics.filter((item) => ['critical', 'warning'].includes(item.severity));
  const rootCauseItems = problematicEndpoints.slice(0, 4);
  const statusLabel = failures.length > 0 ? 'Action Required' : warnings.length > 0 ? 'Watch Closely' : 'All Systems Normal';
  const statusSeverity: HealthSeverity = failures.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'ok';
  const activeProvider = services?.liveExitMonitor?.provider === 'ibkr'
    ? services?.streams?.ibkr
    : services?.streams?.alpaca;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:w-[95%] sm:px-0">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <Button asChild variant="ghost" size="icon" className="shrink-0 rounded-full">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">System Health</h2>
            <p className="text-sm text-muted-foreground">Root cause, endpoint status, and runtime evidence for trading services.</p>
          </div>
        </div>
        <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={loadHealth} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className={`mb-4 rounded-md border p-4 ${severityTone(statusSeverity)}`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {statusSeverity === 'ok' ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" /> : <Siren className="mt-0.5 h-5 w-5 shrink-0" />}
            <div className="min-w-0">
              <div className="font-semibold">{statusLabel}</div>
              <div className="break-words text-sm">
                {failures.length} critical, {warnings.length} warning, {ignoredComponents.size} ignored. Updated {formatRelativeTime(services?.generatedAt)}.
              </div>
            </div>
          </div>
          {ignoredComponents.size > 0 && (
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={resetIgnoredComponents}>
              Reset ignored
            </Button>
          )}
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Root Issues" value={`${failures.length}`} detail={`${warnings.length} warnings active`} icon={Search} />
        <MetricCard label="Live Exit" value={services?.liveExitMonitor?.status || 'N/A'} detail={`${services?.liveExitMonitor?.matchedUpdates ?? 0} matched updates`} icon={Activity} />
        <MetricCard label="Option Capture" value={services?.optionHistoryCapture?.status || 'N/A'} detail={`${services?.optionHistoryCapture?.persistedQuotes ?? 0} persisted quotes`} icon={Database} />
        <MetricCard label="Active Stream" value={activeProvider?.connected ? 'Connected' : 'Disconnected'} detail={`${activeProvider?.activeSubscriptions ?? 0} subscriptions`} icon={Router} />
        <MetricCard label="Broker Sync" value={services?.snaptradePendingOrders?.status || 'N/A'} detail={`Checked ${services?.snaptradePendingOrders?.lastResult?.checked ?? 0} pending orders`} icon={Zap} />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Section title="Root Cause Suspects" icon={ServerCrash}>
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {rootCauseItems.length > 0 ? rootCauseItems.map((item) => (
              <RootCauseCard key={item.id} item={item} />
            )) : (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-500">
                No critical or warning-level endpoint/runtime failures are active.
              </div>
            )}
          </div>
        </Section>

        <Section title="Recent Error Evidence" icon={AlertTriangle}>
          <div className="space-y-3 p-4">
            {problematicEndpoints.slice(0, 5).map((item) => (
              <div key={item.id} className="rounded-md border border-border bg-muted/10 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">{item.title}</div>
                  <Badge variant="outline" className={`text-[10px] ${severityTone(item.severity)}`}>{item.area}</Badge>
                </div>
                <EvidenceBlock value={item.evidence || item.cause} />
              </div>
            ))}
            {problematicEndpoints.length === 0 && (
              <div className="rounded-md border border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                No error evidence reported by health checks.
              </div>
            )}
          </div>
        </Section>
      </div>

      <div className="grid gap-4">
        <Section title="Problematic Endpoints" icon={RadioTower}>
          <div className="divide-y divide-border">
            {problematicEndpoints.length > 0 ? problematicEndpoints.map((item) => (
              <DiagnosticRow
                key={item.id}
                item={item}
                ignored={ignoredComponents.has(item.id)}
                onToggleIgnored={toggleIgnoredComponent}
              />
            )) : (
              <div className="px-4 py-6 text-sm text-muted-foreground">No problematic endpoints detected.</div>
            )}
          </div>
        </Section>

        <Section title="All Component Diagnostics" icon={Database}>
          <div className="divide-y divide-border">
            {diagnostics.map((item) => (
              <DiagnosticRow
                key={item.id}
                item={item}
                ignored={ignoredComponents.has(item.id)}
                onToggleIgnored={toggleIgnoredComponent}
              />
            ))}
          </div>
        </Section>

        <Section title="Runtime Snapshot" icon={Clock}>
          <div className="grid gap-3 p-4 lg:grid-cols-3">
            <EvidenceBlock value={{
              generatedAt: services?.generatedAt || null,
              liveExitMonitor: services?.liveExitMonitor || null,
              activeStream: activeProvider || null
            }} />
            <EvidenceBlock value={{
              scanner: services?.scanner || null,
              snaptradePendingOrders: services?.snaptradePendingOrders || null
            }} />
            <EvidenceBlock value={{
              marketData: services?.marketData || null,
              tradeRedis: services?.tradeRedis || null
            }} />
          </div>
        </Section>
      </div>
    </div>
  );
}
