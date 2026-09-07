/** Pure helpers, constants and types shared by the Day Trading terminal components. */
import { api, type OptionDetailsJSON, type PaperAccountSummary, type Position } from '@/lib/api';

export type LifecycleTone = 'idle' | 'armed' | 'active' | 'manage' | 'complete' | 'blocked';
export type PaperActivityTab = 'trades' | 'orders' | 'events';
export type ServicesHealth = Awaited<ReturnType<typeof api.getServicesHealth>>;
export const MAX_GEX_PROVIDER_AGE_SECONDS = 120;
export const BROWSER_SETUP_ALERTS_KEY = 'day-trading-browser-setup-alerts';

export const PAPER_ACTIVITY_FILTERS: Record<PaperActivityTab, Array<{ value: string; label: string }>> = {
  trades: [
    { value: 'ALL', label: 'All trades' },
    { value: 'OPEN', label: 'Open' },
    { value: 'CLOSED', label: 'Closed' },
    { value: 'WIN', label: 'Winners' },
    { value: 'LOSS', label: 'Losses' },
    { value: 'ATTENTION', label: 'Needs attention' }
  ],
  orders: [
    { value: 'ALL', label: 'All orders' },
    { value: 'FILLED', label: 'Filled' },
    { value: 'PENDING', label: 'Pending' },
    { value: 'REJECTED', label: 'Rejected' },
    { value: 'EXPIRED', label: 'Expired' },
    { value: 'FAILED', label: 'Failed' }
  ],
  events: [
    { value: 'ALL', label: 'All events' },
    { value: 'DECISION', label: 'Decisions' },
    { value: 'ENTRY', label: 'Entries' },
    { value: 'TARGET', label: 'Targets and trims' },
    { value: 'EXIT', label: 'Exits and stops' },
    { value: 'ERROR', label: 'Errors' }
  ]
};

export const paperRecordLinksToPosition = (
  position: PaperAccountSummary['recentPositions'][number],
  record: { position_id?: number | string | null; setup_id?: string | null; decision_id?: number | string | null }
) => {
  const setupId = String(position.strategy_setup_id || '');
  const decisionId = Number(position.paper_decision_id || 0);
  return Number(record.position_id || 0) === Number(position.id)
    || Boolean(setupId && record.setup_id === setupId)
    || Boolean(decisionId > 0 && Number(record.decision_id || 0) === decisionId);
};

export const paperOrderNeedsAttention = (order: PaperAccountSummary['recentOrders'][number]) => {
  const status = String(order.status || '').toUpperCase();
  return ['REJECTED', 'FAILED'].includes(status)
    || Boolean(order.failure_reason && !['EXPIRED', 'CANCELLED'].includes(status));
};

export const paperOrderCashEffect = (order: PaperAccountSummary['recentOrders'][number]) => {
  const status = String(order.status || '').toUpperCase();
  const intent = String(order.intent || '').toUpperCase();
  const fillPrice = Number(order.fill_price || 0);
  const quantity = Number(order.quantity || 0);
  if (status === 'FILLED' && fillPrice > 0 && quantity > 0) {
    return {
      amount: fillPrice * quantity * 100,
      label: intent === 'ENTRY' ? 'Debit' : 'Credit'
    };
  }
  if (status === 'PENDING' && intent === 'ENTRY') {
    return { amount: Number(order.reserved_debit || 0), label: 'Reserved' };
  }
  if (status === 'PENDING') return { amount: 0, label: 'Awaiting fill' };
  return { amount: 0, label: 'No cash effect' };
};

export const paperEventCategory = (eventType: string) => {
  const value = eventType.toUpperCase();
  if (/(ERROR|FAIL|REJECT)/.test(value)) return 'ERROR';
  if (/(TARGET|TP1|TP2|TRIM|PROTECT)/.test(value)) return 'TARGET';
  if (/(EXIT|CLOSE|STOP|INVALID)/.test(value)) return 'EXIT';
  if (/(ENTRY|OPEN|FILLED)/.test(value)) return 'ENTRY';
  if (/(DECISION|SKIP|EVALUAT)/.test(value)) return 'DECISION';
  return 'OTHER';
};

export const dateInNewYork = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(date);

export const isExpiredOption = (expiration: unknown) => {
  const value = String(expiration || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value < dateInNewYork();
};

export const money = (value: unknown, decimals = 2) => {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(decimals)}` : '—';
};

export const number = (value: unknown, decimals = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : '—';
};

export const integer = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString('en-US') : '—';
};

export const etMinute = (value: unknown) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 24 * 60) return '—';
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
};

export const time = (value?: string | number | null) => {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : '—';
};

export const dateTime = (value?: string | number | null) => {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';
};

export const duration = (startValue?: string | null, endValue?: string | null) => {
  const start = startValue ? new Date(startValue).getTime() : Number.NaN;
  const end = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'duration unavailable';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

export const relativeAge = (seconds: unknown) => {
  const age = Number(seconds);
  if (!Number.isFinite(age)) return 'No snapshot';
  if (age < 0) return 'Clock skew';
  if (age < 1) return 'Live';
  if (age < 60) return `${age.toFixed(1)}s ago`;
  return `${Math.round(age / 60)}m ago`;
};

export const compactAge = (milliseconds: unknown) => {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return 'age unavailable';
  return relativeAge(value / 1000);
};

export const gexAgeSeconds = (signal: Record<string, any> | null) => {
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

export const marketDataReadinessCopy = (readiness: Record<string, any> | null) => {
  const summary = String(readiness?.summary || '').trim();
  if (summary) return summary;
  const code = String(readiness?.codes?.[0] || '').trim();
  return code ? code.replace(/_/g, ' ').toLowerCase() : 'IBKR market-data readiness is unavailable';
};

export const contractName = (option: OptionDetailsJSON | Record<string, any>, side: string | null) => (
  option.ticker || option.local_symbol || (side ? `SPY ${side}` : 'No contract selected')
);

export const optionExpiryLabel = (expiryValue: unknown) => {
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

export const humanContractName = (option: OptionDetailsJSON | Record<string, any>, side: string | null) => {
  const expiryLabel = optionExpiryLabel(option.expiry);
  const strike = Number(option.strike);
  const strikeLabel = Number.isFinite(strike) ? `$${strike.toFixed(2).replace(/\.00$/, '')}` : 'strike unavailable';
  const sideLabel = side ? `${side[0]}${side.slice(1).toLowerCase()}` : 'option';
  return `SPY ${strikeLabel} ${sideLabel} · ${expiryLabel}`;
};

export const optionSpreadPct = (option: OptionDetailsJSON | Record<string, any>) => {
  const supplied = Number(option.spreadPct ?? option.spread_pct);
  if ((option.spreadPct != null || option.spread_pct != null) && Number.isFinite(supplied)) return supplied;
  const bid = Number(option.bid);
  const ask = Number(option.ask);
  const midpoint = (bid + ask) / 2;
  return bid > 0 && ask >= bid && midpoint > 0 ? ((ask - bid) / midpoint) * 100 : Number.NaN;
};

export const levelDistance = (spot: unknown, level: unknown) => {
  const current = Number(spot);
  const target = Number(level);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return '—';
  const distance = target - current;
  return `${distance >= 0 ? '+' : '−'}$${Math.abs(distance).toFixed(2)}`;
};

export const lifecycleTone = (state: string): LifecycleTone => {
  if (state === 'ACTIVE') return 'active';
  if (state === 'MANAGE' || state === 'EXTENDED') return 'manage';
  if (state === 'ARMED') return 'armed';
  if (state === 'COMPLETED') return 'complete';
  if (['INVALIDATED', 'TRACKING_ABORTED', 'FAILED'].includes(state)) return 'blocked';
  return 'idle';
};

export const toneClasses: Record<LifecycleTone, string> = {
  idle: 'border-zinc-800 bg-zinc-900/55 text-zinc-300',
  armed: 'border-amber-500/30 bg-amber-950/15 text-amber-200',
  active: 'border-emerald-500/35 bg-emerald-950/20 text-emerald-100',
  manage: 'border-sky-500/35 bg-sky-950/20 text-sky-100',
  complete: 'border-teal-500/30 bg-teal-950/20 text-teal-100',
  blocked: 'border-rose-500/30 bg-rose-950/15 text-rose-100'
};

export const stateCopy = (state: string, side: string | null, autonomousEntry = false) => {
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
        description: 'No action is required. Each strategy lane will surface its own plan when its gates align.'
      };
  }
};

export const optionSide = (strategySignal: Record<string, any> | null) => {
  if (strategySignal?.favoring === 'calls') return 'CALL';
  if (strategySignal?.favoring === 'puts') return 'PUT';
  return null;
};

export const strategyDisplay = (strategy?: string | null) => {
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
    },
    GEX_WALL_REJECTION: {
      name: 'GEX wall rejection',
      explanation: 'SPY touched a dealer gamma wall and printed a rejection candle with 5-minute and 15-minute structure aligned against the wall.'
    },
    GEX_WALL_BREAK_FAIL: {
      name: 'GEX wall failed break',
      explanation: 'SPY broke through a dealer gamma wall, failed to hold it, and confirmed the failure on a retest.'
    }
  };
  return strategies[code] || {
    name: code ? code.toLowerCase().replace(/_/g, ' ') : 'Strategy setup',
    explanation: 'The configured strategy confirmation gates produced this setup.'
  };
};

export const getExecutionMode = (settings: Record<string, string>) => {
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
