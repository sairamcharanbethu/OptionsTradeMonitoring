import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowLeft, Clock, Database, RefreshCw, Router, ShieldCheck, Siren, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

type ApiHealth = Awaited<ReturnType<typeof api.getSignalsHealth>>;
type ServiceHealth = Awaited<ReturnType<typeof api.getServicesHealth>>;

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
    // Ignore local browser storage failures; the live health payload is unchanged.
  }
};

const formatRelativeTime = (timestamp?: string | null) => {
  if (!timestamp) return 'No recent data';
  const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)}m ago`;
  return `${Math.round(diffSeconds / 3600)}h ago`;
};

const statusTone = (status?: string | null) => {
  const normalized = String(status || '').toUpperCase();
  if (['UP', 'RUNNING', 'CONNECTED', 'OK'].includes(normalized)) return 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10';
  if (['DEGRADED', 'MARKET_CLOSED', 'IDLE'].includes(normalized)) return 'text-amber-500 border-amber-500/30 bg-amber-500/10';
  if (['N/A', 'DISABLED'].includes(normalized)) return 'text-muted-foreground border-border bg-muted/40';
  return 'text-red-500 border-red-500/30 bg-red-500/10';
};

const isBadStatus = (status?: string | null) => {
  const normalized = String(status || '').toUpperCase();
  return Boolean(normalized) && !['UP', 'RUNNING', 'CONNECTED', 'OK', 'N/A', 'MARKET_CLOSED', 'IDLE'].includes(normalized);
};

const isWatchedStream = (
  componentKey: string,
  provider: string,
  stream: NonNullable<ServiceHealth['streams']>['alpaca'] | NonNullable<ServiceHealth['streams']>['questrade'] | undefined,
  services: ServiceHealth,
  ignoredComponents: Set<string>
) => {
  if (ignoredComponents.has(componentKey)) return false;
  if (services.liveExitMonitor?.provider === provider) return true;
  return Boolean(stream?.connected || (stream?.activeSubscriptions ?? 0) > 0 || stream?.lastMessageAt);
};

const systemSummary = (
  apiHealth: ApiHealth | null,
  services: ServiceHealth | null,
  websocketConnected: boolean | null,
  ignoredComponents: Set<string>
) => {
  const issues: string[] = [];
  const degraded: string[] = [];

  if (apiHealth) {
    Object.entries(apiHealth).forEach(([name, value]) => {
      if (ignoredComponents.has(`api:${name}`)) return;
      if (value?.status && value.status !== 'N/A' && value.status !== 'UP') issues.push(`${name} ${value.status}`);
    });
  }

  if (services) {
    if (!ignoredComponents.has('service:liveExitMonitor')) {
      if (isBadStatus(services.liveExitMonitor?.status)) issues.push(`live exit ${services.liveExitMonitor.status}`);
      if (services.liveExitMonitor?.lastError) issues.push('live exit error');
    }
    if (isWatchedStream('stream:alpaca', 'alpaca', services.streams?.alpaca, services, ignoredComponents) && isBadStatus(services.streams?.alpaca?.status)) {
      issues.push(`Alpaca stream ${services.streams.alpaca.status}`);
    }
    if (isWatchedStream('stream:questrade', 'questrade', services.streams?.questrade, services, ignoredComponents) && isBadStatus(services.streams?.questrade?.status)) {
      issues.push(`Questrade stream ${services.streams.questrade.status}`);
    }
    if (!ignoredComponents.has('service:poller') && !services.poller?.running) degraded.push('poller stopped');
    if (!ignoredComponents.has('service:scanner') && isBadStatus(services.scanner?.status)) issues.push(`scanner ${services.scanner.status}`);
    if (!ignoredComponents.has('broker:snaptradePendingOrders') && services.snaptradePendingOrders?.lastError) issues.push('broker sync error');
    if (!ignoredComponents.has('runtime:tradeRedis') && services.tradeRedis?.status === 'DEGRADED') degraded.push('Redis degraded');
  }

  if (websocketConnected === false) degraded.push('browser stream disconnected');

  if (issues.length > 0) return { label: 'System Degraded', tone: 'destructive' as const, issues };
  if (degraded.length > 0) return { label: 'System Warning', tone: 'warning' as const, issues: degraded };
  return { label: 'All Systems Normal', tone: 'ok' as const, issues: [] };
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
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 font-mono text-xl font-semibold">{value}</div>
        </div>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      {detail && <div className="mt-2 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function HealthRow({
  title,
  detail,
  status,
  componentKey,
  ignoredComponents,
  onToggleIgnored,
  children
}: {
  title: string;
  detail?: string;
  status?: string | null;
  componentKey: string;
  ignoredComponents: Set<string>;
  onToggleIgnored: (componentKey: string) => void;
  children?: ReactNode;
}) {
  const ignored = ignoredComponents.has(componentKey);

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="break-words text-sm font-medium">{title}</div>
        {detail && <div className="mt-0.5 break-words text-xs text-muted-foreground">{detail}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {ignored ? <StatusPill status={status} ignored /> : children ?? <StatusPill status={status} />}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onToggleIgnored(componentKey)}
        >
          {ignored ? 'Unignore' : 'Ignore'}
        </Button>
      </div>
    </div>
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
      if (next.has(componentKey)) {
        next.delete(componentKey);
      } else {
        next.add(componentKey);
      }
      saveIgnoredComponents(next);
      return next;
    });
  };

  const resetIgnoredComponents = () => {
    const next = new Set<string>();
    saveIgnoredComponents(next);
    setIgnoredComponents(next);
  };

  const summary = useMemo(() => systemSummary(apiHealth, services, null, ignoredComponents), [apiHealth, services, ignoredComponents]);
  const apiEntries = apiHealth ? Object.entries(apiHealth).filter(([, value]) => value?.status !== 'N/A') : [];
  const activeProvider = services?.liveExitMonitor?.provider === 'alpaca' ? services?.streams?.alpaca : services?.streams?.questrade;

  return (
    <div className="mx-auto w-full max-w-[1500px] px-3 py-4 sm:w-[95%] sm:px-0">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <Button asChild variant="ghost" size="icon" className="shrink-0 rounded-full">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">System Health</h2>
            <p className="text-sm text-muted-foreground">Runtime status for trading, data, broker sync, streams, and Redis.</p>
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

      <div className={`mb-4 rounded-md border p-4 ${
        summary.tone === 'ok'
          ? 'border-emerald-500/30 bg-emerald-500/10'
          : summary.tone === 'warning'
            ? 'border-amber-500/30 bg-amber-500/10'
            : 'border-red-500/30 bg-red-500/10'
      }`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            {summary.tone === 'ok' ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500 sm:mt-0" /> : <Siren className="mt-0.5 h-5 w-5 shrink-0 text-amber-500 sm:mt-0" />}
            <div className="min-w-0">
              <div className="font-semibold">{summary.label}</div>
              <div className="break-words text-sm text-muted-foreground">
                {summary.issues.length > 0 ? summary.issues.slice(0, 4).join(', ') : 'No active component-level issues detected.'}
              </div>
            </div>
          </div>
          <div className="shrink-0 text-xs text-muted-foreground">Generated {formatRelativeTime(services?.generatedAt)}</div>
        </div>
        {ignoredComponents.size > 0 && (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>Ignoring {ignoredComponents.size} component{ignoredComponents.size === 1 ? '' : 's'} in this browser. Ignored components do not affect the summary banner.</span>
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={resetIgnoredComponents}>
              Reset ignored
            </Button>
          </div>
        )}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Live Exit" value={services?.liveExitMonitor?.status || 'N/A'} detail={`${services?.liveExitMonitor?.matchedUpdates ?? 0} matched updates`} icon={Activity} />
        <MetricCard label="Active Stream" value={activeProvider?.connected ? 'Connected' : 'Disconnected'} detail={`${activeProvider?.activeSubscriptions ?? 0} subscriptions`} icon={Router} />
        <MetricCard label="Broker Sync" value={services?.snaptradePendingOrders?.status || 'N/A'} detail={`Checked ${services?.snaptradePendingOrders?.lastResult?.checked ?? 0} pending orders`} icon={Zap} />
        <MetricCard label="Redis Runtime" value={services?.tradeRedis?.status || 'N/A'} detail={`Queue depth ${services?.tradeRedis?.queueDepth ?? 0}`} icon={Database} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">External APIs</h3>
          </div>
          <div className="divide-y divide-border">
            {apiEntries.map(([name, value]) => (
              <HealthRow
                key={name}
                title={name}
                detail={`${value.latencyMs}ms latency`}
                status={value.status}
                componentKey={`api:${name}`}
                ignoredComponents={ignoredComponents}
                onToggleIgnored={toggleIgnoredComponent}
              />
            ))}
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Runtime Services</h3>
          </div>
          <div className="divide-y divide-border">
            <HealthRow
              title="Scanner"
              detail={services?.scanner?.lastSkippedReason || `Window ${services?.scanner?.window?.start || '09:30'}-${services?.scanner?.window?.cutoff || '16:00'} ET`}
              status={services?.scanner?.status}
              componentKey="service:scanner"
              ignoredComponents={ignoredComponents}
              onToggleIgnored={toggleIgnoredComponent}
            />
            <HealthRow
              title="Poller"
              detail="Fallback market sync"
              status={services?.poller?.running ? 'RUNNING' : 'STOPPED'}
              componentKey="service:poller"
              ignoredComponents={ignoredComponents}
              onToggleIgnored={toggleIgnoredComponent}
            />
            <HealthRow
              title="Live Exit Monitor"
              detail={services?.liveExitMonitor?.lastError || `Last quote ${formatRelativeTime(services?.liveExitMonitor?.lastQuoteAt)}`}
              status={services?.liveExitMonitor?.status}
              componentKey="service:liveExitMonitor"
              ignoredComponents={ignoredComponents}
              onToggleIgnored={toggleIgnoredComponent}
            />
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Streams</h3>
          </div>
          <div className="divide-y divide-border">
            {[
              ['Alpaca', 'stream:alpaca', services?.streams?.alpaca],
              ['Questrade', 'stream:questrade', services?.streams?.questrade]
            ].map(([name, componentKey, stream]: any) => (
              <HealthRow
                key={name}
                title={name}
                detail={`${stream?.activeSubscriptions ?? 0} subscriptions, last message ${formatRelativeTime(stream?.lastMessageAt)}`}
                status={stream?.status}
                componentKey={componentKey}
                ignoredComponents={ignoredComponents}
                onToggleIgnored={toggleIgnoredComponent}
              />
            ))}
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Broker And Redis</h3>
          </div>
          <div className="divide-y divide-border">
            <HealthRow
              title="SnapTrade Pending Orders"
              detail={`Last run ${formatRelativeTime(services?.snaptradePendingOrders?.lastRunAt)}, queued ${services?.snaptradePendingOrders?.queuedSyncProcessed ?? 0}`}
              status={services?.snaptradePendingOrders?.status}
              componentKey="broker:snaptradePendingOrders"
              ignoredComponents={ignoredComponents}
              onToggleIgnored={toggleIgnoredComponent}
            />
            <HealthRow
              title="Trade Redis"
              detail={`Queue ${services?.tradeRedis?.queueDepth ?? 0}, locks denied ${services?.tradeRedis?.metrics?.['locks.denied'] ?? 0}`}
              status={services?.tradeRedis?.status}
              componentKey="runtime:tradeRedis"
              ignoredComponents={ignoredComponents}
              onToggleIgnored={toggleIgnoredComponent}
            />
            <HealthRow
              title="Broker Watchdog"
              detail={`Stale entries ${services?.snaptradePendingOrders?.lastWatchdogResult?.entryStale ?? 0}, stale exits ${services?.snaptradePendingOrders?.lastWatchdogResult?.exitStale ?? 0}`}
              status={null}
              componentKey="broker:watchdog"
              ignoredComponents={ignoredComponents}
              onToggleIgnored={toggleIgnoredComponent}
            >
              <Clock className="h-4 w-4 text-muted-foreground" />
            </HealthRow>
          </div>
        </section>
      </div>
    </div>
  );
}
