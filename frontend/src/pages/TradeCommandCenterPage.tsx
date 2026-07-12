import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, ArrowLeft, BadgeDollarSign, BrainCircuit, CheckCircle2, Clock, ExternalLink, FileJson, RefreshCw, ShieldCheck, Siren, Target, Workflow } from 'lucide-react';
import { api, TradeCommandCenterResponse, TradeEvent } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

const currency = (value?: number | null) => {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return `$${Number(value).toFixed(2)}`;
};

const compactDate = (value?: string | null) => {
  if (!value) return '-';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

const contractLabel = (trade: TradeCommandCenterResponse['trade']) => {
  const expiry = String(trade.expiration_date || '').split('T')[0];
  return `${trade.symbol} ${Number(trade.strike_price).toFixed(0)}${trade.option_type === 'CALL' ? 'C' : 'P'} ${expiry}`;
};

const statusTone = (value?: string | null): 'default' | 'destructive' | 'outline' | 'secondary' => {
  const status = String(value || '').toUpperCase();
  if (status.includes('FAILED') || status.includes('REJECTED') || status.includes('STALE') || status.includes('ERROR')) return 'destructive';
  if (status.includes('PENDING') || status.includes('WAITING')) return 'secondary';
  if (status.includes('CLOSED') || status.includes('FILLED') || status.includes('DONE') || status.includes('OPEN')) return 'default';
  return 'outline';
};

const humanStatus = (value?: string | null) => {
  const status = String(value || '').toUpperCase();
  const labels: Record<string, string> = {
    OPEN: 'Holding',
    CLOSED: 'Closed',
    FILLED: 'Filled',
    EXECUTED: 'Executed',
    PENDING: 'Waiting for broker',
    PENDING_ORDER: 'Entry pending',
    PENDING_EXIT: 'Close pending',
    PENDING_TRIM: 'Trim pending',
    EXIT_STALE: 'Needs broker check',
    EXIT_REJECTED: 'Broker rejected exit',
    EXIT_FAILED: 'Exit failed',
    EXIT_CANCELED: 'Exit cancelled',
    EXIT_CANCELLED: 'Exit cancelled',
    EXIT_EXPIRED: 'Exit expired'
  };
  return labels[status] || String(value || 'N/A').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
};

const nextActionButtonLabel = (label: string) => {
  const normalized = label.toLowerCase();
  if (normalized.includes('broker') || normalized.includes('verify') || normalized.includes('sync')) return 'Refresh broker proof';
  if (normalized.includes('retry')) return 'Review retry path';
  if (normalized.includes('close')) return 'Open trades';
  return 'Refresh status';
};

function SummaryTile({ label, value, detail, icon: Icon }: { label: string; value: string; detail?: string; icon: any }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 truncate font-mono text-lg font-semibold">{value}</div>
          {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
        </div>
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[65%] truncate text-right font-mono text-xs">{value ?? '-'}</span>
    </div>
  );
}

function EventItem({ event }: { event: TradeEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusTone(event.event_type)}>{event.event_type.replace(/_/g, ' ')}</Badge>
            <span className="text-xs text-muted-foreground">{compactDate(event.created_at)}</span>
          </div>
          <div className="mt-2 text-sm">{event.message || 'Event recorded'}</div>
        </div>
        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <Button variant="outline" size="sm" className="h-8 gap-2" onClick={() => setExpanded(!expanded)}>
            <FileJson className="h-3.5 w-3.5" />
            {expanded ? 'Hide' : 'Replay'}
          </Button>
        )}
      </div>
      {expanded && (
        <pre className="mt-3 max-h-[360px] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
          {JSON.stringify(event.metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function TradeCommandCenterPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<TradeCommandCenterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (silent = false) => {
    if (!id) return;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setData(await api.getTradeCommandCenter(Number(id)));
    } catch (err: any) {
      setError(err.message || 'Failed to load command center');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const pnl = useMemo(() => {
    if (!data) return 0;
    const exitOrCurrent = Number(data.trade.exit_price || data.trade.current_price || data.trade.entry_price || 0);
    return (exitOrCurrent - Number(data.trade.entry_price || 0)) * Number(data.trade.quantity || 1) * 100;
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto w-[95%] max-w-[1200px] py-6">
        <Button asChild variant="ghost" className="mb-4 gap-2 pl-0">
          <Link to="/trades"><ArrowLeft className="h-4 w-4" /> Back to Trades</Link>
        </Button>
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error || 'Trade command center not found'}
        </div>
      </div>
    );
  }

  const { trade, signal, nextAction, riskPlan, brokerProof, events } = data;

  return (
    <div className="mx-auto w-[95%] max-w-[1500px] py-4">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="rounded-full">
            <Link to="/trades">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{contractLabel(trade)}</h2>
              <Badge variant={statusTone(trade.execution_status || trade.status)}>{humanStatus(trade.execution_status || trade.status)}</Badge>
              {signal?.setup_grade && <Badge variant="outline">Setup {signal.setup_grade}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">Decision replay, broker proof, risk plan, and lifecycle timeline.</p>
          </div>
        </div>
        <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="mb-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            {nextAction.label.toLowerCase().includes('broker') || nextAction.label.toLowerCase().includes('verify')
              ? <Siren className="mt-0.5 h-5 w-5 text-amber-500" />
              : <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-500" />}
            <div>
              <div className="font-semibold">{nextAction.label}</div>
              <div className="text-sm text-muted-foreground">{nextAction.detail}</div>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className={`font-mono text-lg font-semibold ${pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{currency(pnl)}</div>
            <Button
              asChild={nextAction.label.toLowerCase().includes('close')}
              size="sm"
              variant={nextAction.label.toLowerCase().includes('broker') || nextAction.label.toLowerCase().includes('verify') ? 'default' : 'outline'}
              className="gap-2"
              onClick={nextAction.label.toLowerCase().includes('close') ? undefined : () => load(true)}
              disabled={refreshing}
            >
              {nextAction.label.toLowerCase().includes('close') ? (
                <Link to="/trades">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {nextActionButtonLabel(nextAction.label)}
                </Link>
              ) : (
                <>
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  {nextActionButtonLabel(nextAction.label)}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <SummaryTile label="Entry" value={currency(riskPlan.entryPrice)} detail={`${riskPlan.quantity} contract(s)`} icon={BadgeDollarSign} />
        <SummaryTile label="Stop Loss" value={currency(riskPlan.stopLoss)} detail={riskPlan.estimatedMaxLoss !== null ? `Max loss ${currency(riskPlan.estimatedMaxLoss)}` : 'No premium stop'} icon={Siren} />
        <SummaryTile label="Take Profit" value={currency(riskPlan.takeProfit)} detail={riskPlan.trim.status ? `Trim ${riskPlan.trim.status}` : 'Primary target'} icon={Target} />
        <SummaryTile label="Broker Sync" value={humanStatus(brokerProof.lastBrokerStatus)} detail={compactDate(brokerProof.lastBrokerSyncAt)} icon={Workflow} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <BrainCircuit className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Decision Snapshot</h3>
          </div>
          <DetailRow label="Signal" value={signal ? `#${signal.id} ${signal.signal_type}` : 'Not linked'} />
          <DetailRow label="Bias" value={signal?.trade_bias || '-'} />
          <DetailRow label="Confidence" value={signal?.confidence_score != null ? `${signal.confidence_score}%` : '-'} />
          <DetailRow label="Grade" value={signal?.setup_grade || '-'} />
          <DetailRow label="Signal entry" value={currency(signal?.entry_trigger)} />
          <DetailRow label="Signal SL" value={currency(signal?.stop_loss)} />
          <DetailRow label="Signal target" value={currency(signal?.target_price)} />
          <DetailRow label="Created" value={compactDate(signal?.created_at)} />
        </section>

        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Broker Proof</h3>
          </div>
          <DetailRow label="Broker" value={brokerProof.broker} />
          <DetailRow label="Account" value={brokerProof.accountId} />
          <DetailRow label="Entry order" value={brokerProof.entryOrderId} />
          <DetailRow label="Entry trade" value={brokerProof.entryTradeId} />
          <DetailRow label="Exit order" value={brokerProof.exitOrderId} />
          <DetailRow label="Trim order" value={brokerProof.trimOrderId} />
          <DetailRow label="Execution" value={humanStatus(brokerProof.executionStatus)} />
        </section>

        <section className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Plan State</h3>
          </div>
          <DetailRow label="Status" value={humanStatus(trade.status)} />
          <DetailRow label="Exit reason" value={trade.exit_reason} />
          <DetailRow label="Exit type" value={trade.exit_order_type} />
          <DetailRow label="Exit requested" value={compactDate(trade.exit_requested_at)} />
          <DetailRow label="Trim fill" value={riskPlan.trim.price ? `${currency(riskPlan.trim.price)} x ${riskPlan.trim.quantity}` : '-'} />
          <DetailRow label="Underlying SL" value={currency(riskPlan.underlyingPlan.stop)} />
          <DetailRow label="Underlying TP" value={currency(riskPlan.underlyingPlan.target)} />
          <DetailRow label="MFE" value={riskPlan.mfePct == null ? '-' : `${Number(riskPlan.mfePct).toFixed(2)}%`} />
          <DetailRow label="MAE" value={riskPlan.maePct == null ? '-' : `${Number(riskPlan.maePct).toFixed(2)}%`} />
        </section>
      </div>

      <section className="rounded-md border border-border bg-muted/20 p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Decision Replay Timeline</h3>
          </div>
          <Badge variant="outline">{events.length} event{events.length === 1 ? '' : 's'}</Badge>
        </div>
        {events.length === 0 ? (
          <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No replay events have been recorded for this trade yet. New entries, fills, trims, exits, and broker sync outcomes will appear here.
          </div>
        ) : (
          <div className="space-y-3">
            {events.map((event) => <EventItem key={event.id} event={event} />)}
          </div>
        )}
      </section>

      {signal?.option_details && (
        <section className="mt-4 rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Option Details Snapshot</h3>
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
            {JSON.stringify(signal.option_details, null, 2)}
          </pre>
        </section>
      )}

      {brokerProof.executionError && (
        <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {brokerProof.executionError}
        </div>
      )}
      {trade.status === 'CLOSED' && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          Final state recorded at {compactDate(trade.updated_at)}.
        </div>
      )}
    </div>
  );
}
