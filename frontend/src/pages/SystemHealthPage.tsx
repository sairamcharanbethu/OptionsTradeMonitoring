import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowLeft, Clock, Database, RefreshCw, Router, ShieldCheck, Siren, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

type ApiHealth = Awaited<ReturnType<typeof api.getSignalsHealth>>;
type ServiceHealth = Awaited<ReturnType<typeof api.getServicesHealth>>;

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

const systemSummary = (apiHealth: ApiHealth | null, services: ServiceHealth | null, websocketConnected: boolean | null) => {
  const issues: string[] = [];
  const degraded: string[] = [];

  if (apiHealth) {
    Object.entries(apiHealth).forEach(([name, value]) => {
      if (value?.status && value.status !== 'N/A' && value.status !== 'UP') issues.push(`${name} ${value.status}`);
    });
  }

  if (services) {
    if (isBadStatus(services.liveExitMonitor?.status)) issues.push(`live exit ${services.liveExitMonitor.status}`);
    if (services.liveExitMonitor?.lastError) issues.push('live exit error');
    if (isBadStatus(services.streams?.alpaca?.status)) issues.push(`Alpaca stream ${services.streams.alpaca.status}`);
    if (isBadStatus(services.streams?.questrade?.status)) issues.push(`Questrade stream ${services.streams.questrade.status}`);
    if (!services.poller?.running) degraded.push('poller stopped');
    if (isBadStatus(services.scanner?.status)) issues.push(`scanner ${services.scanner.status}`);
    if (services.snaptradePendingOrders?.lastError) issues.push('broker sync error');
    if (services.tradeRedis?.status === 'DEGRADED') degraded.push('Redis degraded');
  }

  if (websocketConnected === false) degraded.push('browser stream disconnected');

  if (issues.length > 0) return { label: 'System Degraded', tone: 'destructive' as const, issues };
  if (degraded.length > 0) return { label: 'System Warning', tone: 'warning' as const, issues: degraded };
  return { label: 'All Systems Normal', tone: 'ok' as const, issues: [] };
};

function StatusPill({ status }: { status?: string | null }) {
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

export default function SystemHealthPage() {
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null);
  const [services, setServices] = useState<ServiceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const summary = useMemo(() => systemSummary(apiHealth, services, null), [apiHealth, services]);
  const apiEntries = apiHealth ? Object.entries(apiHealth).filter(([, value]) => value?.status !== 'N/A') : [];
  const activeProvider = services?.liveExitMonitor?.provider === 'alpaca' ? services?.streams?.alpaca : services?.streams?.questrade;

  return (
    <div className="mx-auto w-[95%] max-w-[1500px] py-4">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="rounded-full">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">System Health</h2>
            <p className="text-sm text-muted-foreground">Runtime status for trading, data, broker sync, streams, and Redis.</p>
          </div>
        </div>
        <Button variant="outline" className="gap-2" onClick={loadHealth} disabled={loading}>
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
          <div className="flex items-center gap-3">
            {summary.tone === 'ok' ? <ShieldCheck className="h-5 w-5 text-emerald-500" /> : <Siren className="h-5 w-5 text-amber-500" />}
            <div>
              <div className="font-semibold">{summary.label}</div>
              <div className="text-sm text-muted-foreground">
                {summary.issues.length > 0 ? summary.issues.slice(0, 4).join(', ') : 'No active component-level issues detected.'}
              </div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">Generated {formatRelativeTime(services?.generatedAt)}</div>
        </div>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <MetricCard label="Live Exit" value={services?.liveExitMonitor?.status || 'N/A'} detail={`${services?.liveExitMonitor?.matchedUpdates ?? 0} matched updates`} icon={Activity} />
        <MetricCard label="Active Stream" value={activeProvider?.connected ? 'Connected' : 'Disconnected'} detail={`${activeProvider?.activeSubscriptions ?? 0} subscriptions`} icon={Router} />
        <MetricCard label="Broker Sync" value={services?.snaptradePendingOrders?.status || 'N/A'} detail={`Checked ${services?.snaptradePendingOrders?.lastResult?.checked ?? 0} pending orders`} icon={Zap} />
        <MetricCard label="Redis Runtime" value={services?.tradeRedis?.status || 'N/A'} detail={`Queue depth ${services?.tradeRedis?.queueDepth ?? 0}`} icon={Database} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">External APIs</h3>
          </div>
          <div className="divide-y divide-border">
            {apiEntries.map(([name, value]) => (
              <div key={name} className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{name}</div>
                  <div className="text-xs text-muted-foreground">{value.latencyMs}ms latency</div>
                </div>
                <StatusPill status={value.status} />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Runtime Services</h3>
          </div>
          <div className="divide-y divide-border">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Scanner</div>
                <div className="text-xs text-muted-foreground">
                  {services?.scanner?.lastSkippedReason || `Window ${services?.scanner?.window?.start || '09:30'}-${services?.scanner?.window?.cutoff || '16:00'} ET`}
                </div>
              </div>
              <StatusPill status={services?.scanner?.status} />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Poller</div>
                <div className="text-xs text-muted-foreground">Fallback market sync</div>
              </div>
              <StatusPill status={services?.poller?.running ? 'RUNNING' : 'STOPPED'} />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Live Exit Monitor</div>
                <div className="text-xs text-muted-foreground">{services?.liveExitMonitor?.lastError || `Last quote ${formatRelativeTime(services?.liveExitMonitor?.lastQuoteAt)}`}</div>
              </div>
              <StatusPill status={services?.liveExitMonitor?.status} />
            </div>
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Streams</h3>
          </div>
          <div className="divide-y divide-border">
            {[
              ['Alpaca', services?.streams?.alpaca],
              ['Questrade', services?.streams?.questrade]
            ].map(([name, stream]: any) => (
              <div key={name} className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{name}</div>
                  <div className="text-xs text-muted-foreground">
                    {stream?.activeSubscriptions ?? 0} subscriptions, last message {formatRelativeTime(stream?.lastMessageAt)}
                  </div>
                </div>
                <StatusPill status={stream?.status} />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Broker And Redis</h3>
          </div>
          <div className="divide-y divide-border">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium">SnapTrade Pending Orders</div>
                <div className="text-xs text-muted-foreground">
                  Last run {formatRelativeTime(services?.snaptradePendingOrders?.lastRunAt)}, queued {services?.snaptradePendingOrders?.queuedSyncProcessed ?? 0}
                </div>
              </div>
              <StatusPill status={services?.snaptradePendingOrders?.status} />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Trade Redis</div>
                <div className="text-xs text-muted-foreground">
                  Queue {services?.tradeRedis?.queueDepth ?? 0}, locks denied {services?.tradeRedis?.metrics?.['locks.denied'] ?? 0}
                </div>
              </div>
              <StatusPill status={services?.tradeRedis?.status} />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Broker Watchdog</div>
                <div className="text-xs text-muted-foreground">
                  Stale entries {services?.snaptradePendingOrders?.lastWatchdogResult?.entryStale ?? 0}, stale exits {services?.snaptradePendingOrders?.lastWatchdogResult?.exitStale ?? 0}
                </div>
              </div>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
