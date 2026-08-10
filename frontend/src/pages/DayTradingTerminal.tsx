import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Loader2,
  Play,
  Radar,
  RefreshCw,
  ShieldCheck,
  X
} from 'lucide-react';
import {
  QUERY_KEYS,
  usePositions,
  usePaperAccount,
  useSettings,
  useSignals,
  useStrategyHistory,
  useStrategyState,
  useTradeUsage
} from '@/hooks/useDashboardData';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, OptionDetailsJSON, PaperAccountSummary, Position, Signal, SignalRiskAssessment, StrategyHistorySetup } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';

type LifecycleTone = 'idle' | 'armed' | 'active' | 'manage' | 'complete' | 'blocked';
type ServicesHealth = Awaited<ReturnType<typeof api.getServicesHealth>>;
const MAX_GEX_PROVIDER_AGE_SECONDS = 120;
const BROWSER_SETUP_ALERTS_KEY = 'day-trading-browser-setup-alerts';

const dateInNewYork = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(date);

const isExpiredOption = (expiration: unknown) => {
  const value = String(expiration || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value < dateInNewYork();
};

const money = (value: unknown, decimals = 2) => {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(decimals)}` : '—';
};

const number = (value: unknown, decimals = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : '—';
};

const integer = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString('en-US') : '—';
};

const etMinute = (value: unknown) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 24 * 60) return '—';
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
};

const time = (value?: string | number | null) => {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : '—';
};

const dateTime = (value?: string | number | null) => {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';
};

const duration = (startValue?: string | null, endValue?: string | null) => {
  const start = startValue ? new Date(startValue).getTime() : Number.NaN;
  const end = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'duration unavailable';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

const relativeAge = (seconds: unknown) => {
  const age = Number(seconds);
  if (!Number.isFinite(age)) return 'No snapshot';
  if (age < 0) return 'Clock skew';
  if (age < 1) return 'Live';
  if (age < 60) return `${age.toFixed(1)}s ago`;
  return `${Math.round(age / 60)}m ago`;
};

const compactAge = (milliseconds: unknown) => {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return 'age unavailable';
  return relativeAge(value / 1000);
};

const gexAgeSeconds = (signal: Record<string, any> | null) => {
  const direct = Number(signal?.gex?.provider_age_seconds);
  if (signal?.gex?.provider_age_seconds != null && Number.isFinite(direct)) return direct;
  const shadow = signal?.zerogex_shadow || {};
  const shadowAge = Number(shadow.provider_age_seconds);
  if (shadow.provider_age_seconds != null && Number.isFinite(shadowAge)) return shadowAge;
  const freshness = shadow.data_freshness?.gex_summary || {};
  const freshnessAge = Number(freshness.adjusted_age_seconds ?? freshness.age_seconds);
  if (Number.isFinite(freshnessAge)) return freshnessAge;
  const timestamp = Number(signal?.gex?.provider_timestamp || signal?.gex?.fetched_at);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.max(0, Date.now() / 1000 - timestamp) : Number.NaN;
};

const contractName = (option: OptionDetailsJSON | Record<string, any>, side: string | null) => (
  option.ticker || option.local_symbol || (side ? `SPY ${side}` : 'No contract selected')
);

const optionExpiryLabel = (expiryValue: unknown) => {
  const expiry = String(expiryValue || '').trim();
  const normalizedExpiry = /^\d{8}$/.test(expiry)
    ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`
    : /^\d{6}$/.test(expiry)
      ? `20${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`
      : expiry.slice(0, 10);
  const expiryDate = normalizedExpiry ? new Date(`${normalizedExpiry}T12:00:00`) : null;
  const expiryLabel = expiryDate && Number.isFinite(expiryDate.getTime())
    ? expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'expiry unavailable';
  return expiryLabel;
};

const humanContractName = (option: OptionDetailsJSON | Record<string, any>, side: string | null) => {
  const expiryLabel = optionExpiryLabel(option.expiry);
  const strike = Number(option.strike);
  const strikeLabel = Number.isFinite(strike) ? `$${strike.toFixed(2).replace(/\.00$/, '')}` : 'strike unavailable';
  const sideLabel = side ? `${side[0]}${side.slice(1).toLowerCase()}` : 'option';
  return `SPY ${strikeLabel} ${sideLabel} · ${expiryLabel}`;
};

const optionSpreadPct = (option: OptionDetailsJSON | Record<string, any>) => {
  const supplied = Number(option.spreadPct ?? option.spread_pct);
  if ((option.spreadPct != null || option.spread_pct != null) && Number.isFinite(supplied)) return supplied;
  const bid = Number(option.bid);
  const ask = Number(option.ask);
  const midpoint = (bid + ask) / 2;
  return bid > 0 && ask >= bid && midpoint > 0 ? ((ask - bid) / midpoint) * 100 : Number.NaN;
};

const levelDistance = (spot: unknown, level: unknown) => {
  const current = Number(spot);
  const target = Number(level);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return '—';
  const distance = target - current;
  return `${distance >= 0 ? '+' : '−'}$${Math.abs(distance).toFixed(2)}`;
};

const lifecycleTone = (state: string): LifecycleTone => {
  if (state === 'ACTIVE') return 'active';
  if (state === 'MANAGE' || state === 'EXTENDED') return 'manage';
  if (state === 'ARMED') return 'armed';
  if (state === 'COMPLETED') return 'complete';
  if (['INVALIDATED', 'TRACKING_ABORTED', 'FAILED'].includes(state)) return 'blocked';
  return 'idle';
};

const toneClasses: Record<LifecycleTone, string> = {
  idle: 'border-zinc-800 bg-zinc-900/55 text-zinc-300',
  armed: 'border-amber-500/30 bg-amber-950/15 text-amber-200',
  active: 'border-emerald-500/35 bg-emerald-950/20 text-emerald-100',
  manage: 'border-sky-500/35 bg-sky-950/20 text-sky-100',
  complete: 'border-teal-500/30 bg-teal-950/20 text-teal-100',
  blocked: 'border-rose-500/30 bg-rose-950/15 text-rose-100'
};

const stateCopy = (state: string, side: string | null, autonomousEntry = false) => {
  switch (state) {
    case 'ORDER_SUBMITTING':
      return {
        eyebrow: 'Order submission',
        title: 'Submitting protected order',
        description: 'StrikePilot is sending this entry to the broker. Do not retry or place a manual duplicate while submission is in progress.'
      };
    case 'ORDER_SUBMITTED':
      return {
        eyebrow: 'Broker reconciliation',
        title: 'Order submitted',
        description: 'The entry request has left StrikePilot. Wait for broker confirmation before treating it as filled or placing another order.'
      };
    case 'POSITION_OPEN':
      return {
        eyebrow: 'Position active',
        title: `${side || 'Directional'} position is open`,
        description: 'The broker position is linked. Monitor its protected exit state and do not place a duplicate entry.'
      };
    case 'EXECUTION_REVIEW':
      return {
        eyebrow: 'Broker review required',
        title: 'Execution needs review',
        description: 'StrikePilot cannot confirm a clean broker state. Verify the order before retrying or placing another entry.'
      };
    case 'ENTRY_SKIPPED':
      return {
        eyebrow: 'Entry not submitted',
        title: 'No broker order was placed',
        description: 'The autonomous evaluation stopped before submission. Review the recorded reason and wait for the next eligible setup.'
      };
    case 'ARMED':
      return {
        eyebrow: 'Setup forming',
        title: `${side || 'Directional'} setup armed`,
        description: 'The plan is frozen. Entry remains locked until every confirmation is live.'
      };
    case 'ACTIVE':
      return {
        eyebrow: 'Entry window',
        title: `${side || 'Directional'} entry is active`,
        description: autonomousEntry
          ? 'The backend is evaluating the one-contract autonomous entry against every live risk gate.'
          : 'Review the planned contract and confirm this order while the snapshot remains fresh.'
      };
    case 'MANAGE':
    case 'EXTENDED':
      return {
        eyebrow: 'Position management',
        title: `${side || 'Directional'} trade is being managed`,
        description: 'The strategy now owns invalidation protection and target progression.'
      };
    case 'COMPLETED':
      return {
        eyebrow: 'Lifecycle complete',
        title: 'Strategy target completed',
        description: 'The setup is closed to new entries and the linked position is exiting or reconciled.'
      };
    case 'INVALIDATED':
    case 'TRACKING_ABORTED':
    case 'FAILED':
      return {
        eyebrow: 'Setup closed',
        title: state === 'INVALIDATED' ? 'Strategy invalidated' : 'Strategy tracking stopped',
        description: 'No new order is allowed. Review the exit and broker reconciliation state.'
      };
    case 'DISMISSED':
      return {
        eyebrow: 'Account state',
        title: 'Setup closed for this account',
        description: 'No order can be placed from this setup. Wait for the strategy engine to publish a new qualified setup.'
      };
    default:
      return {
        eyebrow: 'Market watch',
        title: 'Waiting for a qualified SPY setup',
        description: 'No action is required. The strategy will surface one plan when its gates align.'
      };
  }
};

const optionSide = (strategySignal: Record<string, any> | null) => {
  if (strategySignal?.favoring === 'calls') return 'CALL';
  if (strategySignal?.favoring === 'puts') return 'PUT';
  return null;
};

const strategyDisplay = (strategy?: string | null) => {
  const code = String(strategy || '').trim().toUpperCase();
  const strategies: Record<string, { name: string; explanation: string }> = {
    MTF_TREND_BREAK: {
      name: 'Multi-timeframe trend breakout',
      explanation: 'The 5-minute, 15-minute, and 1-hour trends point in the same direction, with SPY on the confirming side of VWAP.'
    },
    MTF_REVERSAL: {
      name: 'Multi-timeframe reversal',
      explanation: 'Short- and longer-term price structure aligned around a potential change in direction.'
    },
    GEX_REJECTION: {
      name: 'GEX level rejection',
      explanation: 'SPY rejected a fresh gamma level with confirmation from the 5-minute and 15-minute trends.'
    },
    CONTINUATION: {
      name: 'Trend continuation',
      explanation: 'SPY is attempting to resume the established move after holding its continuation structure.'
    }
  };
  return strategies[code] || {
    name: code ? code.toLowerCase().replace(/_/g, ' ') : 'Strategy setup',
    explanation: 'The configured strategy confirmation gates produced this setup.'
  };
};

const getExecutionMode = (settings: Record<string, string>) => {
  if (settings.shadow_trading_enabled === 'true') {
    return { label: 'Shadow simulation', live: false, autonomous: false };
  }
  if (settings.execution_broker === 'wealthsimple_snaptrade' && settings.snaptrade_auto_trade === 'true') {
    const autonomous = settings.autonomous_live_entry_enabled === 'true'
      && settings.live_trading_acknowledged === 'true'
      && Boolean(settings.snaptrade_trading_account_id);
    return { label: autonomous ? 'Wealthsimple auto' : 'Wealthsimple live', live: true, autonomous };
  }
  return { label: 'Simulation · live off', live: false, autonomous: false };
};

const Metric = ({
  label,
  value,
  detail,
  tooltip,
  tone = 'text-zinc-100'
}: {
  label: string;
  value: string;
  detail?: string;
  tooltip?: string;
  tone?: string;
}) => (
  <div className="min-w-0 py-2" title={tooltip}>
    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</div>
    <div className={`mt-1 truncate font-mono text-sm font-semibold tabular-nums ${tone}`} title={value}>{value}</div>
    {detail && <div className="mt-0.5 truncate text-[10px] text-zinc-500" title={detail}>{detail}</div>}
  </div>
);

const CompactRiskMetric = ({ label, value, tone = 'text-zinc-100' }: { label: string; value: string; tone?: string }) => (
  <div className="min-w-0 rounded-md bg-zinc-950/45 px-2 py-1.5 sm:bg-transparent sm:px-2">
    <div className="truncate text-[9px] font-medium uppercase tracking-[0.1em] text-zinc-600">{label}</div>
    <div className={`mt-0.5 truncate font-mono text-xs font-semibold tabular-nums ${tone}`} title={value}>{value}</div>
  </div>
);

const LevelRail = ({
  potential,
  levels
}: {
  potential: boolean;
  levels: Array<{ label: string; value: unknown; tone: string; dot: string }>;
}) => (
  <div className="mt-5 rounded-lg border border-zinc-800/80 bg-black/15 px-2 py-3 sm:mt-6 sm:px-4">
    <div className="mb-3 flex items-center justify-between gap-3 px-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        {potential ? 'Potential level plan' : 'Active level plan'}
      </span>
      <span className="hidden text-[10px] text-zinc-500 sm:block">Stop → Spot → Trigger → T1 → T2</span>
    </div>
    <div className="relative grid grid-cols-5 gap-1 before:absolute before:left-[10%] before:right-[10%] before:top-[1.55rem] before:h-px before:bg-zinc-700">
      {levels.map(level => (
        <div key={level.label} className="relative z-10 min-w-0 text-center">
          <div className="truncate text-[10px] font-medium text-zinc-500">{level.label}</div>
          <span className={`mx-auto mt-1.5 block h-2.5 w-2.5 rounded-full border-2 border-[#101216] ${level.dot}`} />
          <div className={`mt-1.5 truncate font-mono text-xs font-semibold tabular-nums sm:text-sm ${level.tone}`} title={money(level.value)}>
            {money(level.value)}
          </div>
        </div>
      ))}
    </div>
  </div>
);

const PlannedEntryTicket = ({
  option,
  side,
  quantity,
  plannedLimit,
  orderDebit,
  quoteAge
}: {
  option: OptionDetailsJSON | Record<string, any>;
  side: string | null;
  quantity: number;
  plannedLimit: number;
  orderDebit: number;
  quoteAge: number;
}) => {
  const quoteFresh = Number.isFinite(quoteAge) && quoteAge >= 0 && quoteAge <= 15;
  const spreadPct = optionSpreadPct(option);
  return (
    <div className="mt-4 rounded-lg border border-zinc-700/80 bg-zinc-950/55 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Planned entry ticket</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{humanContractName(option, side)}</div>
          <div className="mt-1 select-all break-all font-mono text-[10px] text-zinc-500" title="Contract symbol">{contractName(option, side)}</div>
        </div>
        <span className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold ${
          quoteFresh
            ? 'border-emerald-500/25 bg-emerald-950/30 text-emerald-300'
            : 'border-rose-500/25 bg-rose-950/30 text-rose-300'
        }`}>
          {quoteFresh ? `${number(quoteAge, 1)}s fresh` : 'Quote stale'}
        </span>
      </div>
      <div className="mt-3 border-t border-zinc-800 pt-2">
        <div className="font-mono text-xs font-semibold tabular-nums text-zinc-200">
          {quantity} contract{quantity === 1 ? '' : 's'} · {money(plannedLimit)} limit · {orderDebit > 0 ? money(orderDebit) : '—'} max debit
        </div>
        <div className="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
          {money(option.bid)} bid / {money(option.ask)} ask · {Number.isFinite(spreadPct) ? `${number(spreadPct)}% spread` : 'spread unavailable'}
        </div>
      </div>
      <div className="mt-2 text-[10px] text-zinc-600">Protected limit order only</div>
    </div>
  );
};

const PositionSummary = ({
  position,
  option,
  side,
  spot,
  invalidation,
  target
}: {
  position: Position;
  option: OptionDetailsJSON | Record<string, any>;
  side: string | null;
  spot: unknown;
  invalidation: unknown;
  target: unknown;
}) => {
  const entry = Number(position.entry_price || 0);
  const current = Number(position.current_price || entry);
  const spotPrice = Number(spot);
  const premiumMappedToSpot = Number.isFinite(spotPrice)
    && Math.abs(current - spotPrice) < 0.01
    && current > Math.max(entry * 10, 25);
  const openPnl = premiumMappedToSpot ? null : (current - entry) * Number(position.quantity || 0) * 100;
  const exactContract = option.ticker || option.local_symbol || `${position.symbol} ${position.option_type} ${money(position.strike_price)}`;
  const simulated = position.is_simulated === true || position.execution_broker === 'simulated';
  const positionContract = humanContractName({
    ...option,
    strike: position.strike_price || option.strike,
    expiry: position.expiration_date || option.expiry
  }, position.option_type || side);
  const positionBroker = position.execution_broker === 'wealthsimple_snaptrade'
    ? 'Wealthsimple / SnapTrade'
    : position.execution_broker || 'broker unavailable';
  return (
    <section className="rounded-xl border border-sky-500/25 bg-sky-950/10 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-300">
            {simulated ? 'Shadow strategy position' : 'Linked autonomous position'}
          </div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{positionContract}</div>
          <div className="mt-1 select-all break-all font-mono text-[10px] text-zinc-500" title="Contract symbol">{exactContract}</div>
          <div className="mt-1 text-xs text-zinc-500">
            {position.quantity} contract{Number(position.quantity) === 1 ? '' : 's'} · {simulated ? 'simulation only' : positionBroker}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className={`font-mono text-xl font-semibold tabular-nums ${openPnl === null ? 'text-amber-300' : openPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {openPnl === null ? '—' : `${openPnl >= 0 ? '+' : ''}${money(openPnl)}`}
          </div>
          <div className="text-[10px] text-zinc-500">{openPnl === null ? 'awaiting option quote' : 'estimated open P&L'}</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 border-t border-sky-500/15 pt-3 sm:grid-cols-5">
        <Metric label="Entry premium" value={money(position.entry_price)} />
        <Metric label="Current premium" value={premiumMappedToSpot ? 'Unavailable' : money(position.current_price)} />
        <Metric label="SPY now" value={money(spot)} />
        <Metric label="Invalidation" value={money(invalidation)} detail={levelDistance(spot, invalidation)} tone="text-rose-200" />
        <Metric label="Target" value={money(target)} detail={levelDistance(spot, target)} tone="text-sky-200" />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/15 bg-zinc-950/40 px-3 py-2 text-[10px]">
        <span className="text-zinc-500">Broker state <span className="font-mono text-zinc-200">{position.execution_status || position.last_broker_order_status || position.status}</span></span>
        <span className="text-zinc-500">Lifecycle <span className="font-mono text-zinc-200">{position.strategy_lifecycle_status || 'MANAGE'}</span></span>
        <Link to={`/positions/${position.id}`} className="font-semibold text-sky-300 transition-colors hover:text-sky-200">Open details →</Link>
      </div>
      {premiumMappedToSpot && (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          The last stored option premium matched SPY spot and was rejected as invalid. Waiting for an exact IBKR contract quote.
        </div>
      )}
      {position.execution_error && (
        <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
          {position.execution_error}
        </div>
      )}
    </section>
  );
};

const HistorySetupCard = ({ setup }: { setup: StrategyHistorySetup }) => {
  const option = setup.option_details || {};
  const strategy = strategyDisplay(setup.strategy_name);
  const terminalEvent = [...setup.lifecycle_events].reverse().find(event => event.closeReason || ['COMPLETED', 'INVALIDATED', 'FAILED', 'TRACKING_ABORTED'].includes(event.status));
  const finalEvent = setup.lifecycle_events[setup.lifecycle_events.length - 1];
  const plannedQuantity = Number(option.planned_contracts || setup.contracts_requested || 0);
  const plannedPrice = Number(option.planned_limit_price || option.mark || 0);
  const plannedDebit = Number(option.planned_total_debit || (plannedQuantity > 0 && plannedPrice > 0 ? plannedQuantity * plannedPrice * 100 : 0));
  const outcome = setup.position_status === 'CLOSED'
    ? setup.realized_pnl == null ? 'Closed' : setup.realized_pnl >= 0 ? 'Closed · profit' : 'Closed · loss'
    : setup.execution_status
      ? setup.execution_status
      : setup.lifecycle_status;
  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950/45">
      <summary className="grid cursor-pointer list-none gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${setup.side === 'CALL' ? 'bg-emerald-950/50 text-emerald-300' : 'bg-rose-950/50 text-rose-300'}`}>{setup.side}</span>
            <span className="truncate text-xs font-semibold text-zinc-200">{strategy.name}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={contractName(option, setup.side)}>{contractName(option, setup.side)}</div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-[10px]">
          <div><div className="text-zinc-600">Trigger</div><div className="mt-0.5 font-mono text-zinc-300">{money(setup.entry_trigger)}</div></div>
          <div><div className="text-zinc-600">Stop</div><div className="mt-0.5 font-mono text-rose-300">{money(setup.invalidation)}</div></div>
          <div><div className="text-zinc-600">Target</div><div className="mt-0.5 font-mono text-sky-300">{money(setup.target)}</div></div>
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <div className="text-right">
            <div className="text-[10px] font-semibold text-zinc-300">{outcome}</div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-600">{dateTime(setup.created_at)}</div>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-open:rotate-180" />
        </div>
      </summary>
      <div className="border-t border-zinc-800 px-3 py-3">
        <div className="mb-3 rounded-md border border-zinc-800 bg-black/15 px-2.5 py-2 text-[10px] leading-relaxed text-zinc-400">
          <span className="font-semibold text-zinc-300">Why it appeared:</span> {strategy.explanation}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md bg-black/20 p-2.5 text-[10px] text-zinc-500">
            <div>Plan</div>
            <div className="mt-1 font-mono text-xs text-zinc-200">{plannedQuantity || '—'} × {money(plannedPrice)}</div>
            <div className="mt-1">Debit {plannedDebit > 0 ? money(plannedDebit) : '—'}</div>
          </div>
          <div className="rounded-md bg-black/20 p-2.5 text-[10px] text-zinc-500">
            <div>Execution</div>
            <div className="mt-1 font-mono text-xs text-zinc-200">{setup.execution_status || setup.user_execution_status || 'Not submitted'}</div>
            <div className="mt-1">{setup.execution_broker || 'No broker order'}</div>
          </div>
          <div className="rounded-md bg-black/20 p-2.5 text-[10px] text-zinc-500">
            <div>Result</div>
            <div className={`mt-1 font-mono text-xs ${setup.realized_pnl == null ? 'text-zinc-200' : setup.realized_pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {setup.realized_pnl == null ? setup.position_status || 'No position' : `${setup.realized_pnl >= 0 ? '+' : ''}${money(setup.realized_pnl)}`}
            </div>
            <div className="mt-1">{terminalEvent?.closeReason?.replace(/_/g, ' ') || 'No close reason recorded'} · {duration(setup.created_at, finalEvent?.createdAt || setup.position_updated_at)}</div>
          </div>
        </div>
        <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Lifecycle timeline</div>
        <div className="mt-2 space-y-0">
          {setup.lifecycle_events.length > 0 ? setup.lifecycle_events.map((event, index) => (
            <div key={event.id} className="grid grid-cols-[0.8rem_4.5rem_1fr] gap-2 text-[10px]">
              <div className="relative flex justify-center">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-sky-400" />
                {index < setup.lifecycle_events.length - 1 && <span className="absolute bottom-0 top-2 w-px bg-zinc-800" />}
              </div>
              <div className="pb-2 font-mono text-zinc-600">{time(event.createdAt)}</div>
              <div className="pb-2 text-zinc-300">
                <span className="font-semibold">{event.state || event.status}</span>
                {event.targetsHit > 0 ? ` · target ${event.targetsHit} hit` : ''}
                {event.closeReason ? ` · ${event.closeReason.replace(/_/g, ' ')}` : ''}
                {!event.closeReason && event.blockers?.[0] ? <div className="mt-0.5 text-zinc-600">{event.blockers[0]}</div> : null}
              </div>
            </div>
          )) : <div className="text-xs text-zinc-600">No lifecycle events were recorded for this setup.</div>}
        </div>
        {setup.execution_error && <div className="mt-2 rounded-md border border-rose-500/20 bg-rose-950/15 px-2.5 py-2 text-xs text-rose-200">{setup.execution_error}</div>}
      </div>
    </details>
  );
};

const DiagnosticRow = ({ label, status, age, detail, next }: { label: string; status: string; age?: string; detail: string; next: string }) => {
  const normalized = status.toUpperCase();
  const healthy = ['UP', 'OK', 'CONNECTED', 'LIVE'].includes(normalized);
  const informational = ['IDLE', 'MARKET_CLOSED', 'N/A'].includes(normalized);
  return (
    <div className="border-b border-zinc-800/70 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        <span className={`font-mono text-[10px] font-semibold ${healthy ? 'text-emerald-300' : informational ? 'text-zinc-400' : 'text-amber-300'}`}>{normalized}</span>
      </div>
      <div className="mt-1 flex items-start justify-between gap-3 text-[10px] leading-relaxed text-zinc-600">
        <span>{detail}</span>
        {age && <span className="shrink-0 font-mono">{age}</span>}
      </div>
      {!healthy && !informational && <div className="mt-1 text-[10px] leading-relaxed text-amber-300/80">Next: {next}</div>}
    </div>
  );
};

export default function DayTradingTerminal() {
  const queryClient = useQueryClient();
  const { isConnected, lastMessage } = useWebSocket();
  const { data: signals = [], isLoading: signalsLoading, refetch: refetchSignals } = useSignals(5000);
  const {
    data: strategyState,
    dataUpdatedAt: strategyStateUpdatedAt,
    refetch: refetchStrategy
  } = useStrategyState(isConnected ? 10000 : 1000);
  const { data: settings = {} } = useSettings();
  const { data: tradeUsage } = useTradeUsage();
  const { data: positions = [] } = usePositions(5000);
  const { data: paperAccount, refetch: refetchPaperAccount } = usePaperAccount(5000);
  const { data: strategyHistory = [], isLoading: historyLoading, error: historyError, refetch: refetchHistory } = useStrategyHistory(15000);
  const [services, setServices] = useState<ServicesHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [executeSignal, setExecuteSignal] = useState<Signal | null>(null);
  const [dismissSignal, setDismissSignal] = useState<Signal | null>(null);
  const [executing, setExecuting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [browserAlertsEnabled, setBrowserAlertsEnabled] = useState(() => (
    typeof window !== 'undefined'
    && typeof Notification !== 'undefined'
    && Notification.permission === 'granted'
    && window.localStorage.getItem(BROWSER_SETUP_ALERTS_KEY) === 'true'
  ));
  const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [riskAssessment, setRiskAssessment] = useState<SignalRiskAssessment | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [paperUpdating, setPaperUpdating] = useState(false);
  const [paperClosePosition, setPaperClosePosition] = useState<PaperAccountSummary['openPositions'][number] | null>(null);
  const [paperClosing, setPaperClosing] = useState(false);
  const [paperForceCloseAvailable, setPaperForceCloseAvailable] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [paperExpanded, setPaperExpanded] = useState(false);
  const [paperTransactionsExpanded, setPaperTransactionsExpanded] = useState(true);
  const [aiReviewExpanded, setAiReviewExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const riskRequestRef = useRef(0);
  const lastAlertStateRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const strategySignal = strategyState?.signal || null;
  const strategySetupId = strategyState?.setupId || null;
  const currentSignal = useMemo(() => {
    if (!strategySetupId) return null;
    return signals.find(signal => (
      signal.symbol === 'SPY'
      && signal.engine_version === 'signal-only-v2'
      && signal.strategy_setup_id === strategySetupId
    )) || null;
  }, [signals, strategySetupId]);

  const lifecycle = String(
    strategySignal?.state
      || strategySignal?.signal_phase
      || 'WAIT'
  ).toUpperCase();
  const side = optionSide(strategySignal);
  const directionConfirmed = [
    'ARMED', 'ACTIVE', 'MANAGE', 'EXTENDED', 'COMPLETED', 'INVALIDATED', 'TRACKING_ABORTED', 'FAILED'
  ].includes(lifecycle);
  const setup = side === 'PUT'
    ? strategySignal?.put_setup
    : side === 'CALL'
      ? strategySignal?.call_setup
      : null;
  const option = setup?.option || {};
  const baseQuoteAge = setup?.option?.quote_age_seconds == null ? Number.NaN : Number(setup.option.quote_age_seconds);
  const lifecycleData = strategySignal?.lifecycle || {};
  const targets = Array.isArray(setup?.targets) ? setup.targets : [];
  const confirmations = Array.isArray(strategySignal?.confirmations)
    ? strategySignal.confirmations
    : [];
  const strategyBlockers = Array.from(new Set((strategySignal?.blockers || []).filter(Boolean))) as string[];
  const executionMode = getExecutionMode(settings);
  const dayTradingEnabled = settings.day_trading_enabled !== 'false';
  const configuredMaxContracts = executionMode.autonomous ? 1 : Math.max(1, Number(settings.contracts_per_trade || 1));
  const plannedContracts = Math.max(0, Number(option.planned_contracts || 0));
  const orderQuantity = plannedContracts > 0
    ? Math.min(configuredMaxContracts, plannedContracts)
    : configuredMaxContracts;
  const plannedLimit = Number(option.planned_limit_price || option.mark || 0);
  const orderDebit = plannedLimit > 0 && plannedContracts > 0 ? plannedLimit * orderQuantity * 100 : 0;
  const strategyDebitLimit = Number(option.strategy_max_total_debit_dollars || settings.strategy_max_total_debit_dollars || 0);
  const baseSnapshotAge = Number(strategyState?.ageSeconds);
  const snapshotGeneratedAt = Number(strategySignal?.generated_at);
  const timeSinceStateReceipt = strategyStateUpdatedAt > 0
    ? Math.max(0, (clockNow - strategyStateUpdatedAt) / 1000)
    : 0;
  const snapshotAge = Number.isFinite(baseSnapshotAge)
    ? baseSnapshotAge + timeSinceStateReceipt
    : Number.isFinite(snapshotGeneratedAt) && snapshotGeneratedAt > 0
      ? clockNow / 1000 - snapshotGeneratedAt
      : Number.NaN;
  const quoteAge = Number.isFinite(baseQuoteAge)
    ? baseQuoteAge + Math.max(0, snapshotAge)
    : Number.NaN;
  const freshSnapshot = Number.isFinite(snapshotAge) && snapshotAge >= 0 && snapshotAge <= 20;
  const usageRemaining = Number(tradeUsage?.remaining ?? 0);
  const entryAllowed = currentSignal?.entry_allowed === true
    && currentSignal.lifecycle_status === 'ACTIVE'
    && lifecycleData.entry_allowed !== false;
  const signalDismissed = currentSignal?.status === 'CANCELLED';
  const dismissedActionableSetup = signalDismissed && ['ARMED', 'ACTIVE'].includes(lifecycle);
  const liveMissing = executionMode.live
    ? [
        settings.snaptrade_trading_account_id ? null : 'Select a Wealthsimple account',
        settings.live_trading_acknowledged === 'true' ? null : 'Acknowledge live trading'
      ].filter(Boolean) as string[]
    : [];
  const primaryGex = strategySignal?.gex || strategySignal?.zerogex_shadow || {};
  const gexAge = gexAgeSeconds(strategySignal);
  const gexFresh = Number.isFinite(gexAge)
    && gexAge >= 0
    && gexAge <= MAX_GEX_PROVIDER_AGE_SECONDS
    && !primaryGex.error
    && strategySignal?.zerogex_shadow?.fresh !== false;
  const planQuality = setup?.plan_quality || strategySignal?.plan_quality || {};
  const planRewardRisk = Number(planQuality.reward_risk);
  const sessionPolicy = strategySignal?.session_policy || {};
  const executionBlockers = [
    !dayTradingEnabled ? 'Day trading is disabled' : null,
    sessionPolicy.valid !== true || sessionPolicy.is_trading_day !== true
      ? 'Strategy session policy is unavailable or the market is closed'
      : null,
    signalDismissed
      ? 'This setup is cancelled for your account'
      : currentSignal && currentSignal.status !== 'PENDING'
        ? `Signal is ${currentSignal.status.toLowerCase()}`
        : null,
    currentSignal?.execution_status ? `Execution is ${String(currentSignal.execution_status).toLowerCase().replace(/_/g, ' ')}` : null,
    lifecycle !== 'ACTIVE' ? `Lifecycle is ${lifecycle}` : null,
    !entryAllowed ? 'Entry window is not open' : null,
    !freshSnapshot ? 'Strategy snapshot is stale' : null,
    !Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > 15 ? 'Selected option quote is stale or missing' : null,
    !gexFresh ? 'Authoritative GEX snapshot is stale or missing' : null,
    planQuality.meets_minimum !== true || !Number.isFinite(planRewardRisk) || planRewardRisk < 1.5
      ? 'Strategy plan does not meet the 1.50:1 minimum reward/risk'
      : null,
    usageRemaining <= 0 ? 'Daily trade limit reached' : null,
    plannedContracts <= 0 ? 'Strategy has no executable contract quantity' : null,
    ...liveMissing,
    currentSignal?.execution_error || null
  ].filter(Boolean) as string[];
  const canExecute = Boolean(currentSignal && executionBlockers.length === 0);
  const linkedPosition = useMemo(() => positions.find(position => {
    const strategyPosition = position as Position & { signal_id?: number; strategy_setup_id?: string };
    return strategyPosition.status !== 'CLOSED' && strategyPosition.strategy_managed === true && (
      strategyPosition.signal_id === currentSignal?.id
      || (strategySetupId && strategyPosition.strategy_setup_id === strategySetupId)
    );
  }) || null, [positions, currentSignal?.id, strategySetupId]);
  const executionStatus = String(
    linkedPosition?.execution_status
    || linkedPosition?.last_broker_order_status
    || currentSignal?.execution_status
    || ''
  ).toUpperCase();
  const signalExecuted = currentSignal?.status === 'EXECUTED';
  const executionSubmitting = executionStatus === 'SUBMITTING';
  const executionStarted = signalExecuted
    || executionSubmitting
    || Boolean(currentSignal?.broker_order_id || currentSignal?.broker_trade_id)
    || ['PENDING_RECONCILE', 'ACCEPTED', 'PENDING_ORDER', 'PARTIALLY_FILLED', 'FILLED'].includes(executionStatus);
  const executionSkipped = executionStatus === 'SKIPPED';
  const brokerPositionOpen = linkedPosition?.status === 'OPEN';
  const executionNeedsReview = Boolean(
    linkedPosition?.execution_error
    || (!brokerPositionOpen && currentSignal?.execution_error)
    || (executionStatus && (
      ['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'STALE'].some(status => executionStatus.includes(status))
      || executionStatus.includes('RECONCILE_REQUIRED')
    ))
  );
  const entryReviewAvailable = ['ARMED', 'ACTIVE'].includes(lifecycle)
    && (!currentSignal || (currentSignal.status === 'PENDING' && !currentSignal.execution_status));
  const displayLifecycle = executionSkipped
      ? 'ENTRY_SKIPPED'
      : executionNeedsReview
        ? 'EXECUTION_REVIEW'
        : brokerPositionOpen
          ? 'POSITION_OPEN'
          : executionSubmitting
            ? 'ORDER_SUBMITTING'
            : executionStarted
              ? 'ORDER_SUBMITTED'
            : dismissedActionableSetup
              ? 'DISMISSED'
              : lifecycle;
  const lifecycleView = stateCopy(displayLifecycle, side, executionMode.autonomous);
  const currentTone = executionNeedsReview
    ? 'blocked'
    : executionSkipped
      ? 'idle'
      : brokerPositionOpen
        ? 'manage'
        : executionStarted
          ? 'armed'
          : dismissedActionableSetup ? 'blocked' : lifecycleTone(lifecycle);
  const currentStrategyCode = strategySignal?.strategy || null;
  const currentStrategy = strategyDisplay(currentStrategyCode);
  const spot = Number(strategySignal?.spot);
  const marketContext = strategySignal?.market_context || {};
  const vwap = marketContext.vwap == null ? Number.NaN : Number(marketContext.vwap);
  const ema9FiveMinute = marketContext.ema9_5m == null ? Number.NaN : Number(marketContext.ema9_5m);
  const ema21FiveMinute = marketContext.ema21_5m == null ? Number.NaN : Number(marketContext.ema21_5m);
  const fiveMinuteStructure = Number.isFinite(ema9FiveMinute) && Number.isFinite(ema21FiveMinute)
    ? ema9FiveMinute > ema21FiveMinute
      ? 'Bullish'
      : ema9FiveMinute < ema21FiveMinute
        ? 'Bearish'
        : 'Flat'
    : 'Unavailable';
  const spotVsVwap = Number.isFinite(spot) && Number.isFinite(vwap)
    ? `${money(Math.abs(spot - vwap))} ${spot >= vwap ? 'above' : 'below'}`
    : 'Unavailable';
  const trigger = Number(setup?.trigger);
  const invalidation = Number(setup?.invalidation);
  const exitTargetNumber = Math.max(1, Number(strategySignal?.paper_policy?.exit_after_target || 2));
  const targetOne = Number(targets[0]);
  const targetTwo = Number(targets[Math.min(exitTargetNumber, targets.length) - 1]);
  const hasLevelPlan = Boolean(setup) && [
    setup?.trigger,
    setup?.invalidation,
    targets[0],
    targets[Math.min(exitTargetNumber, targets.length) - 1]
  ].some(value => value != null && Number.isFinite(Number(value)));
  const optionSelected = Boolean(
    option.local_symbol
    || option.ticker
    || option.target_strike != null
    || option.strike != null
  );
  const rewardRisk = planRewardRisk;
  const spreadPct = optionSpreadPct(option);
  const rawBrokerName = String(linkedPosition?.execution_broker || currentSignal?.execution_broker || '');
  const brokerName = rawBrokerName === 'wealthsimple_snaptrade'
    ? 'Wealthsimple / SnapTrade'
    : rawBrokerName || (executionMode.live ? 'Wealthsimple / SnapTrade' : 'Simulation');
  const brokerOrderId = linkedPosition?.broker_order_id || currentSignal?.broker_order_id || null;
  const brokerSyncAt = linkedPosition?.last_broker_sync_at || linkedPosition?.updated_at || currentSignal?.created_at || null;
  const autonomousResult = String(strategyState?.autonomousEntry?.lastResult || '').replace(/^User\s+\d+:\s*/i, '');
  const autonomousLastAttemptAt = strategyState?.autonomousEntry?.lastAttemptAt || null;
  const executionMessage = linkedPosition?.execution_error
    || currentSignal?.execution_error
    || autonomousResult
    || null;
  const spotVsTrigger = Number.isFinite(spot) && Number.isFinite(trigger)
    ? `${money(Math.abs(spot - trigger))} ${spot >= trigger ? 'above' : 'below'} trigger`
    : 'trigger distance unavailable';
  const heartbeatSummary = executionSkipped
    ? executionMessage || 'The autonomous evaluation ended without submitting a broker order.'
    : executionNeedsReview
      ? executionMessage || `Broker status ${executionStatus || 'unknown'} requires verification before another entry.`
      : brokerPositionOpen
        ? `The linked ${side || 'directional'} position is open. Entry is closed while broker and strategy management remain active.`
        : executionSubmitting
          ? 'StrikePilot is submitting the protected order. Wait for the broker response and do not retry.'
          : executionStarted
            ? `The order was submitted${executionStatus ? ` with broker status ${executionStatus}` : ''}. Wait for broker fill confirmation before taking another action.`
            : dismissedActionableSetup
              ? `The strategy engine remains ${lifecycle}, but this setup is closed for your account.`
              : lifecycle === 'ACTIVE'
                ? `${canExecute ? '' : `${executionBlockers[0] || 'Entry conditions are incomplete'}. `}SPY is ${spotVsTrigger}; ${money(Math.abs(spot - invalidation))} from invalidation and ${money(Math.abs(targetTwo - spot))} from Target 2.`
                : lifecycle === 'ARMED'
                  ? `The setup is forming. SPY is ${spotVsTrigger}; entry remains locked until every confirmation passes.`
                  : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED'
                    ? linkedPosition
                      ? 'A linked autonomous position is in management. Entry is closed while invalidation and target progression are monitored.'
                      : 'The setup moved into management without an autonomous position linked to your account. Matching manual positions remain manually managed.'
                    : side
                      ? `The strategy currently favors ${side === 'CALL' ? 'calls' : 'puts'}, but no qualified entry exists.${strategyBlockers[0] ? ` Waiting on: ${strategyBlockers[0]}.` : ''} SPY is ${spotVsTrigger}.`
                      : strategyBlockers.includes('SPY 5m structure and VWAP are not aligned')
                        ? `Entry session is open; waiting for 5-minute structure and VWAP alignment. Current view: ${fiveMinuteStructure.toLowerCase()} 5-minute structure, SPY ${spotVsVwap} VWAP.`
                        : 'The strategy is monitoring SPY and has not produced a qualified setup.';
  const heartbeatLabel = executionSkipped
    ? 'Entry skipped'
    : executionNeedsReview
      ? 'Broker review required'
      : brokerPositionOpen
        ? 'Position open'
        : executionSubmitting
          ? 'Submitting order'
          : executionStarted
            ? 'Order submitted'
            : dismissedActionableSetup
              ? 'Closed for your account'
              : canExecute
                ? 'Entry conditions live'
                : lifecycle === 'ACTIVE'
                  ? 'Entry blocked'
                  : lifecycle === 'ARMED'
                    ? 'Setup forming'
                    : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED'
                      ? linkedPosition ? 'Position management' : 'Setup management'
                      : 'Watching SPY';
  const approvalStillCurrent = !executeSignal || executeSignal.id === currentSignal?.id;
  const dismissStillCurrent = !dismissSignal || dismissSignal.id === currentSignal?.id;
  const approvalWindows = [
    20 - snapshotAge,
    15 - quoteAge,
    MAX_GEX_PROVIDER_AGE_SECONDS - gexAge
  ];
  const approvalSecondsRemaining = approvalWindows.every(Number.isFinite)
    ? Math.max(0, Math.floor(Math.min(...approvalWindows)))
    : 0;
  const canConfirmExecution = Boolean(executeSignal && approvalStillCurrent && canExecute && approvalSecondsRemaining > 0);
  const approvalBlocker = !approvalStillCurrent
    ? 'The strategy published a different setup while this review was open.'
    : executionBlockers[0] || (approvalSecondsRemaining <= 0 ? 'The approval data expired.' : null);
  const marketSessionLabel = sessionPolicy.valid !== true
    ? 'Strategy session policy unavailable'
    : sessionPolicy.is_trading_day === false
      ? 'Market closed · non-trading day'
      : `Strategy session · entry cutoff ${etMinute(sessionPolicy.entry_cutoff_minute_et)} ET · flatten ${etMinute(sessionPolicy.flatten_minute_et)} ET`;
  const staleReviewReason = !freshSnapshot
    ? 'Strategy snapshot is stale'
    : !Number.isFinite(gexAge)
      ? 'GEX snapshot age is unavailable'
      : !gexFresh
      ? 'GEX snapshot is stale'
      : null;
  const reviewDataFresh = !staleReviewReason;
  const fetchHealth = async () => {
    try {
      setHealthError(null);
      setServices(await api.getServicesHealth());
    } catch (error: any) {
      setHealthError(error.message || 'Unable to load runtime health');
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([
      refetchSignals(),
      refetchStrategy(),
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions }),
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage }),
      refetchHistory(),
      refetchPaperAccount(),
      fetchHealth()
    ]);
    setRefreshing(false);
  };

  useEffect(() => {
    fetchHealth();
    const timer = window.setInterval(fetchHealth, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    riskRequestRef.current += 1;
    setRiskAssessment(null);
    setRiskError(null);
    setRiskLoading(false);
    setAiReviewExpanded(false);
  }, [currentSignal?.id, currentSignal?.lifecycle_status]);

  const runAdHocRiskReview = async () => {
    if (!currentSignal?.id || settings.day_trading_ai_enabled === 'false' || !reviewDataFresh) return;
    setAiReviewExpanded(true);
    const requestId = ++riskRequestRef.current;
    const signalId = currentSignal.id;
    setRiskLoading(true);
    setRiskError(null);
    try {
      const assessment = await api.getSignalRiskAssessment(signalId);
      if (requestId !== riskRequestRef.current) return;
      setRiskAssessment(assessment);
    } catch (error: any) {
      if (requestId !== riskRequestRef.current) return;
      setRiskError(error.message || 'Fresh AI setup review failed');
    } finally {
      if (requestId === riskRequestRef.current) setRiskLoading(false);
    }
  };

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'STRATEGY_SNAPSHOT_UPDATED' && lastMessage.data) {
      queryClient.setQueryData(QUERY_KEYS.strategyState, lastMessage.data);
    }
    if (lastMessage.type === 'STRATEGY_STATE_CHANGED') {
      if (lastMessage.data) queryClient.setQueryData(QUERY_KEYS.strategyState, lastMessage.data);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyHistory });
    }
    if (['NEW_SIGNAL', 'SIGNAL_UPDATED'].includes(lastMessage.type)) {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    }
    if (['POSITION_UPDATED', 'TRADE_UPDATED'].includes(lastMessage.type)) {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyHistory });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.paperAccount });
    }
    if (lastMessage.type === 'PAPER_POSITION_UPDATED' && lastMessage.data) {
      queryClient.setQueryData<PaperAccountSummary>(QUERY_KEYS.paperAccount, current => {
        if (!current) return current;
        let matched = false;
        const openPositions = current.openPositions.map(position => {
          if (Number(position.id) !== Number(lastMessage.data.positionId)) return position;
          matched = true;
          return {
            ...position,
            current_price: Number(lastMessage.data.currentPrice),
            underlying_price: lastMessage.data.underlyingPrice == null ? position.underlying_price : Number(lastMessage.data.underlyingPrice),
            trailing_high_price: Number(lastMessage.data.trailingHighPrice),
            trailing_stop_loss_pct: Number(lastMessage.data.trailingStopPct),
            suggested_stop_loss: lastMessage.data.suggestedStopLoss == null ? position.suggested_stop_loss : Number(lastMessage.data.suggestedStopLoss),
            analysis_data: lastMessage.data.analysis,
            updated_at: lastMessage.data.updatedAt
          };
        });
        if (!matched) return current;
        const recentPositions = current.recentPositions.map(position => (
          Number(position.id) === Number(lastMessage.data.positionId)
            ? {
                ...position,
                current_price: Number(lastMessage.data.currentPrice),
                underlying_price: lastMessage.data.underlyingPrice == null ? position.underlying_price : Number(lastMessage.data.underlyingPrice),
                trailing_high_price: Number(lastMessage.data.trailingHighPrice),
                trailing_stop_loss_pct: Number(lastMessage.data.trailingStopPct),
                suggested_stop_loss: lastMessage.data.suggestedStopLoss == null ? position.suggested_stop_loss : Number(lastMessage.data.suggestedStopLoss),
                analysis_data: lastMessage.data.analysis,
                updated_at: lastMessage.data.updatedAt
              }
            : position
        ));
        const equity = Number((Number(current.account.cash_balance) + openPositions.reduce(
          (total, position) => total + Number(position.current_price || 0) * Number(position.quantity || 0) * 100,
          0
        )).toFixed(2));
        const startOfDayEquity = Number(current.account.start_of_day_equity);
        return {
          ...current,
          account: {
            ...current.account,
            equity,
            high_water_mark: Math.max(Number(current.account.high_water_mark || 0), equity),
            updated_at: lastMessage.data.updatedAt
          },
          openPositions,
          recentPositions,
          session: {
            ...current.session,
            pnl: Number((equity - startOfDayEquity).toFixed(2)),
            pnlPct: startOfDayEquity > 0
              ? Number((((equity - startOfDayEquity) / startOfDayEquity) * 100).toFixed(2))
              : 0
          },
          health: { ...current.health, lastProcessedAt: lastMessage.data.updatedAt }
        };
      });
    }
    if (lastMessage.type === 'PAPER_ACCOUNT_CHANGED') {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.paperAccount });
    }
  }, [lastMessage, queryClient]);

  useEffect(() => {
    const alertState = `${strategySetupId || 'none'}:${lifecycle}`;
    if (lastAlertStateRef.current === null) {
      lastAlertStateRef.current = alertState;
      return;
    }
    const changed = lastAlertStateRef.current !== alertState;
    lastAlertStateRef.current = alertState;
    if (!changed || !browserAlertsEnabled || !['ARMED', 'ACTIVE'].includes(lifecycle)) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification(`SPY setup ${lifecycle.toLowerCase()}`, {
      body: lifecycle === 'ACTIVE'
        ? `${side || 'Directional'} entry conditions are live. Open the app to review the protected order.`
        : `${side || 'Directional'} setup is forming. Entry remains locked until ACTIVE.`
    });
  }, [browserAlertsEnabled, lifecycle, side, strategySetupId]);

  const toggleBrowserAlerts = async () => {
    if (browserAlertsEnabled) {
      window.localStorage.setItem(BROWSER_SETUP_ALERTS_KEY, 'false');
      setBrowserAlertsEnabled(false);
      setActionMessage({ tone: 'success', text: 'Browser setup alerts disabled.' });
      return;
    }
    if (typeof Notification === 'undefined') {
      setActionMessage({ tone: 'error', text: 'This browser does not support setup notifications.' });
      return;
    }
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      setActionMessage({ tone: 'error', text: 'Browser notification permission was not granted.' });
      return;
    }
    window.localStorage.setItem(BROWSER_SETUP_ALERTS_KEY, 'true');
    setBrowserAlertsEnabled(true);
    setActionMessage({ tone: 'success', text: 'Browser alerts enabled for ARMED and ACTIVE setups.' });
  };

  const togglePaperAutomation = async () => {
    if (!paperAccount?.canManage || paperUpdating) return;
    const shouldActivate = paperAccount.account.automation_status !== 'ACTIVE';
    setPaperUpdating(true);
    setActionMessage(null);
    try {
      await api.setPaperAutomation(shouldActivate);
      await refetchPaperAccount();
      setActionMessage({
        tone: 'success',
        text: `System paper automation ${shouldActivate ? 'resumed' : 'paused'}. Open positions remain protected.`
      });
    } catch (error: any) {
      setActionMessage({ tone: 'error', text: error.message || 'Could not update paper automation.' });
    } finally {
      setPaperUpdating(false);
    }
  };

  const confirmPaperClose = async (force = false) => {
    if (!paperClosePosition || !paperAccount?.canManage || paperClosing) return;
    setPaperClosing(true);
    setActionMessage(null);
    try {
      const result = await api.closePaperPosition(Number(paperClosePosition.id), force);
      setPaperClosePosition(null);
      setPaperForceCloseAvailable(false);
      await refetchPaperAccount();
      setActionMessage({
        tone: 'success',
        text: `Paper position ${result.forced ? 'force ' : ''}closed at ${money(result.fillPrice)} using ${result.priceSource.replace(/_/g, ' ').toLowerCase()}. Realized ${result.realizedPnl >= 0 ? '+' : ''}${money(result.realizedPnl)}.${result.warning ? ` Runtime warning: ${result.warning}` : ''}`
      });
    } catch (error: any) {
      if (!force && error.code === 'PAPER_FRESH_QUOTE_REQUIRED') {
        setPaperForceCloseAvailable(true);
      } else {
        await refetchPaperAccount().catch(() => undefined);
      }
      const diagnostic = error.diagnostic
        ? [error.diagnostic.stage, error.diagnostic.databaseCode, error.diagnostic.constraint].filter(Boolean).join(' · ')
        : '';
      setActionMessage({
        tone: 'error',
        text: `${error.message || 'Could not close the paper position.'}${diagnostic ? ` Diagnostic: ${diagnostic}.` : ''}`
      });
    } finally {
      setPaperClosing(false);
    }
  };

  const requestExecution = () => {
    setActionMessage(null);
    if (!currentSignal || !canExecute) {
      setActionMessage({
        tone: 'error',
        text: executionBlockers[0] || 'This setup is not executable.'
      });
      return;
    }
    setExecuteSignal(currentSignal);
  };

  const confirmExecution = async () => {
    if (!executeSignal) return;
    if (!canConfirmExecution) {
      setActionMessage({ tone: 'error', text: approvalBlocker || 'This order review expired. Refresh the setup before trying again.' });
      return;
    }
    setExecuting(true);
    setActionMessage(null);
    try {
      const result = await api.updateSignalStatus(executeSignal.id, 'EXECUTED');
      setActionMessage({
        tone: 'success',
        text: result.execution_status
          ? `Order accepted: ${result.execution_status}`
          : 'Execution request accepted.'
      });
      setExecuteSignal(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage })
      ]);
    } catch (error: any) {
      setActionMessage({ tone: 'error', text: error.message || 'Execution request failed.' });
      setExecuteSignal(null);
    } finally {
      setExecuting(false);
    }
  };

  const cancelSetup = async () => {
    if (!dismissSignal) return;
    if (!dismissStillCurrent) {
      setActionMessage({ tone: 'error', text: 'The strategy changed before dismissal was confirmed. Review the new setup instead.' });
      setDismissSignal(null);
      return;
    }
    setDismissing(true);
    setActionMessage(null);
    try {
      await api.updateSignalStatus(dismissSignal.id, 'CANCELLED');
      setActionMessage({ tone: 'success', text: 'Setup dismissed for this account.' });
      setDismissSignal(null);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    } catch (error: any) {
      setActionMessage({ tone: 'error', text: error.message || 'Could not dismiss this setup.' });
    } finally {
      setDismissing(false);
    }
  };

  const strategyHealth = services?.strategyEngine;
  const ibkrHealth = services?.marketData?.ibkr || services?.streams?.ibkr;
  const systemReady = strategyHealth?.status === 'UP' && ibkrHealth?.connected === true;
  const diagnostics = [
    {
      label: 'Strategy engine',
      status: strategyHealth?.status || 'N/A',
      age: compactAge(strategyHealth?.freshnessMs),
      detail: strategyHealth?.lastError || strategyHealth?.degradedReason || `${strategyHealth?.mode || 'primary'} mode · ${strategyHealth?.connected ? 'provider connected' : 'provider disconnected'}`,
      next: 'Check the strategy-engine container, IBKR connection, and snapshot timestamps.'
    },
    {
      label: 'ZeroGEX',
      status: Number.isFinite(gexAge) ? gexFresh ? 'UP' : 'DEGRADED' : 'DOWN',
      age: Number.isFinite(gexAge) ? `${number(gexAge, 1)}s old` : 'age unavailable',
      detail: Number.isFinite(gexAge)
        ? `${String(primaryGex.regime || primaryGex.gamma_regime || 'GEX context')} · authoritative provider timestamp`
        : 'No authoritative GEX timestamp.',
      next: 'Check the ZeroGEX key and zerogex-prefetch health, then wait for a fresh snapshot.'
    },
    {
      label: 'IBKR market data',
      status: services?.marketData?.ibkr?.status || 'N/A',
      age: services?.marketData?.ibkr?.latencyMs != null ? `${services.marketData.ibkr.latencyMs}ms` : undefined,
      detail: services?.marketData?.ibkr?.lastError || `${services?.marketData?.ibkr?.mode || 'live'} · ${services?.marketData?.ibkr?.host || 'gateway'}:${services?.marketData?.ibkr?.port || '—'}`,
      next: 'Restore Gateway API connectivity and confirm the configured host, port, and market-data entitlement.'
    },
    {
      label: 'IBKR quote stream',
      status: services?.streams?.ibkr?.status || 'N/A',
      age: compactAge(services?.streams?.ibkr?.freshnessMs),
      detail: services?.streams?.ibkr?.lastError || `${services?.streams?.ibkr?.activeSubscriptions || 0} active option subscriptions`,
      next: 'Restore Gateway connectivity, then restart the backend quote stream.'
    },
    {
      label: 'Live exit monitor',
      status: services?.liveExitMonitor?.status || 'N/A',
      age: compactAge(services?.liveExitMonitor?.freshnessMs),
      detail: services?.liveExitMonitor?.lastError || `${services?.liveExitMonitor?.provider || 'no provider'} · ${services?.liveExitMonitor?.quotesProcessed || 0} quotes processed`,
      next: 'Check open option subscriptions and restart the backend after the IBKR stream is healthy.'
    },
    {
      label: 'Redis updates',
      status: services?.tradeRedis?.status || 'N/A',
      age: compactAge(services?.tradeRedis?.freshnessMs),
      detail: services?.tradeRedis?.lastError || `${services?.tradeRedis?.queueDepth ?? 0} queued events`,
      next: 'Check the Redis container and backend Redis URL.'
    },
    {
      label: 'System paper trader',
      status: services?.paperTrading?.status || paperAccount?.health.status || 'N/A',
      age: services?.paperTrading?.lastProcessedAt ? dateTime(services.paperTrading.lastProcessedAt) : undefined,
      detail: services?.paperTrading?.lastError || `${paperAccount?.account.automation_status || 'starting'} · shared $100K strategy account`,
      next: 'Check strategy snapshots, the paper account schema, and the latest paper decision.'
    },
    {
      label: 'Postgres',
      status: services?.postgres?.status || 'N/A',
      age: services?.postgres?.latencyMs != null ? `${services.postgres.latencyMs}ms` : undefined,
      detail: services?.postgres?.lastError || 'Signal, position, and lifecycle history available',
      next: 'Check database reachability, credentials, and schema verification logs.'
    }
  ];
  const paperUnrealizedPnl = paperAccount?.openPositions.reduce(
    (total, position) => total + (Number(position.current_price) - Number(position.entry_price)) * Number(position.quantity) * 100,
    0
  ) || 0;

  return (
    <main className="day-trading-terminal mx-auto w-full max-w-[1440px] space-y-3 px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] text-zinc-100 sm:space-y-4 sm:px-0 sm:pb-0">
      <section className="overflow-hidden rounded-2xl border border-zinc-800/90 bg-[#0d0f12] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-3 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Day trading</span>
              <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300">SPY · signal-only-v2</Badge>
            </div>
            <h1 className="mt-1 hidden text-2xl font-semibold tracking-[-0.03em] text-zinc-50 sm:block">One signal. One decision.</h1>
            <p className="mt-0.5 hidden max-w-2xl text-xs leading-relaxed text-zinc-500 sm:block">
              Follow the strategy lifecycle from setup formation through guarded execution and position management.
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-4 gap-1.5 sm:gap-2">
            <Link
              to="/strategy-desk"
              className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 text-[11px] font-medium text-zinc-300 transition-colors hover:border-violet-500/40 hover:text-violet-200 active:translate-y-px sm:w-auto sm:px-3"
              title="Open Strategy Desk"
              aria-label="Open Strategy Desk"
            >
              <Radar className="h-3.5 w-3.5 text-violet-300" />
              <span className="hidden sm:inline">Strategy Desk</span>
              <ArrowUpRight className="hidden h-3 w-3 sm:block" />
            </Link>
            <Link
              to="/system-health"
              className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 active:translate-y-px sm:w-auto sm:px-3"
              title="System health"
              aria-label="Open system health"
            >
              {systemReady ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" /> : <CircleAlert className="h-3.5 w-3.5 text-amber-400" />}
              <span className="hidden sm:inline">System health</span>
              <ArrowUpRight className="hidden h-3 w-3 sm:block" />
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleBrowserAlerts}
              className="h-9 w-9 border-zinc-800 bg-zinc-950 px-0 text-[11px] text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 active:translate-y-px sm:w-auto sm:px-3"
              title="Notify this browser when a setup becomes ARMED or ACTIVE"
              aria-label={browserAlertsEnabled ? 'Disable setup alerts' : 'Enable setup alerts'}
            >
              {browserAlertsEnabled ? <Bell className="h-3.5 w-3.5 text-emerald-400 sm:mr-1.5" /> : <BellOff className="h-3.5 w-3.5 sm:mr-1.5" />}
              <span className="hidden sm:inline">Alerts</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshAll}
              disabled={refreshing}
              className="h-9 w-9 border-zinc-800 bg-zinc-950 px-0 text-[11px] text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 active:translate-y-px sm:w-auto sm:px-3"
              title="Refresh Day Trading data"
              aria-label="Refresh Day Trading data"
            >
              <RefreshCw className={`h-3.5 w-3.5 sm:mr-2 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </header>

        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-[10px] sm:hidden">
          <span className={freshSnapshot ? 'text-emerald-300' : 'text-amber-300'}>
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current" />
            Strategy {strategyHealth?.status || (freshSnapshot ? 'LIVE' : 'STARTING')}
          </span>
          <span className="font-mono text-zinc-400">Capacity {tradeUsage?.used ?? 0}/{tradeUsage?.max ?? settings.max_trades_per_day ?? 2}</span>
          <span className={services?.scanner?.marketOpen ? 'text-emerald-300' : 'text-zinc-500'}>
            Market {services?.scanner?.marketOpen ? 'open' : 'closed'}
          </span>
        </div>

        <div className="hidden gap-x-4 border-b border-zinc-800 px-6 sm:grid sm:grid-cols-3 lg:grid-cols-6">
          <Metric
            label="Strategy"
            value={strategyHealth?.status || (freshSnapshot ? 'LIVE' : 'STARTING')}
            detail={relativeAge(snapshotAge)}
            tone={freshSnapshot ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="IBKR"
            value={ibkrHealth?.connected ? 'Connected' : 'Unavailable'}
            detail={ibkrHealth?.mode ? `${ibkrHealth.mode} · ${ibkrHealth.port || '—'}` : 'market data'}
            tone={ibkrHealth?.connected ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="Execution"
            value={executionMode.label}
            detail={executionMode.autonomous ? 'one-contract autonomous entry' : executionMode.live ? 'manual real orders enabled' : 'no live orders'}
            tone={executionMode.live ? 'text-amber-300' : 'text-sky-300'}
          />
          <Metric
            label="Daily capacity"
            value={`${tradeUsage?.used ?? 0} / ${tradeUsage?.max ?? settings.max_trades_per_day ?? 2}`}
            detail={`${tradeUsage?.remaining ?? 0} remaining`}
            tone={usageRemaining > 0 ? 'text-zinc-100' : 'text-rose-300'}
          />
          <Metric
            label="App updates"
            value={isConnected ? 'Live' : 'Polling'}
            detail={isConnected ? 'socket connected' : 'refresh fallback'}
            tone={isConnected ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="Market"
            value={services?.scanner?.marketOpen ? 'Open' : 'Closed'}
            detail={marketSessionLabel}
            tone={services?.scanner?.marketOpen ? 'text-emerald-300' : 'text-zinc-400'}
          />
        </div>

        <section className={`m-2.5 rounded-xl border p-3.5 sm:m-5 sm:p-6 ${toneClasses[currentTone]}`}>
          <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] opacity-70">{lifecycleView.eyebrow}</span>
                <span className="rounded-md border border-current/20 bg-black/15 px-2 py-1 font-mono text-[10px] font-semibold">{displayLifecycle.replace(/_/g, ' ')}</span>
                {displayLifecycle === 'DISMISSED' && lifecycle === 'ACTIVE' && (
                  <span className="text-[10px] font-medium text-zinc-500">Strategy engine ACTIVE</span>
                )}
                {side && (
                  <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${
                    !directionConfirmed
                      ? 'border-amber-500/20 bg-amber-950/15 text-amber-200'
                      : side === 'CALL'
                        ? 'border-emerald-500/25 bg-emerald-950/30 text-emerald-200'
                        : 'border-rose-500/25 bg-rose-950/30 text-rose-200'
                  }`}>
                    {side}{directionConfirmed ? '' : ' bias'}
                  </span>
                )}
                {currentStrategyCode && (
                  <span className="rounded-md border border-current/15 bg-black/10 px-2 py-1 text-[10px] font-medium">
                    {currentStrategy.name}
                  </span>
                )}
                <a href="#setup-history" className="text-[10px] font-medium text-zinc-500 transition-colors hover:text-zinc-300">History ↓</a>
              </div>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.025em] text-zinc-50 sm:text-3xl">{lifecycleView.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">{lifecycleView.description}</p>
              {(executionStarted || brokerPositionOpen) && (
                <div className={`mt-3 grid gap-2 rounded-lg border px-3 py-2.5 text-xs sm:grid-cols-[1fr_auto] sm:items-center ${
                  executionNeedsReview
                    ? 'border-rose-500/25 bg-rose-950/15'
                    : brokerPositionOpen
                      ? 'border-sky-500/20 bg-sky-950/15'
                      : 'border-amber-500/20 bg-amber-950/10'
                }`}>
                  <div className="min-w-0">
                    <div className="font-semibold text-zinc-200">
                      {brokerPositionOpen
                        ? 'Broker position linked'
                        : executionSkipped
                          ? 'Entry evaluation complete'
                          : executionSubmitting ? 'Order submission in progress' : 'Broker confirmation pending'}
                    </div>
                    <div className="mt-1 break-words text-zinc-400">
                      {brokerName} · {executionStatus || (executionStarted ? 'SUBMITTED' : linkedPosition?.status || 'UNKNOWN')}
                      {brokerOrderId ? ` · Order ${brokerOrderId}` : ''}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500 sm:text-right">
                    Status updated {dateTime(brokerSyncAt)}
                  </div>
                </div>
              )}
              {currentStrategyCode && (
                <div className="mt-3 max-w-2xl rounded-lg border border-current/10 bg-black/10 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                  <span className="font-semibold">
                    {directionConfirmed
                      ? `${side === 'CALL' ? 'Bullish' : side === 'PUT' ? 'Bearish' : 'Directional'} alignment:`
                      : `Current ${side === 'CALL' ? 'bullish' : side === 'PUT' ? 'bearish' : 'directional'} bias:`}
                  </span>{' '}{currentStrategy.explanation}
                </div>
              )}

              {hasLevelPlan ? (
                <LevelRail
                  potential={!directionConfirmed}
                  levels={[
                    { label: 'Stop', value: setup?.invalidation, tone: directionConfirmed ? 'text-rose-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-rose-400' : 'bg-zinc-500' },
                    { label: 'Spot', value: strategySignal?.spot, tone: 'text-zinc-100', dot: 'bg-zinc-200' },
                    { label: 'Trigger', value: setup?.trigger, tone: directionConfirmed ? 'text-emerald-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-emerald-400' : 'bg-zinc-500' },
                    { label: 'T1', value: targetOne, tone: directionConfirmed ? 'text-sky-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-sky-400' : 'bg-zinc-500' },
                    { label: `T${exitTargetNumber}`, value: targetTwo, tone: directionConfirmed ? 'text-sky-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-sky-300' : 'bg-zinc-500' }
                  ]}
                />
              ) : (
                <div className="mt-5 rounded-lg border border-zinc-800/80 bg-black/15 px-3 py-3 sm:mt-6 sm:px-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">No level plan yet</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">
                    {strategyBlockers[0] || 'The strategy is waiting for a qualified directional setup.'}
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-800/70 pt-3 font-mono text-[10px] tabular-nums text-zinc-500">
                    <span>5m structure<br /><span className="text-zinc-300">{fiveMinuteStructure}</span></span>
                    <span>VWAP<br /><span className="text-zinc-300">{Number.isFinite(vwap) ? money(vwap) : 'Unavailable'}</span></span>
                    <span>SPY vs VWAP<br /><span className="text-zinc-300">{spotVsVwap}</span></span>
                  </div>
                </div>
              )}

              <div className="mt-4 rounded-lg border border-zinc-800/80 bg-zinc-950/45 p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${
                        displayLifecycle === 'DISMISSED' || executionSkipped
                          ? 'bg-zinc-500'
                          : executionNeedsReview
                            ? 'bg-rose-400'
                            : brokerPositionOpen
                              ? 'bg-sky-400'
                              : executionStarted
                                ? 'bg-amber-400'
                                : lifecycle === 'ACTIVE' && canExecute
                                  ? 'animate-pulse bg-emerald-400'
                                  : freshSnapshot ? 'bg-amber-400' : 'bg-rose-400'
                      }`} />
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Setup heartbeat</span>
                      <span className={`text-[10px] font-semibold ${
                        executionNeedsReview
                          ? 'text-rose-300'
                          : brokerPositionOpen
                            ? 'text-sky-300'
                            : dismissedActionableSetup || executionStarted || !canExecute
                              ? 'text-amber-300'
                              : 'text-emerald-300'
                      }`}>{heartbeatLabel}</span>
                    </div>
                    <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-zinc-300">{heartbeatSummary}</p>
                  </div>
                  <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500 sm:text-right">
                    <span>Strategy {relativeAge(snapshotAge)}</span>
                    <span>Option quote {Number.isFinite(quoteAge) ? `${number(quoteAge, 1)}s` : optionSelected ? 'Unavailable' : 'Not selected'}</span>
                    <span>GEX {Number.isFinite(gexAge) ? `${number(gexAge, 1)}s` : '—'}</span>
                    <span>{directionConfirmed ? 'R/R' : 'Plan R/R'} {Number.isFinite(rewardRisk) ? `${number(rewardRisk)}:1` : '—'}</span>
                  </div>
                </div>
                <div className="mt-2 border-t border-zinc-800/70 pt-2 text-[10px] text-zinc-500">{marketSessionLabel}</div>
              </div>

              {!directionConfirmed && side && (
                <details className="group mt-3 rounded-lg border border-zinc-800/70 bg-black/10">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[10px] font-medium text-zinc-500">
                    Compare CALL and PUT watch levels
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="grid gap-2 border-t border-zinc-800/70 p-2 sm:grid-cols-2">
                    {([
                      ['CALL', strategySignal?.call_setup],
                      ['PUT', strategySignal?.put_setup]
                    ] as const).map(([watchSide, watchSetup]) => (
                      <div key={watchSide} className="rounded-md bg-zinc-950/55 p-2.5">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="font-semibold text-zinc-300">{watchSide}</span>
                          <span className={side === watchSide ? 'text-amber-300' : 'text-zinc-600'}>{side === watchSide ? 'Current bias' : 'Alternate'}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] tabular-nums text-zinc-500">
                          <span>Trigger<br /><span className="text-zinc-300">{money(watchSetup?.trigger)}</span></span>
                          <span>Stop<br /><span className="text-zinc-300">{money(watchSetup?.invalidation)}</span></span>
                          <span>T1<br /><span className="text-zinc-300">{money(watchSetup?.targets?.[0])}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {strategyBlockers.length > 0 && lifecycle !== 'ACTIVE' && (
                <div className="mt-5 rounded-lg border border-amber-500/20 bg-black/15 px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">What is blocking entry</div>
                  <div className="mt-2 space-y-1.5">
                    {strategyBlockers.slice(0, 4).map(blocker => (
                      <div key={blocker} className="flex items-start gap-2 text-xs leading-relaxed text-zinc-300">
                        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span>{blocker}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <aside className="rounded-xl border border-zinc-800/90 bg-black/20 p-3.5 sm:p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Next action</div>
              {dismissedActionableSetup && !brokerPositionOpen ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">No action available</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    This setup is cancelled for your account. The engine may continue tracking it, but it cannot submit an order from this card.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    <Clock3 className="h-4 w-4" />
                    Wait for the next qualified setup
                  </div>
                </>
              ) : executionSkipped ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Wait for the next setup</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    No broker order was placed. The current setup cannot be submitted again.
                  </p>
                  {executionMessage && (
                    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                      {executionMessage}
                    </div>
                  )}
                </>
              ) : executionNeedsReview ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Verify the broker order</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Do not retry this entry until Wealthsimple or SnapTrade confirms whether the order exists.
                  </p>
                  <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-950/15 px-3 py-2 text-xs leading-relaxed text-rose-200">
                    {executionMessage || `Broker status: ${executionStatus || 'unknown'}`}
                  </div>
                </>
              ) : brokerPositionOpen ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Monitor the open position</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    The linked position is active. Entry controls remain closed while its exit policy manages risk.
                  </p>
                  <Link
                    to={`/positions/${linkedPosition.id}`}
                    className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-lg border border-sky-500/20 bg-sky-950/15 text-xs font-semibold text-sky-200 transition-colors hover:bg-sky-950/30"
                  >
                    Open position details →
                  </Link>
                </>
              ) : executionStarted ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">
                    {executionSubmitting ? 'Order submission in progress' : 'Wait for broker confirmation'}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    {executionSubmitting
                      ? 'StrikePilot is sending the order. Do not retry or place a duplicate manual order.'
                      : 'The order was submitted. Do not place a duplicate manual order while reconciliation is pending.'}
                  </p>
                  <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2 text-xs text-amber-200">
                    {brokerName} · {executionStatus || 'SUBMITTED'}
                  </div>
                </>
              ) : lifecycle === 'ACTIVE' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">
                    {executionMode.autonomous ? 'Autonomous entry evaluation' : 'Review the planned order'}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    {executionMode.autonomous
                      ? 'No click is required. The backend submits one contract only while lifecycle, market window, freshness, quote quality, debit and account risk checks remain valid.'
                      : 'Confirmation remains manual. The backend rechecks lifecycle, freshness, quote quality and debit limits.'}
                  </p>
                  <PlannedEntryTicket
                    option={option}
                    side={side}
                    quantity={orderQuantity}
                    plannedLimit={plannedLimit}
                    orderDebit={orderDebit}
                    quoteAge={quoteAge}
                  />
                  {executionMode.autonomous ? (
                    <div className="mt-5 rounded-lg border border-amber-500/25 bg-amber-950/15 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                      <div>Autonomous entry is evaluating the live risk gates. No manual order is needed.</div>
                      {autonomousResult && (
                        <div className="mt-1 text-amber-100">
                          Last evaluation: {autonomousResult}
                          {autonomousLastAttemptAt ? ` · ${dateTime(autonomousLastAttemptAt)}` : ''}
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button
                      className="mt-5 h-11 w-full bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500"
                      onClick={requestExecution}
                      disabled={!canExecute}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      Review order
                    </Button>
                  )}
                  {!canExecute && (
                    <div className="mt-3 space-y-1 text-xs leading-relaxed text-amber-300">
                      {executionBlockers.slice(0, 3).map(blocker => <div key={blocker}>• {blocker}</div>)}
                    </div>
                  )}
                  {currentSignal && !executionMode.autonomous && (
                    <button
                      type="button"
                      onClick={() => setDismissSignal(currentSignal)}
                      className="mt-3 w-full text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      Dismiss this setup
                    </button>
                  )}
                </>
              ) : lifecycle === 'ARMED' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Prepare, but stay flat</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    The contract plan is visible for preparation. Entry remains locked until the lifecycle becomes ACTIVE.
                  </p>
                  {plannedContracts > 0 && (
                    <PlannedEntryTicket
                      option={option}
                      side={side}
                      quantity={orderQuantity}
                      plannedLimit={plannedLimit}
                      orderDebit={orderDebit}
                      quoteAge={quoteAge}
                    />
                  )}
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-950/15 px-3 py-2 text-xs text-amber-200">
                    <Clock3 className="h-4 w-4" />
                    Waiting for ACTIVE confirmation
                  </div>
                </>
              ) : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Let the lifecycle manage</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Monitor the protected invalidation and target progression. No second entry is allowed.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-950/20 px-3 py-2 text-xs text-sky-200">
                    <Activity className="h-4 w-4" />
                    Exit monitor active
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">No order to review</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Stay flat until the lifecycle opens a fresh ACTIVE entry window.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    <Clock3 className="h-4 w-4" />
                    Waiting automatically
                  </div>
                </>
              )}
            </aside>
          </div>
        </section>
      </section>

      {paperAccount && (
        <section className="overflow-hidden rounded-xl border border-zinc-800 bg-[#101216]">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5 sm:pb-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">System paper portfolio</span>
                <Badge variant="outline" className={`text-[10px] ${
                  paperAccount.account.automation_status === 'ACTIVE'
                    ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-950/20 text-amber-300'
                }`}>
                  {paperAccount.account.automation_status}
                </Badge>
                <Badge variant="outline" className="border-zinc-700 bg-zinc-950 text-[10px] text-zinc-400">Paper only</Badge>
              </div>
              <h3 className="mt-1 text-lg font-semibold text-zinc-50">Autonomous strategy account</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-400">
                Independent simulation portfolio. It records and manages paper entries without enabling, disabling, or changing Wealthsimple orders.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:bg-zinc-900 sm:hidden"
                onClick={() => setPaperExpanded(value => !value)}
                aria-expanded={paperExpanded}
              >
                {paperExpanded ? 'Hide paper details' : 'Show paper details'}
                <ChevronDown className={`ml-1.5 h-3.5 w-3.5 transition-transform ${paperExpanded ? 'rotate-180' : ''}`} />
              </Button>
              {paperAccount.canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 flex-1 border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:bg-zinc-900 sm:flex-none"
                  onClick={togglePaperAutomation}
                  disabled={paperUpdating}
                >
                  {paperUpdating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {paperAccount.account.automation_status === 'ACTIVE' ? 'Pause paper entries' : 'Resume paper entries'}
                </Button>
              )}
            </div>
          </div>

          <div className={`${paperExpanded ? 'block' : 'hidden'} border-t border-zinc-800 px-4 pb-4 sm:block sm:px-5 sm:pb-5`}>
          <div className="grid grid-cols-2 gap-x-4 border-b border-zinc-800 sm:grid-cols-5">
            <Metric label="Equity" value={money(paperAccount.account.equity)} detail={`started ${money(paperAccount.account.initial_equity)}`} />
            <Metric label="Cash" value={money(paperAccount.account.cash_balance)} detail={`${money(paperAccount.account.reserved_cash)} reserved`} />
            <Metric
              label="Today"
              value={`${paperAccount.session.pnl >= 0 ? '+' : ''}${money(paperAccount.session.pnl)}`}
              detail={`${number(paperAccount.session.pnlPct)}%`}
              tone={paperAccount.session.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}
            />
            <Metric label="Paper entries today" value={`${paperAccount.session.entries} · unlimited`} detail="distinct qualified setups" />
            <Metric label="Open positions" value={String(paperAccount.openPositions.length)} detail={paperAccount.health.lastProcessedAt ? `checked ${dateTime(paperAccount.health.lastProcessedAt)}` : 'waiting for snapshot'} />
          </div>

          <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
              Automation policy and performance comparison
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                <span>AI today <span className="font-mono text-zinc-200">{paperAccount.aiUsage.dailyCalls}/{paperAccount.aiUsage.dailyCallLimit}</span></span>
                <span>Tokens today <span className="font-mono text-zinc-200">{paperAccount.aiUsage.dailyTokens.toLocaleString()}</span></span>
                <span>Tokens this month <span className="font-mono text-zinc-200">{paperAccount.aiUsage.monthlyTokens.toLocaleString()}</span></span>
                <span>Exit policy <span className="font-mono text-zinc-200">{paperAccount.limits.policyVersion} · {paperAccount.limits.trailingStopPct}%</span></span>
                <span className="text-zinc-500">Clear setups use rules; AI is reserved for ambiguity.</span>
              </div>

              <div className="mt-3 grid grid-cols-3 divide-x divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/35 py-2 text-center">
                <Metric
                  label="Managed realized P&L"
                  value={money(paperAccount.baseline.managedRealizedPnl)}
                  detail="AI/rules exits"
                  tooltip="Realized paper P&L produced by the configured strategy sizing and exit policy."
                  tone={paperAccount.baseline.managedRealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}
                />
                <Metric
                  label="1-contract baseline"
                  value={money(paperAccount.baseline.realizedPnl)}
                  detail={`${paperAccount.baseline.closedTrades} closed`}
                  tooltip="Comparison result if each recorded paper setup used one contract."
                  tone={paperAccount.baseline.realizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}
                />
                <Metric
                  label="Sizing value"
                  value={`${paperAccount.baseline.valueAdded >= 0 ? '+' : ''}${money(paperAccount.baseline.valueAdded)}`}
                  detail="managed − baseline"
                  tooltip="Difference between managed paper P&L and the one-contract comparison baseline."
                  tone={paperAccount.baseline.valueAdded >= 0 ? 'text-emerald-300' : 'text-rose-300'}
                />
              </div>
            </div>
          </details>

          {paperAccount.openPositions.length > 0 ? (
            <div className="mt-4 space-y-2">
              {paperAccount.openPositions.map(position => {
                const unrealizedPnl = (Number(position.current_price) - Number(position.entry_price)) * Number(position.quantity) * 100;
                return (
                  <div key={position.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/35 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="break-all font-mono text-sm font-semibold text-zinc-100">
                        {position.symbol} {position.option_type} {money(position.strike_price)}
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {position.quantity} contract{Number(position.quantity) === 1 ? '' : 's'} · {position.risk_tier || 'bounded'} risk · {String(position.exit_profile || 'balanced T2').replace(/_/g, ' ').toLowerCase()}
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        Structural SL → TP1 protection/trim → TP2 · {Number(position.decision_trailing_stop_pct || paperAccount.limits.trailingStopPct)}% premium trail · {position.policy_version || paperAccount.limits.policyVersion}
                      </div>
                    </div>
                    <div className="flex flex-col items-start font-mono text-xs sm:items-end sm:text-right">
                      <div className="text-zinc-300">
                        {money(position.entry_price)} → {money(position.current_price)}
                      </div>
                      <div className={`mt-1 font-semibold ${unrealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        Unrealized {unrealizedPnl >= 0 ? '+' : ''}{money(unrealizedPnl)}
                      </div>
                      {paperAccount.canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2 h-8 border-rose-500/25 bg-rose-950/15 px-2.5 text-[10px] font-semibold text-rose-200 hover:bg-rose-950/35 hover:text-rose-100"
                          onClick={() => {
                            setActionMessage(null);
                            setPaperForceCloseAvailable(isExpiredOption(position.expiration_date));
                            setPaperClosePosition(position);
                          }}
                          disabled={paperClosing}
                        >
                          Close paper position
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className={`text-right font-mono text-xs font-semibold ${paperUnrealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                Total unrealized {paperUnrealizedPnl >= 0 ? '+' : ''}{money(paperUnrealizedPnl)}
              </div>
            </div>
          ) : paperAccount.recentDecisions[0] ? (
            <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-xs leading-relaxed text-zinc-300">
              <span className="font-semibold text-zinc-200">Latest decision:</span>{' '}
              {paperAccount.recentDecisions[0].decision} · {paperAccount.recentDecisions[0].source} · {paperAccount.recentDecisions[0].rationale || 'No rationale recorded'}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
              No paper decision yet. The account will evaluate the next fresh ACTIVE setup automatically.
            </div>
          )}

          <section className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-left"
              onClick={() => setPaperTransactionsExpanded(value => !value)}
              aria-expanded={paperTransactionsExpanded}
              aria-controls="paper-transactions-content"
            >
              <div>
                <div className="text-xs font-semibold text-zinc-300">Paper transactions</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Filled, pending, expired, and rejected paper orders</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-zinc-500">{paperAccount.recentOrders.length}</span>
                <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${paperTransactionsExpanded ? 'rotate-180' : ''}`} />
              </div>
            </button>
            <div id="paper-transactions-content" className={`${paperTransactionsExpanded ? 'block' : 'hidden'} border-t border-zinc-800`}>
              {paperAccount.recentOrders.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-zinc-500">No paper transactions have been recorded.</div>
              ) : (
                <>
                  <div className="divide-y divide-zinc-800 sm:hidden">
                    {paperAccount.recentOrders.slice(0, 20).map(order => {
                      const fillPrice = Number(order.fill_price);
                      const limitPrice = Number(order.limit_price);
                      const quantity = Number(order.quantity || 0);
                      const status = String(order.status || 'UNKNOWN').toUpperCase();
                      const transactionValue = Number.isFinite(fillPrice) && fillPrice > 0
                        ? fillPrice * quantity * 100
                        : status === 'PENDING' ? Number(order.reserved_debit || 0) : 0;
                      return (
                        <article key={order.id} className="px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-zinc-200">
                                {humanContractName({ strike: order.strike, expiry: order.expiration }, order.option_type)}
                              </div>
                              <div className="mt-1 text-[10px] text-zinc-500">
                                {order.intent.replace(/_/g, ' ')} · {order.action.replace(/_/g, ' ')} · {quantity} contract{quantity === 1 ? '' : 's'}
                              </div>
                            </div>
                            <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                              status === 'FILLED'
                                ? 'border-emerald-500/25 bg-emerald-950/20 text-emerald-300'
                                : status === 'PENDING'
                                  ? 'border-amber-500/25 bg-amber-950/20 text-amber-300'
                                  : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                            }`}>{status}</span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] text-zinc-400">
                            <div><span className="block text-zinc-600">Limit</span>{Number.isFinite(limitPrice) && limitPrice > 0 ? money(limitPrice) : '—'}</div>
                            <div><span className="block text-zinc-600">Fill</span>{Number.isFinite(fillPrice) && fillPrice > 0 ? money(fillPrice) : '—'}</div>
                            <div><span className="block text-zinc-600">{status === 'PENDING' ? 'Reserved' : order.intent === 'ENTRY' ? 'Debit' : 'Credit'}</span>{transactionValue > 0 ? money(transactionValue) : '—'}</div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-zinc-600">
                            <span>{dateTime(order.filled_at || order.updated_at || order.created_at)}</span>
                            <span className="select-all truncate font-mono" title={order.osi_ticker}>{order.osi_ticker}</span>
                          </div>
                          {order.failure_reason && <div className="mt-2 text-[10px] leading-relaxed text-rose-300">{order.failure_reason}</div>}
                        </article>
                      );
                    })}
                  </div>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full min-w-[860px] text-xs">
                      <thead className="bg-zinc-900/45 text-[10px] uppercase tracking-[0.08em] text-zinc-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Time</th>
                          <th className="px-3 py-2 text-left">Transaction</th>
                          <th className="px-3 py-2 text-left">Contract</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Limit</th>
                          <th className="px-3 py-2 text-right">Fill</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          <th className="px-3 py-2 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800">
                        {paperAccount.recentOrders.slice(0, 50).map(order => {
                          const fillPrice = Number(order.fill_price);
                          const limitPrice = Number(order.limit_price);
                          const quantity = Number(order.quantity || 0);
                          const status = String(order.status || 'UNKNOWN').toUpperCase();
                          const transactionValue = Number.isFinite(fillPrice) && fillPrice > 0
                            ? fillPrice * quantity * 100
                            : status === 'PENDING' ? Number(order.reserved_debit || 0) : 0;
                          return (
                            <tr key={order.id} className="transition-colors hover:bg-zinc-900/35">
                              <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-zinc-500">{dateTime(order.filled_at || order.updated_at || order.created_at)}</td>
                              <td className="px-3 py-2.5">
                                <div className="font-semibold text-zinc-300">{order.intent.replace(/_/g, ' ')}</div>
                                <div className="mt-0.5 text-[10px] text-zinc-600">{order.action.replace(/_/g, ' ')}</div>
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="font-medium text-zinc-300">{humanContractName({ strike: order.strike, expiry: order.expiration }, order.option_type)}</div>
                                <div className="mt-0.5 max-w-48 select-all truncate font-mono text-[9px] text-zinc-600" title={order.osi_ticker}>{order.osi_ticker}</div>
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-400">{quantity}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-400">{Number.isFinite(limitPrice) && limitPrice > 0 ? money(limitPrice) : '—'}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-300">{Number.isFinite(fillPrice) && fillPrice > 0 ? money(fillPrice) : '—'}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-300">{transactionValue > 0 ? money(transactionValue) : '—'}</td>
                              <td className={`px-3 py-2.5 text-right font-mono text-[10px] ${status === 'FILLED' ? 'text-emerald-300' : status === 'PENDING' ? 'text-amber-300' : 'text-zinc-500'}`}>{status}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </section>

          <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
              <div>
                <div className="text-xs font-semibold text-zinc-300">Paper trade intelligence</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Paper-only decision, execution, outcome, baseline, and lifecycle evidence</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-zinc-500">{paperAccount.recentPositions.length} trades</span>
                <ChevronDown className="h-3.5 w-3.5 text-zinc-500 transition-transform group-open:rotate-180" />
              </div>
            </summary>
            <div className="border-t border-zinc-800 p-2 sm:p-3">
              {paperAccount.recentPositions.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-zinc-500">No filled paper trades are available for analysis.</div>
              ) : (
                <div className="space-y-2">
                  {paperAccount.recentPositions.slice(0, 25).map(position => {
                    const setupId = String(position.strategy_setup_id || '');
                    const decisionId = Number(position.paper_decision_id || 0);
                    const relatedOrders = paperAccount.recentOrders.filter(order => (
                      Number(order.position_id || 0) === Number(position.id)
                      || (setupId && order.setup_id === setupId)
                      || (decisionId > 0 && Number(order.decision_id || 0) === decisionId)
                    ));
                    const relatedJournal = paperAccount.journal.filter(item => (
                      Number(item.position_id || 0) === Number(position.id)
                      || (setupId && item.setup_id === setupId)
                      || (decisionId > 0 && Number(item.decision_id || 0) === decisionId)
                    ));
                    const initialQuantity = Math.max(1, Number(position.contracts_requested || position.quantity || 1));
                    const entryPrice = Number(position.entry_price || 0);
                    const currentPrice = Number(position.current_price || entryPrice);
                    const isClosed = position.status === 'CLOSED';
                    const tradePnl = isClosed
                      ? Number(position.realized_pnl || 0)
                      : Number(position.realized_pnl || 0) + (currentPrice - entryPrice) * Number(position.quantity || 0) * 100;
                    const baselinePnl = Number(position.baseline_realized_pnl);
                    const hasBaseline = position.baseline_realized_pnl != null && Number.isFinite(baselinePnl);
                    const riskFlags = Array.isArray(position.decision_risk_flags) ? position.decision_risk_flags : [];
                    const evidence = position.decision_evidence && typeof position.decision_evidence === 'object'
                      ? position.decision_evidence
                      : {};
                    const analysis = position.analysis_data && typeof position.analysis_data === 'object'
                      ? position.analysis_data
                      : {};
                    return (
                      <details key={position.id} className="group/trade rounded-lg border border-zinc-800 bg-[#0d0f12]">
                        <summary className="grid cursor-pointer list-none gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-zinc-200">
                                {humanContractName({ strike: position.strike_price, expiry: position.expiration_date }, position.option_type)}
                              </span>
                              <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                                isClosed
                                  ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
                                  : 'border-sky-500/25 bg-sky-950/20 text-sky-300'
                              }`}>{position.status}</span>
                            </div>
                            <div className="mt-1 text-[10px] text-zinc-500">
                              {position.decision_source || 'Rules'} · {position.risk_tier || 'bounded'} risk · {String(position.exit_profile || 'balanced T2').replace(/_/g, ' ').toLowerCase()}
                            </div>
                          </div>
                          <div className="sm:text-right">
                            <div className={`font-mono text-sm font-semibold ${tradePnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                              {tradePnl >= 0 ? '+' : ''}{money(tradePnl)}
                            </div>
                            <div className="text-[9px] text-zinc-600">{isClosed ? 'realized' : 'unrealized'}</div>
                          </div>
                          <div className="flex items-center justify-between gap-3 sm:justify-end">
                            <span className="font-mono text-[10px] text-zinc-600">{dateTime(position.updated_at || position.created_at)}</span>
                            <ChevronDown className="h-3.5 w-3.5 text-zinc-500 transition-transform group-open/trade:rotate-180" />
                          </div>
                        </summary>
                        <div className="border-t border-zinc-800 p-3">
                          <div className="grid gap-3 lg:grid-cols-3">
                            <div className="rounded-lg bg-zinc-950/65 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Execution and outcome</div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] text-zinc-500">
                                <div>Entry <span className="block font-mono text-xs text-zinc-200">{money(entryPrice)}</span></div>
                                <div>{isClosed ? 'Exit' : 'Current'} <span className="block font-mono text-xs text-zinc-200">{money(isClosed ? position.exit_price : currentPrice)}</span></div>
                                <div>Original size <span className="block font-mono text-xs text-zinc-200">{initialQuantity}</span></div>
                                <div>Duration <span className="block font-mono text-xs text-zinc-200">{duration(position.created_at, isClosed ? position.updated_at : null)}</span></div>
                              </div>
                              <div className="mt-2 border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">
                                Exit reason <span className="text-zinc-300">{String(position.exit_reason || 'Position remains open').replace(/_/g, ' ')}</span>
                              </div>
                            </div>

                            <div className="rounded-lg bg-zinc-950/65 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Decision intelligence</div>
                              <div className="mt-2 text-xs leading-relaxed text-zinc-300">
                                {position.decision_rationale || 'No decision rationale was recorded.'}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{position.decision_source || 'RULES'}</span>
                                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{position.ai_requested ? 'AI reviewed' : 'Rules only'}</span>
                                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{String(evidence.strategyState || 'state unavailable')}</span>
                              </div>
                              {riskFlags.length > 0 && (
                                <div className="mt-2 space-y-1 text-[10px] leading-relaxed text-amber-300">
                                  {riskFlags.map((flag, index) => <div key={`${flag}-${index}`}>• {flag}</div>)}
                                </div>
                              )}
                            </div>

                            <div className="rounded-lg bg-zinc-950/65 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Risk policy and baseline</div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] text-zinc-500">
                                <div>Policy <span className="block font-mono text-xs text-zinc-200">{position.policy_version || 'paper-exit-v2'}</span></div>
                                <div>Premium trail <span className="block font-mono text-xs text-zinc-200">{Number(position.decision_trailing_stop_pct || position.trailing_stop_loss_pct || 0) > 0 ? `${number(position.decision_trailing_stop_pct || position.trailing_stop_loss_pct)}%` : '—'}</span></div>
                                <div>Underlying stop <span className="block font-mono text-xs text-rose-200">{money(position.underlying_stop_price || position.suggested_stop_loss)}</span></div>
                                <div>Target 2 <span className="block font-mono text-xs text-sky-200">{money(position.suggested_take_profit_2)}</span></div>
                              </div>
                              <div className="mt-2 border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">
                                1-contract baseline <span className="font-mono text-zinc-300">{hasBaseline ? money(baselinePnl) : '—'}</span>
                                {isClosed && hasBaseline && (
                                  <span className={`ml-2 font-mono ${tradePnl - baselinePnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                    {tradePnl - baselinePnl >= 0 ? '+' : ''}{money(tradePnl - baselinePnl)} sizing value
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-3 lg:grid-cols-[0.75fr_1.25fr]">
                            <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Entry evidence</div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] text-zinc-500">
                                <div>Bid <span className="block font-mono text-zinc-300">{money(evidence.bid)}</span></div>
                                <div>Ask <span className="block font-mono text-zinc-300">{money(evidence.ask)}</span></div>
                                <div>Quote age <span className="block font-mono text-zinc-300">{Number.isFinite(Number(evidence.quoteAgeSeconds)) ? `${number(evidence.quoteAgeSeconds, 1)}s` : '—'}</span></div>
                                <div>Best premium <span className="block font-mono text-zinc-300">{money(analysis.trailingHighPremium || position.trailing_high_price)}</span></div>
                              </div>
                            </div>
                            <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Trade timeline</div>
                                <div className="font-mono text-[9px] text-zinc-600">{relatedOrders.length} orders · {relatedJournal.length} events</div>
                              </div>
                              <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
                                {relatedJournal.length > 0 ? [...relatedJournal].reverse().slice(-12).map(item => (
                                  <div key={item.id} className="grid grid-cols-[4.5rem_1fr] gap-2 text-[10px]">
                                    <span className="font-mono text-zinc-600">{time(item.created_at)}</span>
                                    <span className="leading-relaxed text-zinc-400"><span className="font-semibold text-zinc-300">{item.event_type.replace(/_/g, ' ')}</span> · {item.message}</span>
                                  </div>
                                )) : (
                                  <div className="text-[10px] text-zinc-600">No matching lifecycle events were recorded.</div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          </details>

          {paperAccount.journal.length > 0 && (
            <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
                Paper trade journal
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="max-h-72 divide-y divide-zinc-800 overflow-y-auto border-t border-zinc-800 px-3">
                {paperAccount.journal.map(item => (
                  <div key={item.id} className="grid gap-1 py-2.5 sm:grid-cols-[150px_1fr_auto] sm:gap-3">
                    <span className="font-mono text-[11px] text-violet-300">{item.event_type.replace(/_/g, ' ')}</span>
                    <span className="text-xs leading-relaxed text-zinc-300">{item.message}</span>
                    <span className="font-mono text-[10px] text-zinc-500">{dateTime(item.created_at)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {paperAccount.monthlyReports.length > 0 && (
            <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
                Monthly paper performance
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="divide-y divide-zinc-800 border-t border-zinc-800 px-3">
                {paperAccount.monthlyReports.slice(0, 6).map(item => (
                  <div key={item.month} className="grid grid-cols-4 gap-2 py-2.5 font-mono text-[11px] text-zinc-400">
                    <span className="text-zinc-200">{item.month}</span>
                    <span>{money(item.report.closingEquity)}</span>
                    <span className={Number(item.report.returnPct) >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{number(item.report.returnPct)}%</span>
                    <span>{item.report.closedTrades || 0} trades</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          </div>
        </section>
      )}

      {lifecycle === 'ACTIVE' && !signalDismissed && !executionMode.autonomous && canExecute && (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 rounded-xl border border-zinc-700/90 bg-zinc-950/95 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur md:hidden">
          <Button
            className="h-11 w-full bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500"
            onClick={requestExecution}
          >
            <Play className="mr-2 h-4 w-4" />
            Review {side || ''} order
          </Button>
        </div>
      )}

      {actionMessage && (
        <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
          actionMessage.tone === 'success'
            ? 'border-emerald-500/25 bg-emerald-950/15 text-emerald-200'
            : 'border-rose-500/25 bg-rose-950/15 text-rose-200'
        }`}>
          {actionMessage.tone === 'success'
            ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
            : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{actionMessage.text}</span>
        </div>
      )}

      {linkedPosition && (
        <PositionSummary
          position={linkedPosition}
          option={option}
          side={side}
          spot={strategySignal?.spot || linkedPosition.underlying_price}
          invalidation={setup?.invalidation || linkedPosition.underlying_stop_price}
          target={targetTwo}
        />
      )}

      {entryReviewAvailable && <section className="rounded-lg border border-zinc-800 bg-[#101216] px-2.5 py-2 sm:px-3">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="shrink-0 px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Hard risk</div>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:divide-zinc-800">
            <CompactRiskMetric label="Premium risk" value={orderDebit > 0 ? money(orderDebit) : '—'} tone="text-amber-200" />
            <CompactRiskMetric label="Debit ceiling" value={strategyDebitLimit > 0 ? money(strategyDebitLimit) : '—'} />
            <CompactRiskMetric label="Quantity" value={`${orderQuantity} · plan ${plannedContracts || '—'}`} />
            <CompactRiskMetric label="Invalidation" value={money(setup?.invalidation)} tone="text-rose-200" />
          </div>
        </div>
      </section>}

      <section className="rounded-xl border border-zinc-800 bg-[#101216] p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Optional AI review
            </div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">
              {entryReviewAvailable ? 'Explain this setup in plain language' : 'Explain the current directional bias'}
            </h3>
            <p className="mt-1 text-xs text-zinc-500">Runs only when requested. Hard strategy limits remain authoritative.</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {riskAssessment && (
              <Badge variant="outline" className={`font-mono text-[10px] ${
                riskAssessment.verdict === 'ALIGNED'
                  ? 'border-emerald-500/30 bg-emerald-950/25 text-emerald-300'
                  : riskAssessment.verdict === 'CONFLICTED'
                    ? 'border-rose-500/30 bg-rose-950/25 text-rose-300'
                    : 'border-amber-500/30 bg-amber-950/25 text-amber-300'
              }`}>
                {riskAssessment.verdict.replace('_', ' ')}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-10 flex-1 border-sky-500/25 bg-sky-950/15 text-xs text-sky-200 hover:bg-sky-950/30 active:translate-y-px sm:h-8 sm:flex-none sm:text-[10px]"
              onClick={runAdHocRiskReview}
              disabled={!currentSignal || riskLoading || settings.day_trading_ai_enabled === 'false' || !reviewDataFresh}
              title={staleReviewReason || 'Review the current setup using all available strategy and GEX evidence'}
            >
              {riskLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              {entryReviewAvailable ? 'Review setup with AI' : 'Review bias with AI'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 px-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 sm:h-8"
              onClick={() => setAiReviewExpanded(value => !value)}
              aria-expanded={aiReviewExpanded}
              title={aiReviewExpanded ? 'Hide AI review details' : 'Show AI review details'}
            >
              <span className="sr-only">{aiReviewExpanded ? 'Hide AI review details' : 'Show AI review details'}</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${aiReviewExpanded ? 'rotate-180' : ''}`} />
            </Button>
          </div>
        </div>

        <div className={aiReviewExpanded ? 'block' : 'hidden'}>
        {(!Number.isFinite(quoteAge) || quoteAge > 15) && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-3 text-xs text-amber-200">
            Option quote is stale or missing. AI can explain the directional setup, but its verdict remains WAIT and execution stays blocked.
          </div>
        )}

        {settings.day_trading_ai_enabled === 'false' ? (
          <div className="mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            AI risk management is disabled in Day Trading settings.
          </div>
        ) : staleReviewReason ? (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-3 text-xs text-amber-200">
            AI review is paused: {staleReviewReason}. Wait for fresh strategy data.
          </div>
        ) : riskLoading ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reviewing this setup and its protected risk plan…
          </div>
        ) : riskAssessment ? (
          <>
            <p className="mt-4 text-sm font-medium leading-relaxed text-zinc-200">{riskAssessment.summary}</p>
            <div className="mt-4 divide-y divide-zinc-800 rounded-lg bg-zinc-950/55 px-3">
              {[
                ['Setup', riskAssessment.likelyPath, 'text-sky-300'],
                ['GEX', riskAssessment.gexRead, 'text-sky-300'],
                ['If it works', riskAssessment.ifRight, 'text-emerald-300'],
                ['Failure', riskAssessment.ifWrong, 'text-rose-300']
              ].map(([label, statement, tone]) => (
                <div key={label} className="grid gap-1 py-2.5 sm:grid-cols-[5rem_1fr] sm:gap-3">
                  <div className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${tone}`}>{label}</div>
                  <div className="text-xs leading-relaxed text-zinc-300">{statement}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-sky-500/15 bg-sky-950/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs leading-relaxed text-zinc-300"><span className="font-semibold text-sky-200">Safest action:</span> {riskAssessment.action}</div>
              <div className="shrink-0 font-mono text-xs text-zinc-400">
                Max planned debit {riskAssessment.maxPlannedLoss != null ? money(riskAssessment.maxPlannedLoss) : '—'}
              </div>
            </div>
            <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/35">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
                Evidence and risk flags
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="grid gap-3 border-t border-zinc-800 p-3 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-300">Supporting data</div>
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {riskAssessment.supportingFactors.length > 0
                      ? riskAssessment.supportingFactors.map((item, index) => <div key={`${item}-${index}`}>• {item}</div>)
                      : <div>No additional supporting evidence identified.</div>}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-300">Risk flags</div>
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {riskAssessment.riskFlags.length > 0
                      ? riskAssessment.riskFlags.map((item, index) => <div key={`${item}-${index}`}>• {item}</div>)
                      : <div>No additional risk flags identified.</div>}
                  </div>
                </div>
              </div>
            </details>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] leading-relaxed text-zinc-600">
              <span>Reviewed {time(riskAssessment.generatedAt)}</span>
              <span>Strategy {relativeAge(snapshotAge)}</span>
              <span>GEX {Number.isFinite(gexAge) ? `${number(gexAge, 1)}s old` : 'age unavailable'}</span>
              <span>AI is advisory only.</span>
            </div>
          </>
        ) : (
          <div className={`mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-xs ${riskError ? 'border-rose-500/25 text-rose-200' : 'border-zinc-800 text-zinc-500'}`}>
            {riskError || (currentSignal ? 'No AI review has been requested for this setup.' : 'A persisted strategy setup is required for AI review.')}
          </div>
        )}
        </div>
      </section>

      <section className={entryReviewAvailable ? 'grid gap-4 lg:grid-cols-[1.1fr_0.9fr]' : ''}>
        {entryReviewAvailable && <article className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Contract quality</div>
              <h3 className="mt-1 text-base font-semibold text-zinc-100">{humanContractName(option, side)}</h3>
              <div className="mt-1 select-all break-all font-mono text-[10px] text-zinc-500" title="Contract symbol">{contractName(option, side)}</div>
            </div>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-950 font-mono text-[10px] text-zinc-300">
              {optionExpiryLabel(option.expiry)}
            </Badge>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-5 border-y border-zinc-800 py-2 sm:grid-cols-4">
            <Metric label="Mark" value={money(option.mark)} />
            <Metric label="Volume" value={integer(option.volume)} />
            <Metric label="Open interest" value={integer(option.openInterest ?? option.open_interest)} />
            <Metric label="Spread" value={Number.isFinite(spreadPct) ? `${number(spreadPct)}%` : '—'} />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            {option.mark != null && Number.isFinite(Number(option.mark))
              ? 'Entry remains blocked when the quote is older than 15 seconds or the spread fails the strategy quality gate.'
              : 'IBKR did not provide a mark. Bid and ask can still support a protected planned limit, but entry remains blocked unless the complete quote passes freshness and spread checks.'}
          </p>
        </article>}

        <article className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Why this setup</div>
          <h3 className="mt-1 text-base font-semibold text-zinc-100">Confirmations and GEX context</h3>
          <div className="mt-4 space-y-2">
            {confirmations.length > 0 ? confirmations.slice(0, 5).map((confirmation: any, index: number) => {
              const label = typeof confirmation === 'string'
                ? confirmation
                : confirmation.label || confirmation.name || confirmation.reason || JSON.stringify(confirmation);
              return (
                <div key={`${label}-${index}`} className="flex items-start gap-2 rounded-lg bg-zinc-950/55 px-3 py-2 text-xs text-zinc-300">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="leading-relaxed">{label}</span>
                </div>
              );
            }) : (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center text-xs text-zinc-500">
                Confirmations will appear when a setup is armed.
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-1 border-t border-zinc-800 pt-3 sm:grid-cols-3 sm:gap-2">
            <Metric label="GEX regime" value={String(primaryGex.regime || primaryGex.gamma_regime || '—')} />
            <Metric label="Gamma flip" value={money(primaryGex.flip || primaryGex.gamma_flip)} />
            <Metric label="Provider age" value={Number.isFinite(gexAge) ? `${number(gexAge, 1)}s` : '—'} />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Fresh authoritative GEX is an entry gate. Regime and gamma levels are context unless a confirmation or blocker names them explicitly.
          </p>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <section id="setup-history" className="min-w-0 scroll-mt-4 rounded-xl border border-zinc-800 bg-[#101216]">
          <div className="hidden p-5 sm:block">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Setup history</div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">Plans, execution and outcome</h3>
          </div>
          <button
            type="button"
            className="flex w-full cursor-pointer items-start justify-between gap-3 p-4 text-left sm:hidden"
            onClick={() => setHistoryExpanded(value => !value)}
            aria-expanded={historyExpanded}
            aria-controls="setup-history-content"
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Setup history</div>
              <h3 className="mt-1 text-base font-semibold text-zinc-100">Plans, execution and outcome</h3>
              <p className="mt-1 text-xs text-zinc-500">Collapsed on mobile · expand for complete lifecycle records.</p>
            </div>
            <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-zinc-500 transition-transform ${historyExpanded ? 'rotate-180' : ''}`} />
          </button>
          <div id="setup-history-content" className={`${historyExpanded ? 'block' : 'hidden'} border-t border-zinc-800 px-4 pb-4 sm:block sm:border-t-0 sm:px-5 sm:pb-5`}>
            <div className="flex justify-end pt-2 sm:pt-0">
              <Button variant="ghost" size="sm" className="h-8 justify-start px-2 text-[10px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" onClick={() => refetchHistory()}>
              <RefreshCw className="mr-1.5 h-3 w-3" /> Refresh history
              </Button>
            </div>
          <div className="mt-2 space-y-2">
            {historyLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map(item => <div key={item} className="h-[4.5rem] animate-pulse rounded-lg bg-zinc-900/70" />)}
              </div>
            ) : historyError ? (
              <div className="rounded-lg border border-rose-500/20 bg-rose-950/10 px-3 py-3 text-xs text-rose-200">
                Strategy history could not be loaded. Refresh after checking Postgres health.
              </div>
            ) : strategyHistory.length > 0 ? (
              strategyHistory.map(setupHistory => <HistorySetupCard key={setupHistory.setup_id} setup={setupHistory} />)
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-8 text-center text-xs text-zinc-500">
                No strategy setups have been recorded yet.
              </div>
            )}
          </div>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-[#101216]">
          <div className="hidden p-5 sm:block">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Live diagnostics</div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">Entry-critical services</h3>
          </div>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between gap-3 p-4 text-left sm:hidden"
            onClick={() => setDiagnosticsExpanded(value => !value)}
            aria-expanded={diagnosticsExpanded}
            aria-controls="live-diagnostics-content"
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Live diagnostics</div>
              <h3 className="mt-1 text-base font-semibold text-zinc-100">Entry-critical services</h3>
              <p className="mt-1 text-xs text-zinc-500">Collapsed on mobile · provider-timestamp ages</p>
            </div>
            <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${diagnosticsExpanded ? 'rotate-180' : ''}`} />
          </button>
          <div id="live-diagnostics-content" className={`${diagnosticsExpanded ? 'block' : 'hidden'} border-t border-zinc-800 px-4 pb-4 sm:block sm:border-t-0 sm:px-5 sm:pb-5`}>
            <div className="mt-3 flex justify-end">
              <Link to="/system-health" className="text-[10px] font-semibold text-sky-300 hover:text-sky-200">Full health →</Link>
            </div>
            <div className="mt-1">
              {diagnostics.map(item => <DiagnosticRow key={item.label} {...item} />)}
            </div>
            {healthError && (
              <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-950/10 px-3 py-2 text-xs text-rose-200">
                Health refresh failed: {healthError}
              </div>
            )}
          </div>
        </section>
      </section>

      {signalsLoading && !currentSignal && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading strategy state
        </div>
      )}

      <Dialog open={!!paperClosePosition} onOpenChange={open => {
        if (!open && !paperClosing) {
          setPaperClosePosition(null);
          setPaperForceCloseAvailable(false);
        }
      }}>
        <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-md border-zinc-800 bg-[#101216] text-zinc-100 sm:w-full">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Close this paper position?</DialogTitle>
            <DialogDescription className="text-zinc-500">
              {paperClosePosition && isExpiredOption(paperClosePosition.expiration_date)
                ? 'This expired contract cannot provide a fresh executable IBKR bid. Close it explicitly at the last recorded paper mark.'
                : 'The complete paper quantity will be sold at a fresh IBKR bid and recorded in the system paper ledger.'}
            </DialogDescription>
          </DialogHeader>
          {paperClosePosition && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                Paper account only. No Wealthsimple order will be created, changed or cancelled. The first close attempt requires an IBKR bid no older than 15 seconds.
              </div>
              {paperForceCloseAvailable && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-950/15 px-3 py-2.5 text-xs leading-relaxed text-rose-200">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {isExpiredOption(paperClosePosition.expiration_date)
                    ? 'This contract has expired. Force close records the exit at the latest Redis paper mark, or the stored paper mark when Redis has none. This is ledger recovery, not an executable market price.'
                    : 'Fresh IBKR pricing is unavailable. Force close records the exit at the latest Redis paper mark, or the stored paper mark when Redis has none. This price may not be executable in the market.'}
                </div>
              )}
              {actionMessage?.tone === 'error' && (
                <div className="rounded-lg border border-rose-500/25 bg-rose-950/15 px-3 py-2.5 text-xs leading-relaxed text-rose-200">
                  {actionMessage.text}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Contract</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">
                    {paperClosePosition.symbol} {paperClosePosition.option_type} {money(paperClosePosition.strike_price)}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Quantity</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">{paperClosePosition.quantity}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Entry</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">{money(paperClosePosition.entry_price)}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Latest paper mark</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">{money(paperClosePosition.current_price)}</div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => {
              setPaperClosePosition(null);
              setPaperForceCloseAvailable(false);
            }} disabled={paperClosing} className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
              Keep position
            </Button>
            {paperForceCloseAvailable && (
              <Button onClick={() => confirmPaperClose(true)} disabled={paperClosing} className="bg-rose-700 font-semibold text-white hover:bg-rose-600">
                {paperClosing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Force close at paper mark
              </Button>
            )}
            <Button onClick={() => confirmPaperClose(false)} disabled={paperClosing} className="bg-rose-500 font-semibold text-white hover:bg-rose-400">
              {paperClosing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {paperForceCloseAvailable ? 'Retry fresh bid' : 'Close paper position'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dismissSignal} onOpenChange={open => !open && !dismissing && setDismissSignal(null)}>
        <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-md border-zinc-800 bg-[#101216] text-zinc-100 sm:w-full">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Dismiss this setup?</DialogTitle>
            <DialogDescription className="text-zinc-500">
              This closes the current setup for your account. You will need to wait for a newly qualified setup before placing an entry.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2.5 text-xs text-amber-200">
            {dismissStillCurrent
              ? 'No broker order will be sent or cancelled. Any existing position remains managed separately.'
              : 'The strategy published a different setup while this confirmation was open. Close this dialog and review the new setup.'}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDismissSignal(null)} disabled={dismissing} className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
              Keep setup
            </Button>
            <Button onClick={cancelSetup} disabled={dismissing || !dismissStillCurrent} className="bg-zinc-200 font-semibold text-zinc-950 hover:bg-white">
              {dismissing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Dismiss setup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!executeSignal} onOpenChange={open => !open && !executing && setExecuteSignal(null)}>
        <DialogContent className="max-h-[92dvh] w-[calc(100%_-_1.5rem)] max-w-lg overflow-y-auto border-zinc-800 bg-[#101216] text-zinc-100 sm:w-full">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Confirm {executionMode.live ? 'live' : 'simulated'} order</DialogTitle>
            <DialogDescription className="text-zinc-500">
              This is the final manual approval. Market data, lifecycle and risk limits are checked again before submission.
            </DialogDescription>
          </DialogHeader>

          {executeSignal && (
            <div className="space-y-3">
              {executionMode.live && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-200">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  This sends a real order to the selected Wealthsimple account.
                </div>
              )}
              <div className={`rounded-lg border px-3 py-2.5 ${canConfirmExecution ? 'border-emerald-500/20 bg-emerald-950/10' : 'border-rose-500/25 bg-rose-950/10'}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-xs font-semibold ${canConfirmExecution ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {canConfirmExecution ? `Approval data expires in ${approvalSecondsRemaining}s` : 'Order review expired'}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">{marketSessionLabel}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] tabular-nums text-zinc-500">
                  <span>Strategy<br /><span className="text-zinc-300">{number(snapshotAge, 1)}s</span></span>
                  <span>Quote<br /><span className="text-zinc-300">{number(quoteAge, 1)}s · {Number.isFinite(spreadPct) ? `${number(spreadPct)}%` : '—'}</span></span>
                  <span>GEX<br /><span className="text-zinc-300">{number(gexAge, 1)}s</span></span>
                </div>
                {!canConfirmExecution && <div className="mt-2 text-xs leading-relaxed text-rose-200">{approvalBlocker}</div>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Contract</div>
                  <div className="mt-1 text-xs font-semibold text-zinc-100">{humanContractName(option, side)}</div>
                  <div className="mt-1 break-all font-mono text-[9px] text-zinc-600">{option.ticker || option.local_symbol || `SPY ${side}`}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Quantity</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{orderQuantity}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Protected limit ceiling</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{money(plannedLimit)}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Latest estimated debit</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{money(orderDebit)}</div>
                </div>
                <div className="col-span-2 rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Strategy protection</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">
                    stop {money(setup?.invalidation || executeSignal.stop_loss)} · target {money(executeSignal.target_price || targets[1] || targets[0])}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Limit order only · quantity and debit remain server-enforced
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setExecuteSignal(null)}
              disabled={executing}
              className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            >
              Back
            </Button>
            <Button
              onClick={confirmExecution}
              disabled={executing || !canConfirmExecution}
              className={executionMode.live
                ? 'bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400'
                : 'bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400'}
            >
              {executing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {!canConfirmExecution ? 'Refresh setup to continue' : executionMode.live ? 'Send live order' : 'Create simulation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
