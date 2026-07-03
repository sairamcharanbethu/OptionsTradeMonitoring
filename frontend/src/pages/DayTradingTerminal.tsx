import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useSignals, useSettings, useScannerLogs, useSnaptradePortfolio, useTradeUsage, useLiveMacroMetrics, QUERY_KEYS } from '@/hooks/useDashboardData';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, Signal, ScannerLog, LiveMacroMetrics } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import {
  Terminal as TerminalIcon,
  ShieldAlert,
  TrendingUp,
  Play,
  XCircle,
  Database,
  AlertCircle,
  HelpCircle,
  Activity,
  ChevronRight,
  Check,
  X,
  RefreshCw,
  Info,
  Clock,
  Sparkles,
  Zap,
  CheckCircle,
  Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';

interface ApiHealthState {
  yahooFinance: { status: string; latencyMs: number | null };
  sscgexPortal: { status: string; latencyMs: number | null };
  thetaData: { status: string; latencyMs: number | null };
  openRouter: { status: string; latencyMs: number | null };
  discord: { status: string; latencyMs: number | null };
  alpaca?: { status: string; latencyMs: number | null };
}

interface ServiceHealthState {
  liveExitMonitor: {
    status: string;
    active: boolean;
    provider: string;
    quotesProcessed: number;
    matchedUpdates: number;
    lastQuoteAt: string | null;
    lastMatchedAt: string | null;
    lastError: string | null;
  };
  streams: {
    alpaca: {
      status: string;
      connected: boolean;
      feed?: string;
      activeSubscriptions: number;
      lastMessageAt: string | null;
      reconnectAttempts: number;
    };
    thetadata: {
      status: string;
      connected: boolean;
      activeSubscriptions: number;
      lastMessageAt: string | null;
      reconnectAttempts: number;
    };
  };
  poller: { status: string; running: boolean };
  scanner: {
    status: string;
    enabled?: boolean;
    marketOpen?: boolean;
    window?: {
      start: string;
      cutoff: string;
      now: string;
      timezone: string;
    };
    lastScanAt?: string | null;
    lastSkippedReason?: string | null;
    intervalSeconds?: number;
    signalSourceUserId?: number;
  };
  snaptradePendingOrders?: {
    status: string;
    running: boolean;
    lastError: string | null;
  };
  tradeRedis?: {
    status: string;
    connected: boolean;
    queueDepth: number | null;
  };
  generatedAt: string;
}

const defaultServiceHealth: ServiceHealthState = {
  liveExitMonitor: {
    status: 'N/A',
    active: false,
    provider: 'none',
    quotesProcessed: 0,
    matchedUpdates: 0,
    lastQuoteAt: null,
    lastMatchedAt: null,
    lastError: null
  },
  streams: {
    alpaca: {
      status: 'N/A',
      connected: false,
      feed: undefined,
      activeSubscriptions: 0,
      lastMessageAt: null,
      reconnectAttempts: 0
    },
    thetadata: {
      status: 'N/A',
      connected: false,
      activeSubscriptions: 0,
      lastMessageAt: null,
      reconnectAttempts: 0
    }
  },
  poller: { status: 'N/A', running: false },
  scanner: { status: 'N/A', enabled: false, marketOpen: false },
  generatedAt: ''
};

const formatRelativeTime = (timestamp?: string | null) => {
  if (!timestamp) return 'no ticks';
  const parsedTime = new Date(timestamp).getTime();
  if (!Number.isFinite(parsedTime)) return 'unknown';
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsedTime) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  return `${Math.round(diffSeconds / 60)}m ago`;
};

const formatDate = (timestamp?: string | null) => {
  if (!timestamp) return '-';
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-US') : '-';
};

const formatTime = (timestamp?: string | null) => {
  if (!timestamp) return '-';
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString('en-US') : '-';
};

const formatNumber = (value: unknown, decimals = 2) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(decimals) : 'N/A';
};

const formatCurrency = (value: unknown, decimals = 2) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(decimals)}` : 'N/A';
};

const formatPercent = (value: unknown, decimals = 1) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(decimals)}%` : 'N/A';
};

const formatSignedPercent = (value: unknown, decimals = 1) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(decimals)}%`;
};

const formatSignedBps = (value: unknown, decimals = 1) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(decimals)} bps`;
};

const formatTenYearYield = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  const yieldPercent = numeric > 20 ? numeric / 10 : numeric;
  return `${yieldPercent.toFixed(2)}%`;
};

const getMacroImpact = (
  change: unknown,
  invertForEquities = true,
  neutralThreshold = 0
): 'positive' | 'negative' | 'neutral' => {
  const numeric = Number(change);
  if (!Number.isFinite(numeric) || Math.abs(numeric) <= neutralThreshold) return 'neutral';
  const isPositiveForRisk = invertForEquities ? numeric < 0 : numeric > 0;
  return isPositiveForRisk ? 'positive' : 'negative';
};

const getMacroToneClass = (impact: 'positive' | 'negative' | 'neutral') => {
  if (impact === 'positive') return 'border-emerald-500/25 bg-emerald-950/20 text-emerald-200';
  if (impact === 'negative') return 'border-red-500/25 bg-red-950/20 text-red-200';
  return 'border-zinc-700/80 bg-zinc-950/40 text-zinc-300';
};

const getMacroImpactLabel = (impact: 'positive' | 'negative' | 'neutral') => {
  if (impact === 'positive') return 'Positive';
  if (impact === 'negative') return 'Negative';
  return 'Neutral';
};

type OpsTone = 'ok' | 'warning' | 'blocked' | 'idle';

const getOpsToneClass = (tone: OpsTone) => {
  if (tone === 'ok') return 'border-emerald-500/25 bg-emerald-950/20 text-emerald-200';
  if (tone === 'warning') return 'border-amber-500/25 bg-amber-950/20 text-amber-200';
  if (tone === 'blocked') return 'border-red-500/25 bg-red-950/20 text-red-200';
  return 'border-zinc-700/80 bg-zinc-950/40 text-zinc-300';
};

const getStatusTone = (status?: string | null, connected?: boolean): OpsTone => {
  if (connected === true) return 'ok';
  const normalized = String(status || '').toUpperCase();
  if (!normalized || normalized === 'N/A' || normalized === 'UNKNOWN') return 'idle';
  if (/(OK|UP|HEALTHY|CONNECTED|RUNNING|ACTIVE|READY|SUCCESS|ONLINE|ENABLED)/.test(normalized)) return 'ok';
  if (/(MARKET_CLOSED|PAUSED|DISABLED|SKIPPED|PENDING|DEGRADED|STALE)/.test(normalized)) return 'warning';
  return 'blocked';
};

const getSystemHealthSummary = (apiHealth: ApiHealthState, services: ServiceHealthState, websocketConnected: boolean, loading: boolean) => {
  if (loading) {
    return {
      label: 'Checking Systems',
      detail: 'Refreshing service status',
      tone: 'border-zinc-700 bg-zinc-950/50 text-zinc-300',
      dot: 'text-zinc-400'
    };
  }

  const issues: string[] = [];
  const warnings: string[] = [];

  Object.entries(apiHealth).forEach(([name, value]) => {
    if (value?.status && value.status !== 'N/A' && value.status !== 'UP') issues.push(`${name} ${value.status}`);
  });

  if (['DOWN', 'ERROR', 'FAILED'].includes(String(services.liveExitMonitor.status || '').toUpperCase())) {
    issues.push(`live exit ${services.liveExitMonitor.status}`);
  } else if (String(services.liveExitMonitor.status || '').toUpperCase() === 'DEGRADED') {
    warnings.push('live exit degraded');
  }
  if (services.liveExitMonitor.lastError) issues.push('live exit error');
  if (!services.poller.running) warnings.push('poller off');
  if (services.snaptradePendingOrders?.lastError) issues.push('broker sync error');
  if (services.tradeRedis?.status === 'DEGRADED') warnings.push('Redis degraded');
  if (!websocketConnected) warnings.push('browser stream disconnected');

  if (issues.length > 0) {
    return {
      label: 'System Degraded',
      detail: issues.slice(0, 2).join(', '),
      tone: 'border-red-500/30 bg-red-950/20 text-red-300',
      dot: 'text-red-400 animate-pulse'
    };
  }

  if (warnings.length > 0) {
    return {
      label: 'System Warning',
      detail: warnings.slice(0, 2).join(', '),
      tone: 'border-amber-500/30 bg-amber-950/20 text-amber-300',
      dot: 'text-amber-400 animate-pulse'
    };
  }

  return {
    label: 'All Systems Normal',
    detail: 'System OK',
    tone: 'border-emerald-500/25 bg-emerald-950/25 text-emerald-300',
    dot: 'text-green-400 animate-pulse'
  };
};

const renderTokenUsageBadge = (usage: any) => {
  if (!usage || (!usage.classifier && !usage.coach)) return null;
  const totalTokens = (usage.classifier?.total_tokens || 0) + (usage.coach?.total_tokens || 0);
  
  return (
    <details className="smooth-details mt-2 rounded border border-emerald-500/10 bg-zinc-950/45 px-2 py-1.5 text-[9px] text-zinc-400">
      <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-zinc-500 hover:text-zinc-300">
        <Database className="h-3 w-3 text-emerald-400" />
        AI usage: <strong className="text-zinc-300">{totalTokens.toLocaleString()}</strong> tokens
      </summary>
      <div className="mt-2 flex flex-wrap gap-2 font-mono">
        {usage.classifier && (
          <span>Classifier <strong className="text-purple-400">{usage.classifier.total_tokens}</strong> ({usage.classifier.prompt_tokens} in/{usage.classifier.completion_tokens} out)</span>
        )}
        {usage.coach && (
          <span>Coach <strong className="text-amber-400">{usage.coach.total_tokens}</strong> ({usage.coach.prompt_tokens} in/{usage.coach.completion_tokens} out)</span>
        )}
      </div>
    </details>
  );
};

const getExecutionBrokerLabel = (broker?: string | null) => {
  switch (broker) {
    case 'alpaca_paper':
      return 'Alpaca Paper (removed)';
    case 'wealthsimple_snaptrade':
      return 'Wealthsimple Live';
    case 'simulated':
      return 'Simulated';
    default:
      return 'No Broker';
  }
};

const getSignalExecutionTone = (signal?: Signal | null) => {
  if (!signal) return 'border-zinc-700 text-zinc-400 bg-zinc-950/40';
  if (signal.execution_status === 'SKIPPED') return 'border-amber-500/40 text-amber-300 bg-amber-950/20';
  if (signal.execution_status === 'FAILED' || signal.execution_error) return 'border-red-500/40 text-red-300 bg-red-950/20';
  if (signal.execution_status === 'PENDING') return 'border-amber-500/40 text-amber-300 bg-amber-950/20';
  if (signal.status === 'EXECUTED') return 'border-emerald-500/40 text-emerald-300 bg-emerald-950/20';
  return 'border-zinc-700 text-zinc-400 bg-zinc-950/40';
};

const getSignalExecutionLabel = (signal?: Signal | null) => {
  if (!signal) return '';
  if (signal.execution_status === 'SKIPPED') return 'SKIPPED';
  if (signal.execution_error) return 'EXEC ERROR';
  return signal.execution_status || '';
};

const getSignalExecutionDisplayStatus = (signal?: Signal | null) => {
  if (!signal) return '';
  const status = String(signal.execution_status || signal.status || '').toUpperCase();
  const labels: Record<string, string> = {
    PENDING: 'Waiting for broker',
    EXECUTED: 'Executed',
    FAILED: 'Execution failed',
    SKIPPED: 'Skipped',
    CANCELLED: 'Cancelled'
  };
  return labels[status] || status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
};

const getSignalExecutionDetailTone = (signal?: Signal | null) => {
  if (signal?.execution_status === 'SKIPPED') return 'border-amber-500/30 bg-amber-950/20 text-amber-100';
  return 'border-red-500/30 bg-red-950/20 text-red-200';
};

const getSetupGradeKey = (setupGrade?: string | null) => {
  const normalized = String(setupGrade || '').toUpperCase();
  if (normalized.includes('A+')) return 'A+';
  if (/(^|[^A-Z])A([^A-Z+]|$)/.test(normalized)) return 'A';
  if (/(^|[^A-Z])B([^A-Z+]|$)/.test(normalized)) return 'B';
  if (/(^|[^A-Z])C([^A-Z+]|$)/.test(normalized)) return 'C';
  return '';
};

const isExecutableSetupGrade = (signal?: Signal | null) => {
  const grade = getSetupGradeKey(signal?.setup_grade);
  return grade === 'A+' || grade === 'A';
};

const getGradeDiagnostics = (signal?: Signal | null) => {
  return signal?.option_details?.gradeDiagnostics || signal?.option_details?.decision?.grade || null;
};

const renderGradeDiagnostics = (signal?: Signal | null) => {
  const diagnostics = getGradeDiagnostics(signal);
  if (!diagnostics) return null;
  const detailItems = [
    `Base ${diagnostics.baseScore}`,
    `Macro ${diagnostics.macroConfidenceAdjustment >= 0 ? '+' : ''}${diagnostics.macroConfidenceAdjustment}`,
    `Pricing ${diagnostics.pricingPenalty}`,
    `Final ${diagnostics.finalConfidence}`
  ];
  const warningItems = [
    ...(diagnostics.pricingWarnings || []),
    ...(diagnostics.blockers || []),
    ...(diagnostics.warnings || [])
  ];

  return (
    <div className="rounded border border-amber-500/20 bg-amber-950/10 p-2.5 text-[10px] text-zinc-300">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold uppercase text-amber-300">Grade diagnostics</span>
        <span className="font-mono text-amber-100">{detailItems.join(' / ')}</span>
      </div>
      <ul className="space-y-1">
        {(diagnostics.reasons || []).map((reason, idx) => (
          <li key={`reason-${idx}`} className="break-words text-zinc-200">{reason}</li>
        ))}
      </ul>
      {warningItems.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {warningItems.slice(0, 6).map((warning, idx) => (
            <span key={`warning-${idx}`} className="rounded border border-amber-500/20 bg-zinc-950/60 px-1.5 py-0.5 text-[9px] text-amber-200">
              {warning}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const getSetupRank = (signal?: Signal | null) => {
  const grade = getSetupGradeKey(signal?.setup_grade);
  if (grade === 'A+') return 4;
  if (grade === 'A') return 3;
  if (grade === 'B') return 2;
  if (grade === 'C') return 1;
  return 0;
};

const getBestSignal = (items: Signal[]) => {
  return [...items]
    .filter((signal) => signal.signal_type !== 'NONE' && signal.status === 'PENDING')
    .sort((a, b) => {
      const gradeDelta = getSetupRank(b) - getSetupRank(a);
      if (gradeDelta !== 0) return gradeDelta;
      return Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
    })[0] || null;
};

const getSignalSideTone = (side?: string | null) => {
  if (side === 'CALL') return 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200';
  if (side === 'PUT') return 'border-red-500/35 bg-red-950/25 text-red-200';
  return 'border-zinc-700 bg-zinc-950/40 text-zinc-400';
};

const getReadinessTone = (severity: 'ok' | 'warning' | 'blocked') => {
  if (severity === 'ok') return 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200';
  if (severity === 'warning') return 'border-amber-500/30 bg-amber-950/20 text-amber-200';
  return 'border-red-500/30 bg-red-950/20 text-red-200';
};

const formatAccountBalance = (account: any) => {
  const fallbackBalance = Array.isArray(account?.balances)
    ? account.balances.find((balance: any) => balance?.cash !== null && balance?.cash !== undefined)
    : null;
  const rawBalance = account?.cash_balance ?? fallbackBalance?.cash;
  const numericBalance = rawBalance === null || rawBalance === undefined ? null : Number(rawBalance);
  const currency = account?.cash_balance_currency || fallbackBalance?.currency?.code || account?.raw_data?.currency?.code || account?.raw_data?.balance?.currency || 'CAD';

  if (numericBalance === null || Number.isNaN(numericBalance)) {
    return 'Balance N/A';
  }

  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(numericBalance);
};

const DAY_TRADING_SYMBOLS = ['QQQ', 'SPY'] as const;
type DayTradingSymbol = typeof DAY_TRADING_SYMBOLS[number];

function parseEnabledDayTradingSymbols(value?: string): DayTradingSymbol[] {
  const parsed = String(value || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter((symbol): symbol is DayTradingSymbol => DAY_TRADING_SYMBOLS.includes(symbol as DayTradingSymbol));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : [...DAY_TRADING_SYMBOLS];
}

function SymbolLane({
  symbol,
  signal,
  regime,
  blockers,
  onSelect
}: {
  symbol: 'QQQ' | 'SPY';
  signal: Signal | null;
  regime: any;
  blockers: string[];
  onSelect: () => void;
}) {
  const side = signal?.signal_type || 'NONE';
  const isTradeable = Boolean(signal && isExecutableSetupGrade(signal) && blockers.length === 0);
  const tone = isTradeable ? 'ok' : signal ? 'warning' : 'blocked';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`motion-press min-w-0 text-left rounded border px-3 py-2.5 transition-colors hover:border-emerald-400/40 hover:bg-zinc-900/60 ${getReadinessTone(tone)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-zinc-100">{symbol}</div>
            <span className="rounded border border-current/20 bg-zinc-950/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-zinc-300">
              {regime.marketRegime}
            </span>
          </div>
          <div className="mt-1 break-words text-[10px] text-zinc-400">GEX {regime.currentGexRegime} · VIX {formatNumber(regime.vixValue, 1)}</div>
        </div>
        <Badge variant="outline" className={`w-fit text-[10px] font-semibold ${getSignalSideTone(side)}`}>
          {side === 'NONE' ? 'NO SETUP' : side}
        </Badge>
      </div>
      {signal ? (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
          <div className="min-w-0">
            <div className="text-zinc-500">Score</div>
            <div className="break-words font-mono font-semibold text-zinc-100">{signal.confidence_score}%</div>
          </div>
          <div className="min-w-0">
            <div className="text-zinc-500">Grade</div>
            <div className="break-words font-mono font-semibold text-zinc-100">{signal.setup_grade || 'N/A'}</div>
          </div>
          <div className="min-w-0">
            <div className="text-zinc-500">Entry</div>
            <div className="break-words font-mono font-semibold text-zinc-100">{formatCurrency(signal.entry_trigger)}</div>
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-zinc-500">Waiting for a pending setup.</div>
      )}
      <div className="mt-2 border-t border-current/10 pt-2 text-[10px]">
        {isTradeable ? (
          <span className="font-medium text-emerald-200">Ready to review.</span>
        ) : (
          <span className={signal ? 'text-amber-200' : 'text-red-200'}>
            {blockers[0] || (signal ? 'Needs review before execution.' : 'No executable setup.')}
          </span>
        )}
      </div>
    </button>
  );
}

function MacroMetricsStrip({
  signal,
  liveMacro,
  fallbackVix,
  assessmentSide
}: {
  signal: Signal | null;
  liveMacro?: LiveMacroMetrics | null;
  fallbackVix: number;
  assessmentSide?: 'CALL' | 'PUT' | null;
}) {
  const volatility = signal?.volatility;
  const macroRegime = (assessmentSide ? liveMacro?.assessments?.[assessmentSide] : null)
    || volatility?.macroRegime;
  const metrics = [
    {
      key: 'vix',
      label: 'VIX',
      value: formatNumber(liveMacro?.vixQuote ?? volatility?.vixQuote ?? fallbackVix, 1),
      move: formatSignedPercent(liveMacro?.vixChangePercent ?? volatility?.vixChangePercent, 2),
      impact: getMacroImpact(liveMacro?.vixChangePercent ?? volatility?.vixChangePercent, true, 0.05)
    },
    {
      key: 'ten-year',
      label: '10Y',
      value: formatTenYearYield(liveMacro?.tenYearYield ?? volatility?.tenYearYield),
      move: formatSignedBps(liveMacro?.tenYearChangeBps ?? volatility?.tenYearChangeBps, 1),
      impact: getMacroImpact(liveMacro?.tenYearChangeBps ?? volatility?.tenYearChangeBps, true, 0.3)
    },
    {
      key: 'dxy',
      label: 'DXY',
      value: formatNumber(liveMacro?.dxy?.value ?? volatility?.dxy?.value, 2),
      move: formatSignedPercent(liveMacro?.dxy?.changePercent ?? volatility?.dxy?.changePercent, 2),
      impact: getMacroImpact(liveMacro?.dxy?.changePercent ?? volatility?.dxy?.changePercent, true, 0.05)
    },
    {
      key: 'oil',
      label: 'Oil',
      value: formatNumber(liveMacro?.oil?.value ?? volatility?.oil?.value, 2),
      move: formatSignedPercent(liveMacro?.oil?.changePercent ?? volatility?.oil?.changePercent, 2),
      impact: getMacroImpact(liveMacro?.oil?.changePercent ?? volatility?.oil?.changePercent, true, 0.15)
    },
    {
      key: 'gold',
      label: 'Gold',
      value: formatNumber(liveMacro?.gold?.value ?? volatility?.gold?.value, 2),
      move: formatSignedPercent(liveMacro?.gold?.changePercent ?? volatility?.gold?.changePercent, 2),
      impact: getMacroImpact(liveMacro?.gold?.changePercent ?? volatility?.gold?.changePercent, true, 0.10)
    }
  ];
  const hasMacroData = metrics.some(metric => metric.value !== 'N/A' || metric.move !== 'N/A');
  const updatedAt = liveMacro?.generatedAt || signal?.created_at || null;

  return (
    <div className="motion-panel rounded border border-emerald-500/15 bg-zinc-900/25 p-2.5">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/70">Macro</div>
          <div className="mt-0.5 break-words text-[11px] text-zinc-400">
            {hasMacroData && updatedAt
              ? `${liveMacro ? 'Live' : 'Snapshot'} ${formatTime(updatedAt)}`
              : 'Waiting for macro data.'}
          </div>
        </div>
        {macroRegime && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[10px]">
            <Badge variant="outline" className="border-emerald-500/20 bg-zinc-950/40 text-emerald-300">
              {macroRegime.regime || 'MACRO'}
            </Badge>
            <span className="font-mono text-zinc-400">
              Score {formatNumber(macroRegime.score, 0)} · Bias {macroRegime.directionBias || 'MIXED'}{assessmentSide ? ` · ${assessmentSide}` : ''}
            </span>
          </div>
        )}
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.map(metric => (
          <div key={metric.key} className={`rounded border px-2 py-1.5 ${getMacroToneClass(metric.impact)}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase text-zinc-400">{metric.label}</span>
              <span className="rounded border border-current/20 bg-zinc-950/30 px-1.5 py-0.5 text-[9px] font-bold uppercase">
                {getMacroImpactLabel(metric.impact)}
              </span>
            </div>
            <div className="mt-0.5 flex items-end justify-between gap-2 font-mono">
              <span className="text-sm font-semibold text-zinc-100">{metric.value}</span>
              <span className={metric.impact === 'positive' ? 'text-emerald-300' : metric.impact === 'negative' ? 'text-red-300' : 'text-zinc-400'}>
                {metric.move}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const toFiniteNumber = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatDistanceFrom = (price: number | null, level: number | null) => {
  if (price === null || level === null) return 'N/A';
  const diff = price - level;
  const pct = level !== 0 ? (diff / level) * 100 : 0;
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
};

const getLevelDistanceTone = (price: number | null, level: number | null) => {
  if (price === null || level === null) return 'text-zinc-500';
  if (Math.abs(price - level) <= 0.05) return 'text-amber-300';
  return price > level ? 'text-emerald-300' : 'text-red-300';
};

const getStrictBlocker = (reasons: string[], needle: string) => (
  reasons.find(reason => reason.toLowerCase().includes(needle.toLowerCase())) || null
);

type SetupCheckStatus = 'pass' | 'wait' | 'block';

function SetupCheck({
  label,
  status,
  detail
}: {
  label: string;
  status: SetupCheckStatus;
  detail: string;
}) {
  const tone = status === 'pass'
    ? 'border-emerald-500/25 bg-emerald-950/20 text-emerald-200'
    : status === 'block'
      ? 'border-red-500/25 bg-red-950/20 text-red-200'
      : 'border-amber-500/25 bg-amber-950/20 text-amber-200';

  return (
    <div className={`min-w-0 rounded border px-2.5 py-2 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase text-zinc-400">{label}</span>
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === 'wait' ? 'animate-pulse' : ''}`} />
      </div>
      <div className="mt-1 break-words text-[10px] leading-snug text-zinc-200">{detail}</div>
    </div>
  );
}

function LiveSpyLevelsPanel({
  signal,
  log,
  websocketConnected,
  selectedSymbol
}: {
  signal: Signal | null;
  log: ScannerLog | null;
  websocketConnected: boolean;
  selectedSymbol: 'QQQ' | 'SPY' | 'BOTH';
}) {
  const signalTime = signal ? new Date(signal.created_at).getTime() : 0;
  const logTime = log ? new Date(log.created_at).getTime() : 0;
  const useLog = log && (!signal || logTime > signalTime);
  const sourceLabel = useLog ? 'scan log' : signal ? 'signal' : log ? 'scan log' : 'none';
  const updatedAt = useLog ? log?.created_at : signal?.created_at || log?.created_at || null;
  const sourceIndicators = (useLog ? log?.indicators : signal?.indicators) || {};
  const sourceReasons = (useLog ? log?.no_trade_reasons : signal?.no_trade_reasons) || [];
  const side = !useLog && (signal?.signal_type === 'CALL' || signal?.signal_type === 'PUT') ? signal.signal_type : null;
  const price = toFiniteNumber(useLog ? log?.spot_price : signal?.current_price ?? log?.spot_price);
  const gex = !useLog ? signal?.gex || {} : {};
  const flow = String(gex.flowDirection || '').toLowerCase();
  const flipStrike = toFiniteNumber(gex.flipStrike);
  const ema9 = toFiniteNumber(sourceIndicators.ema9);
  const ema21 = toFiniteNumber(sourceIndicators.ema21);
  const vwap = toFiniteNumber(sourceIndicators.vwap);

  const gammaBlocker = sourceReasons.find(reason => /requires (bullish|bearish) gamma/i.test(reason)) || null;
  const emaBlocker = getStrictBlocker(sourceReasons, 'requires price');
  const vwapBlocker = getStrictBlocker(sourceReasons, 'VWAP');
  const volumeBlocker = getStrictBlocker(sourceReasons, 'high-volume');
  const triggerBlocker = getStrictBlocker(sourceReasons, 'prior candle');

  const gammaPass = side === 'CALL'
    ? flow === 'bullish' || (price !== null && flipStrike !== null && price > flipStrike)
    : side === 'PUT'
      ? flow === 'bearish' || (price !== null && flipStrike !== null && price < flipStrike)
      : false;
  const emaPass = side === 'CALL'
    ? price !== null && ema9 !== null && ema21 !== null && price > ema9 && ema9 > ema21
    : side === 'PUT'
      ? price !== null && ema9 !== null && ema21 !== null && price < ema9 && ema9 < ema21
      : false;
  const vwapPass = side === 'CALL'
    ? price !== null && vwap !== null && price >= vwap
    : side === 'PUT'
      ? price !== null && vwap !== null && price <= vwap
      : false;

  const checks = [
    {
      label: 'Gamma',
      status: gammaBlocker ? 'block' as SetupCheckStatus : gammaPass ? 'pass' as SetupCheckStatus : 'wait' as SetupCheckStatus,
      detail: side
        ? gammaBlocker || `${gex.regime || 'GEX'} / ${gex.flowDirection || 'flow N/A'} / flip ${formatCurrency(flipStrike)}`
        : 'Waiting for SPY directional setup.'
    },
    {
      label: 'EMA Stack',
      status: emaBlocker ? 'block' as SetupCheckStatus : emaPass ? 'pass' as SetupCheckStatus : 'wait' as SetupCheckStatus,
      detail: emaBlocker || `Price ${formatCurrency(price)} / EMA9 ${formatCurrency(ema9)} / EMA21 ${formatCurrency(ema21)}`
    },
    {
      label: 'VWAP',
      status: vwapBlocker ? 'block' as SetupCheckStatus : vwapPass ? 'pass' as SetupCheckStatus : 'wait' as SetupCheckStatus,
      detail: vwapBlocker || `VWAP ${formatCurrency(vwap)} / distance ${formatDistanceFrom(price, vwap)}`
    },
    {
      label: 'Volume',
      status: volumeBlocker ? 'block' as SetupCheckStatus : side && !sourceReasons.some(reason => reason.toLowerCase().includes('high-volume')) ? 'pass' as SetupCheckStatus : 'wait' as SetupCheckStatus,
      detail: volumeBlocker || (side ? `${side} volume confirmation is not blocking.` : 'Waiting for confirmation candle.')
    },
    {
      label: 'Trigger',
      status: triggerBlocker ? 'block' as SetupCheckStatus : side && !sourceReasons.some(reason => reason.toLowerCase().includes('prior candle')) ? 'pass' as SetupCheckStatus : 'wait' as SetupCheckStatus,
      detail: triggerBlocker || (side ? `Entry trigger ${formatCurrency(signal?.entry_trigger)}` : 'Waiting for reclaim/break trigger.')
    }
  ];

  const levels = [
    { label: 'Spot', value: price, tone: 'text-zinc-100' },
    { label: 'VWAP', value: vwap },
    { label: 'EMA9', value: ema9 },
    { label: 'EMA21', value: ema21 },
    { label: 'Entry', value: toFiniteNumber(signal?.entry_trigger) },
    { label: 'Stop', value: toFiniteNumber(signal?.stop_loss) },
    { label: 'Target', value: toFiniteNumber(signal?.target_price) },
    { label: 'Gamma flip', value: flipStrike },
    { label: 'Call wall', value: toFiniteNumber(gex.callWall) },
    { label: 'Put wall', value: toFiniteNumber(gex.putWall) },
    { label: 'King node', value: toFiniteNumber(gex.kingNode) },
    { label: 'OR high', value: toFiniteNumber(sourceIndicators.openingRangeHigh) },
    { label: 'OR low', value: toFiniteNumber(sourceIndicators.openingRangeLow) }
  ];
  const actionableChecks = checks.filter(check => check.status === 'pass').length;

  return (
    <div className="motion-panel overflow-hidden rounded border border-sky-500/20 bg-zinc-900/25">
      <div className="flex flex-col gap-2 border-b border-sky-500/10 bg-zinc-950/55 px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="h-4 w-4 text-sky-300" />
            <span className="text-xs font-semibold text-zinc-100">SPY live setup monitor</span>
            {side && (
              <Badge variant="outline" className={`text-[10px] font-semibold ${getSignalSideTone(side)}`}>
                {side}
              </Badge>
            )}
          </div>
          <div className="mt-1 break-words text-[10px] text-zinc-500">
            {sourceLabel === 'none'
              ? 'Waiting for the first SPY scan.'
              : `${sourceLabel} ${formatRelativeTime(updatedAt)} / ${actionableChecks}/5 strict checks passing`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <span className={`rounded border px-2 py-1 font-mono ${websocketConnected ? 'border-emerald-500/25 bg-emerald-950/20 text-emerald-300' : 'border-amber-500/25 bg-amber-950/20 text-amber-300'}`}>
            {websocketConnected ? 'Browser WS live' : 'Browser WS offline'}
          </span>
          <span className="rounded border border-zinc-700 bg-zinc-950/50 px-2 py-1 font-mono text-zinc-400">
            View {selectedSymbol}
          </span>
        </div>
      </div>

      <div className="grid gap-px bg-zinc-800/70 lg:grid-cols-[0.85fr_1.4fr]">
        <div className="bg-zinc-950/55 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-zinc-700/80 bg-zinc-950/70 p-2.5">
              <div className="text-[9px] font-semibold uppercase text-zinc-500">SPY price</div>
              <div className="mt-1 font-mono text-lg font-semibold text-zinc-100">{formatCurrency(price)}</div>
              <div className={`mt-1 text-[10px] ${getLevelDistanceTone(price, vwap)}`}>vs VWAP {formatDistanceFrom(price, vwap)}</div>
            </div>
            <div className="rounded border border-zinc-700/80 bg-zinc-950/70 p-2.5">
              <div className="text-[9px] font-semibold uppercase text-zinc-500">Bias state</div>
              <div className="mt-1 font-mono text-lg font-semibold text-zinc-100">{side || 'WAIT'}</div>
              <div className="mt-1 text-[10px] text-zinc-400">{signal?.setup_grade || log?.outcome || 'No setup yet'}</div>
            </div>
          </div>
          <div className="mt-2 grid gap-2">
            {checks.map(check => (
              <SetupCheck key={check.label} {...check} />
            ))}
          </div>
        </div>

        <div className="bg-zinc-950/45 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-sky-400/80">Level board</div>
            <div className="font-mono text-[10px] text-zinc-500">{updatedAt ? formatTime(updatedAt) : 'N/A'}</div>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {levels.map(level => (
              <div key={level.label} className="min-w-0 rounded border border-zinc-800 bg-zinc-950/70 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[9px] font-semibold uppercase text-zinc-500">{level.label}</span>
                  <span className={`shrink-0 font-mono text-[10px] ${level.tone || getLevelDistanceTone(price, level.value)}`}>
                    {formatCurrency(level.value)}
                  </span>
                </div>
                <div className={`mt-1 truncate font-mono text-[9px] ${getLevelDistanceTone(price, level.value)}`} title={formatDistanceFrom(price, level.value)}>
                  {level.label === 'Spot' ? 'current reference' : formatDistanceFrom(price, level.value)}
                </div>
              </div>
            ))}
          </div>
          {sourceReasons.length > 0 && (
            <details className="smooth-details mt-2 rounded border border-amber-500/15 bg-amber-950/10 px-2.5 py-2">
              <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase text-amber-300">
                Current blockers ({sourceReasons.length})
              </summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {sourceReasons.slice(0, 8).map(reason => (
                  <span key={reason} className="max-w-full break-words rounded border border-amber-500/20 bg-zinc-950/50 px-2 py-1 text-[10px] text-amber-100">
                    {reason}
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function EngineFlowPanel({
  selectedSymbol,
  latestSignal,
  latestLog,
  latestActionableSignal,
  activeBlockers,
  canTradeNow,
  healthData,
  serviceHealth,
  websocketConnected,
  brokerLabel
}: {
  selectedSymbol: 'QQQ' | 'SPY' | 'BOTH';
  latestSignal: Signal | null;
  latestLog: ScannerLog | null;
  latestActionableSignal: Signal | null;
  activeBlockers: string[];
  canTradeNow: boolean;
  healthData: ApiHealthState;
  serviceHealth: ServiceHealthState;
  websocketConnected: boolean;
  brokerLabel: string;
}) {
  const feedConnected = Boolean(serviceHealth.streams.thetadata.connected || serviceHealth.streams.alpaca.connected);
  const scannerTone = getStatusTone(serviceHealth.scanner.status, serviceHealth.scanner.status === 'RUNNING');
  const scoringTone: OpsTone = latestSignal ? 'ok' : latestLog ? 'warning' : 'idle';
  const executionTone: OpsTone = canTradeNow ? 'ok' : latestActionableSignal ? 'warning' : 'idle';
  const monitorTone = getStatusTone(serviceHealth.liveExitMonitor.status, serviceHealth.liveExitMonitor.active);
  const flowItems = [
    {
      label: 'Feed',
      value: feedConnected ? 'Streaming' : 'Polling',
      detail: feedConnected
        ? `${serviceHealth.liveExitMonitor.provider || 'market'} ${formatRelativeTime(serviceHealth.liveExitMonitor.lastQuoteAt)}`
        : `REST ${healthData.yahooFinance.latencyMs || 0}ms`,
      tone: feedConnected ? 'ok' as OpsTone : getStatusTone(healthData.yahooFinance.status)
    },
    {
      label: 'Scan',
      value: serviceHealth.scanner.status || 'N/A',
      detail: serviceHealth.scanner.lastScanAt ? formatRelativeTime(serviceHealth.scanner.lastScanAt) : selectedSymbol,
      tone: scannerTone
    },
    {
      label: 'Score',
      value: latestSignal ? `#${latestSignal.id} ${latestSignal.symbol}` : latestLog ? `${latestLog.symbol} log` : 'No event',
      detail: latestSignal ? `${latestSignal.confidence_score}% ${latestSignal.setup_grade || 'ungraded'}` : latestLog ? latestLog.outcome : 'waiting',
      tone: scoringTone
    },
    {
      label: 'Risk',
      value: canTradeNow ? 'Clear' : activeBlockers[0] || 'Standby',
      detail: activeBlockers.length > 1 ? `${activeBlockers.length} blockers` : 'gate',
      tone: canTradeNow ? 'ok' as OpsTone : activeBlockers.length ? 'blocked' as OpsTone : 'idle' as OpsTone
    },
    {
      label: 'Order',
      value: latestActionableSignal ? latestActionableSignal.status : 'No setup',
      detail: brokerLabel,
      tone: executionTone
    },
    {
      label: 'Monitor',
      value: serviceHealth.liveExitMonitor.active ? 'Active' : serviceHealth.liveExitMonitor.status || 'N/A',
      detail: `${serviceHealth.liveExitMonitor.matchedUpdates || 0} matched`,
      tone: monitorTone
    }
  ];
  const adapters = [
    { label: 'Candle REST', status: healthData.yahooFinance.status, detail: `${healthData.yahooFinance.latencyMs || 0}ms` },
    { label: 'GEX', status: healthData.sscgexPortal.status, detail: `${healthData.sscgexPortal.latencyMs || 0}ms` },
    { label: 'Theta API', status: healthData.thetaData.status, detail: `${healthData.thetaData.latencyMs || 0}ms` },
    {
      label: 'Theta WS',
      status: serviceHealth.streams.thetadata.status,
      detail: `${serviceHealth.streams.thetadata.activeSubscriptions || 0} subs`,
      connected: serviceHealth.streams.thetadata.connected
    },
    {
      label: 'Alpaca WS',
      status: serviceHealth.streams.alpaca.status,
      detail: `${serviceHealth.streams.alpaca.activeSubscriptions || 0} subs`,
      connected: serviceHealth.streams.alpaca.connected
    },
    { label: 'OpenRouter', status: healthData.openRouter.status, detail: `${healthData.openRouter.latencyMs || 0}ms` },
    { label: 'Discord', status: healthData.discord.status, detail: `${healthData.discord.latencyMs || 0}ms` },
    { label: 'Browser WS', status: websocketConnected ? 'CONNECTED' : 'DISCONNECTED', detail: websocketConnected ? 'live' : 'offline', connected: websocketConnected }
  ];

  return (
    <div className="motion-panel overflow-hidden rounded border border-zinc-800 bg-zinc-900/30">
      <div className="flex flex-col gap-2 border-b border-zinc-800 bg-zinc-950/45 px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/70">Engine flow</div>
          <div className="mt-0.5 break-words text-[11px] text-zinc-400">scan rail and live execution gates</div>
        </div>
        <div className="font-mono text-[10px] text-zinc-500">
          {latestSignal ? `last signal ${formatRelativeTime(latestSignal.created_at)}` : latestLog ? `last log ${formatRelativeTime(latestLog.created_at)}` : 'no recent engine event'}
        </div>
      </div>
      <div className="grid gap-px bg-zinc-800/70 md:grid-cols-3 xl:grid-cols-6">
        {flowItems.map((item) => (
          <div key={item.label} className={`min-h-[58px] bg-zinc-950/70 px-3 py-2 ${getOpsToneClass(item.tone)}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase text-zinc-500">{item.label}</span>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
            </div>
            <div className="mt-1 truncate text-xs font-semibold text-zinc-100" title={item.value}>{item.value}</div>
            <div className="truncate font-mono text-[9px] opacity-75" title={item.detail}>{item.detail}</div>
          </div>
        ))}
      </div>
      <details className="smooth-details border-t border-zinc-800 bg-zinc-950/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[10px] font-semibold uppercase text-zinc-500 hover:text-zinc-300">
          Adapter health
          <span className="font-mono normal-case text-zinc-600">{adapters.filter(adapter => getStatusTone(adapter.status, adapter.connected) === 'ok').length}/{adapters.length} ok</span>
        </summary>
        <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-4">
          {adapters.map((adapter) => {
            const tone = getStatusTone(adapter.status, adapter.connected);
            return (
              <div key={adapter.label} className={`flex min-w-0 items-center justify-between gap-2 rounded border px-2.5 py-2 text-[10px] ${getOpsToneClass(tone)}`}>
                <div className="min-w-0">
                  <div className="truncate font-semibold uppercase text-zinc-400">{adapter.label}</div>
                  <div className="truncate font-mono text-zinc-100">{adapter.detail}</div>
                </div>
                <span className="shrink-0 rounded border border-current/20 bg-zinc-950/30 px-1.5 py-0.5 font-mono uppercase">
                  {adapter.status || 'N/A'}
                </span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

export default function DayTradingTerminal() {
  const queryClient = useQueryClient();
  // Smart poll: 3s for 3 mins after a signal with no AI commentary; otherwise 10s
  const [fastPollUntil, setFastPollUntil] = useState<number>(0);
  const pollInterval = Date.now() < fastPollUntil ? 3000 : 10000;
  const { data: signals = [], isLoading, isFetching, refetch } = useSignals(pollInterval);
  const { data: logs = [], isLoading: logsLoading, isFetching: logsFetching, refetch: refetchLogs } = useScannerLogs(pollInterval);
  const { data: liveMacroMetrics, refetch: refetchLiveMacroMetrics } = useLiveMacroMetrics(Math.max(10000, pollInterval));
  const { data: settings = {} } = useSettings();
  const { data: snaptradePortfolio } = useSnaptradePortfolio();
  const { data: tradeUsage, refetch: refetchTradeUsage } = useTradeUsage();
  const isDayTradingEnabled = settings.day_trading_enabled !== 'false';
  const enabledSymbols = useMemo(() => parseEnabledDayTradingSymbols(settings.day_trading_symbols), [settings.day_trading_symbols]);
  const enabledSymbolSet = useMemo(() => new Set(enabledSymbols), [enabledSymbols]);

  // Live real-time WebSocket signals updates integration
  const { isConnected, lastMessage } = useWebSocket();
  useEffect(() => {
    if (lastMessage) {
      if (lastMessage.type === 'NEW_SIGNAL' || lastMessage.type === 'SIGNAL_UPDATED') {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
        setCountdown(300);
      }
      if (lastMessage.type === 'NEW_SCAN_LOG') {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.scannerLogs });
        setCountdown(300);
      }
      if (lastMessage.type === 'SETTINGS_UPDATED') {
        queryClient.invalidateQueries({ queryKey: ['settings'] });
      }
    }
  }, [lastMessage, queryClient]);

  // States
  const [activeTab, setActiveTab] = useState<'signals' | 'logs'>('signals');
  const [selectedSymbol, setSelectedSymbol] = useState<'QQQ' | 'SPY' | 'BOTH'>('BOTH');
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterGrade, setFilterGrade] = useState<string>('ALL');
  const [countdown, setCountdown] = useState(300);
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  const [healthData, setHealthData] = useState<ApiHealthState>({
    yahooFinance: { status: 'UP', latencyMs: 95 },
    sscgexPortal: { status: 'UP', latencyMs: 140 },
    thetaData: { status: 'UP', latencyMs: 110 },
    openRouter: { status: 'UP', latencyMs: 310 },
    discord: { status: 'UP', latencyMs: 120 },
    alpaca: { status: 'N/A', latencyMs: 0 }
  });
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthState>(defaultServiceHealth);
  const [healthLoading, setHealthLoading] = useState(false);
  const [executeDialogSignal, setExecuteDialogSignal] = useState<Signal | null>(null);
  const [executingSignalId, setExecutingSignalId] = useState<number | null>(null);
  useEffect(() => {
    if (selectedSymbol === 'BOTH' && enabledSymbols.length === 1) {
      setSelectedSymbol(enabledSymbols[0]);
      return;
    }
    if (selectedSymbol !== 'BOTH' && !enabledSymbolSet.has(selectedSymbol)) {
      setSelectedSymbol(enabledSymbols[0] || 'QQQ');
    }
  }, [enabledSymbols, enabledSymbolSet, selectedSymbol]);
  const scannerRuntimeStatus = serviceHealth.scanner.status;
  const isScannerMarketClosed = scannerRuntimeStatus === 'MARKET_CLOSED';
  const scannerStatusLabel = !isDayTradingEnabled
    ? 'Scanner paused'
    : isScannerMarketClosed
      ? 'Market closed'
      : scannerRuntimeStatus === 'RUNNING'
        ? 'Scanner running'
        : 'Scanner active';
  const scannerStatusTone = !isDayTradingEnabled
    ? 'border-amber-500/30 bg-amber-950/20 text-amber-300'
    : isScannerMarketClosed
      ? 'border-sky-500/30 bg-sky-950/20 text-sky-300'
      : 'border-emerald-500/30 bg-emerald-950/30 text-emerald-300';
  const scannerWindowLabel = serviceHealth.scanner.window
    ? `${serviceHealth.scanner.window.start}-${serviceHealth.scanner.window.cutoff} ET`
    : '09:30-16:00 ET';
  const systemHealthSummary = getSystemHealthSummary(healthData, serviceHealth, isConnected, healthLoading);

  // Fetch Health on mount and on refresh
  const fetchHealth = async () => {
    setHealthLoading(true);
    try {
      const [health, services] = await Promise.all([
        api.getSignalsHealth(),
        api.getServicesHealth()
      ]);
      setHealthData(health);
      setServiceHealth(services);
    } catch (err: any) {
      console.warn('Failed to load health stats:', err);
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  // 5-minute countdown timer
  useEffect(() => {
    if (!isDayTradingEnabled || isScannerMarketClosed) return;
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // Trigger refresh when timer reaches 0
          refetch();
          refetchLogs();
          refetchLiveMacroMetrics();
          fetchHealth();
          return 300;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refetch, refetchLogs, refetchLiveMacroMetrics, isDayTradingEnabled, isScannerMarketClosed]);

  // Sync manually
  const handleManualSync = () => {
    refetch();
    refetchLogs();
    refetchLiveMacroMetrics();
    refetchTradeUsage();
    fetchHealth();
    setCountdown(300);
  };

  // Trigger a live scan cycle from the UI
  const handleTriggerScan = async () => {
    setTriggerLoading(true);
    setTriggerMsg(null);
    try {
      const res = await api.triggerScan();
      setTriggerMsg(res.message);
      // Enter fast-poll mode: check every 3s for 3 minutes for AI commentary to arrive
      setFastPollUntil(Date.now() + 3 * 60 * 1000);
      setTimeout(() => setTriggerMsg(null), 6000);
    } catch (err: any) {
      setTriggerMsg(`Error: ${err.message}`);
    } finally {
      setTriggerLoading(false);
    }
  };

  // Filter signals: enabled symbols first, then selected symbol tab, then status and grade filters
  const enabledSignals = signals.filter(s => enabledSymbolSet.has(s.symbol as DayTradingSymbol));
  const symbolSignals = enabledSignals
    .filter(s => selectedSymbol === 'BOTH' || s.symbol === selectedSymbol);

  const filteredSignals = symbolSignals
    .filter(s => filterStatus === 'ALL' || s.status === filterStatus)
    .filter(s => {
      if (filterGrade === 'ALL') return true;
      return getSetupGradeKey(s.setup_grade) === filterGrade;
    });

  const enabledLogs = logs.filter(l => enabledSymbolSet.has(l.symbol as DayTradingSymbol));
  const filteredLogs = enabledLogs
    .filter(l => selectedSymbol === 'BOTH' || l.symbol === selectedSymbol);

  // Get currently selected signal object
  const realSelectedSignal = filteredSignals.find(s => s.id === selectedSignalId) || null;
  const selectedLog = filteredLogs.find(l => l.id === selectedLogId) || null;

  const selectedSignal = activeTab === 'signals'
    ? realSelectedSignal
    : (selectedLog ? {
        id: selectedLog.id,
        symbol: selectedLog.symbol,
        market_date: formatDate(selectedLog.created_at),
        created_at: selectedLog.created_at,
        indicators: selectedLog.indicators,
        gex: { regime: selectedLog.regime },
        volatility: { vixQuote: selectedLog.vix },
        no_trade_reasons: selectedLog.no_trade_reasons,
        ml_probability: null,
        ai_coach_commentary: null,
        news_context: null,
        token_usage: null
      } as unknown as Signal : null);

  // Find the single latest pending setup for the selected symbol scope.
  // This card should not disappear just because table filters are narrowed.
  const latestActionableSignal = symbolSignals.find(s => s.signal_type !== 'NONE' && s.status === 'PENDING') || null;

  // Active signals table should exclude the latest actionable setup alert
  const tableSignals = latestActionableSignal
    ? filteredSignals.filter(s => s.id !== latestActionableSignal.id)
    : filteredSignals;

  // Set default selected signal when signals load or tab changes
  useEffect(() => {
    const defaultSignal = latestActionableSignal || tableSignals[0] || null;
    if (defaultSignal) {
      setSelectedSignalId(defaultSignal.id);
    } else {
      setSelectedSignalId(null);
    }
  }, [selectedSymbol, signals, enabledSymbols, latestActionableSignal?.id, tableSignals[0]?.id]);

  // Set default selected log
  useEffect(() => {
    if (filteredLogs.length > 0) {
      setSelectedLogId(filteredLogs[0].id);
    } else {
      setSelectedLogId(null);
    }
  }, [selectedSymbol, logs]);

  // Smart fast-poll: if latest signal has no AI commentary, poll every 3s
  useEffect(() => {
    const latestNoAi = filteredSignals.find(s => s.signal_type !== 'NONE' && !s.ai_coach_commentary);
    if (latestNoAi) {
      const until = Date.now() + 3 * 60 * 1000;
      setFastPollUntil(prev => Math.max(prev, until));
    }
  }, [signals]);

  // Click handler wrapper
  const handleQuickStatus = async (id: number, status: 'EXECUTED' | 'CANCELLED') => {
    if (status === 'EXECUTED') {
      const signal = signals.find(s => s.id === id) || null;
      if (signal) {
        if (!isExecutableSetupGrade(signal)) {
          alert(`Only A and A+ setups can be executed. This setup is ${signal.setup_grade || 'ungraded'}.`);
          return;
        }
        setExecuteDialogSignal(signal);
        return;
      }
    }

    try {
      await api.updateSignalStatus(id, status);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
    } catch (err: any) {
      alert(`Failed to update status: ${err.message}`);
    }
  };

  const confirmExecuteSignal = async () => {
    if (!executeDialogSignal) return;
    setExecutingSignalId(executeDialogSignal.id);
    try {
      await api.updateSignalStatus(executeDialogSignal.id, 'EXECUTED');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage });
      setExecuteDialogSignal(null);
    } catch (err: any) {
      alert(`Failed to execute trade: ${err.message}`);
    } finally {
      setExecutingSignalId(null);
    }
  };

  // Helper to derive active Market Regime (Euphoria, Bullish, Bearish, Neutral)
  // Look at the latest signal or latest log (whichever is newer)
  const getRegimeDetails = (latestLog: ScannerLog | null, latestSignal: Signal | null) => {
    let activeSource: 'signal' | 'log' = 'signal';
    if (latestLog && latestSignal) {
      activeSource = new Date(latestLog.created_at) > new Date(latestSignal.created_at) ? 'log' : 'signal';
    } else if (latestLog) {
      activeSource = 'log';
    }

    const currentGexRegime = activeSource === 'log'
      ? (latestLog?.regime || 'NEUTRAL')
      : (latestSignal?.gex?.regime || 'NEUTRAL');

    const vixValue = activeSource === 'log'
      ? (latestLog?.vix != null ? Number(latestLog.vix) : 14.5)
      : (latestSignal?.volatility?.vixQuote || 14.5);

    const spotPrice = activeSource === 'log'
      ? (latestLog?.spot_price != null ? Number(latestLog.spot_price) : 0)
      : (latestSignal?.current_price || 0);

    const vwapValue = activeSource === 'log'
      ? (latestLog?.indicators?.vwap != null ? Number(latestLog.indicators.vwap) : 0)
      : (latestSignal?.indicators?.vwap || 0);

    let marketRegime = 'NEUTRAL';
    let glowColor = 'shadow-zinc-500/10 border-zinc-800 bg-zinc-900/40 text-zinc-400';
    let badgeBg = 'bg-zinc-950 text-zinc-400 border border-zinc-800';

    if (currentGexRegime === 'POSITIVE' && vixValue <= 13.5) {
      marketRegime = 'EUPHORIA';
      glowColor = 'shadow-[0_0_25px_rgba(168,85,247,0.12)] text-purple-400 border-purple-500/40 bg-gradient-to-br from-purple-950/20 via-zinc-900/40 to-zinc-900/60';
      badgeBg = 'bg-purple-950 text-purple-200 border border-purple-500/50 animate-pulse';
    } else if (currentGexRegime === 'NEGATIVE' || (spotPrice > 0 && spotPrice < vwapValue)) {
      marketRegime = 'BEARISH';
      glowColor = 'shadow-[0_0_25px_rgba(239,68,68,0.12)] text-red-400 border-red-500/45 bg-gradient-to-br from-red-950/20 via-zinc-900/40 to-zinc-900/60';
      badgeBg = 'bg-red-950 text-red-200 border border-red-500/50';
    } else if (currentGexRegime === 'POSITIVE' || (spotPrice > 0 && spotPrice > vwapValue)) {
      marketRegime = 'BULLISH';
      glowColor = 'shadow-[0_0_25px_rgba(16,185,129,0.12)] text-emerald-400 border-emerald-500/45 bg-gradient-to-br from-emerald-950/20 via-zinc-900/40 to-zinc-900/60';
      badgeBg = 'bg-emerald-950 text-emerald-200 border border-emerald-500/50';
    }

    return {
      marketRegime,
      currentGexRegime,
      vixValue,
      spotPrice,
      vwapValue,
      glowColor,
      badgeBg
    };
  };

  const latestQQQSignal = enabledSymbolSet.has('QQQ') ? enabledSignals.find(s => s.symbol === 'QQQ') || null : null;
  const latestSPYSignal = enabledSymbolSet.has('SPY') ? enabledSignals.find(s => s.symbol === 'SPY') || null : null;
  const bestQQQSignal = enabledSymbolSet.has('QQQ') ? getBestSignal(enabledSignals.filter(s => s.symbol === 'QQQ')) : null;
  const bestSPYSignal = enabledSymbolSet.has('SPY') ? getBestSignal(enabledSignals.filter(s => s.symbol === 'SPY')) : null;
  const latestQQQLog = enabledSymbolSet.has('QQQ') ? enabledLogs.find(l => l.symbol === 'QQQ') || null : null;
  const latestSPYLog = enabledSymbolSet.has('SPY') ? enabledLogs.find(l => l.symbol === 'SPY') || null : null;

  const qqqDetails = getRegimeDetails(latestQQQLog, latestQQQSignal);
  const spyDetails = getRegimeDetails(latestSPYLog, latestSPYSignal);

  const activeDetails = selectedSymbol === 'SPY' ? spyDetails : qqqDetails;
  
  const currentGexRegime = activeDetails.currentGexRegime;
  const vixValue = activeDetails.vixValue;
  const spotPrice = activeDetails.spotPrice;
  const vwapValue = activeDetails.vwapValue;
  const marketRegime = activeDetails.marketRegime;
  const regimeGlowColor = activeDetails.glowColor;
  const regimeBadgeBg = activeDetails.badgeBg;

  const latestSignal = filteredSignals[0] || null;
  const latestLog = filteredLogs[0] || null;
  const latestMacroSignal = symbolSignals.find(signal =>
    signal.volatility?.vixQuote != null
    || signal.volatility?.tenYearYield != null
    || signal.volatility?.dxy?.value != null
  ) || symbolSignals[0] || null;


  // Mega-caps change tracking (retrieve from latest log or latest signal, else standard fallback)
  const AAPL_change = latestLog?.indicators?.megaCaps?.AAPL ?? latestSignal?.indicators?.megaCaps?.AAPL ?? 0.0; 
  const MSFT_change = latestLog?.indicators?.megaCaps?.MSFT ?? latestSignal?.indicators?.megaCaps?.MSFT ?? 0.0; 
  const NVDA_change = latestLog?.indicators?.megaCaps?.NVDA ?? latestSignal?.indicators?.megaCaps?.NVDA ?? 0.0;

  const formatMinSec = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const configuredBroker = settings.execution_broker
    || (settings.snaptrade_auto_trade === 'true' ? 'wealthsimple_snaptrade' : 'none');
  const brokerLabel = getExecutionBrokerLabel(configuredBroker);
  const isLiveBroker = configuredBroker === 'wealthsimple_snaptrade';
  const maxTradesPerDay = Number(settings.max_trades_per_day || 2);
  const contractsPerTrade = Number(settings.contracts_per_trade || 1);
  const tradesToday = Number(tradeUsage?.used ?? 0);
  const dailyLimit = Number(tradeUsage?.max ?? maxTradesPerDay);
  const remainingTrades = Math.max(0, Number(tradeUsage?.remaining ?? dailyLimit - tradesToday));
  const selectedSnaptradeAccount = (snaptradePortfolio?.accounts || []).find(
    (account: any) => account.id === settings.snaptrade_trading_account_id
  );
  const selectedAccountLabel = settings.snaptrade_trading_account_id
    ? selectedSnaptradeAccount?.name || `Acct ${String(settings.snaptrade_trading_account_id).slice(-6)}`
    : 'No account';
  const selectedAccountBalance = selectedSnaptradeAccount ? formatAccountBalance(selectedSnaptradeAccount) : 'Balance N/A';
  const missingLiveExecutionItems = isLiveBroker ? [
    settings.snaptrade_auto_trade === 'true' ? null : 'SnapTrade execution off',
    settings.snaptrade_trading_account_id ? null : 'No account',
    settings.live_trading_acknowledged === 'true' ? null : 'Live ack missing'
  ].filter(Boolean) as string[] : [];
  const buildBlockers = (signal?: Signal | null) => [
    !isDayTradingEnabled ? 'Scanner disabled' : null,
    isScannerMarketClosed ? `Outside ${scannerWindowLabel}` : null,
    remainingTrades <= 0 ? 'Daily trade limit reached' : null,
    ...missingLiveExecutionItems,
    signal && !isExecutableSetupGrade(signal) ? `Setup grade ${signal.setup_grade || 'N/A'} is below A/A+` : null,
    signal?.execution_error ? signal.execution_error : null,
    ...((signal?.no_trade_reasons || []).slice(0, 3)),
    !signal ? 'No pending setup' : null
  ].filter(Boolean) as string[];
  const activeBlockers = buildBlockers(latestActionableSignal);
  const qqqBlockers = buildBlockers(bestQQQSignal);
  const spyBlockers = buildBlockers(bestSPYSignal);
  const isExecutionBlocked = activeBlockers.length > 0;
  const bestScopedSignal = selectedSymbol === 'SPY' ? bestSPYSignal : selectedSymbol === 'QQQ' ? bestQQQSignal : (getBestSignal([bestQQQSignal, bestSPYSignal].filter(Boolean) as Signal[]) || latestActionableSignal);
  const canTradeNow = Boolean(bestScopedSignal && buildBlockers(bestScopedSignal).length === 0);
  const primaryDecision = canTradeNow ? 'Ready to review' : bestScopedSignal ? 'Blocked' : 'Wait';
  const primaryDecisionTone = canTradeNow ? 'ok' : bestScopedSignal ? 'warning' : 'blocked';
  const avoidMessage = activeBlockers[0] || (!bestScopedSignal ? 'No A/A+ pending setup in the selected view.' : 'Review setup quality before sending.');
  const readinessItems = [
    { label: 'Broker', value: brokerLabel, tone: isLiveBroker ? 'text-amber-300' : 'text-zinc-400' },
    { label: 'Size', value: `${contractsPerTrade} contract${contractsPerTrade === 1 ? '' : 's'}`, tone: 'text-emerald-300' },
    { label: 'Daily', value: `${tradesToday}/${dailyLimit} used`, tone: remainingTrades > 0 ? 'text-emerald-300' : 'text-red-300' },
    { label: 'Order', value: `${settings.order_type || 'LIMIT'} ${settings.entry_slippage_pct || 3}%`, tone: 'text-zinc-300' },
    { label: 'Account', value: isLiveBroker ? selectedAccountLabel : 'Local sim', tone: isLiveBroker && !settings.snaptrade_trading_account_id ? 'text-red-300' : 'text-zinc-300' },
    ...(isLiveBroker ? [{ label: 'Balance', value: selectedAccountBalance, tone: selectedSnaptradeAccount ? 'text-emerald-300' : 'text-amber-300' }] : [])
  ];

  return (
    <div className="terminal-scanline motion-enter flex max-w-full flex-col gap-3 overflow-x-hidden rounded-lg border border-emerald-500/20 bg-zinc-950 p-2 text-emerald-400 shadow-[0_0_30px_rgba(16,185,129,0.05)] sm:p-3">
      
      {/* Top Banner & Timer Bar */}
      <div className="flex flex-col gap-3 border-b border-emerald-500/20 pb-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-start gap-2 sm:gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-emerald-500/25 bg-emerald-950/35 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
            <TerminalIcon className="h-4 w-4 text-emerald-300" />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[9px] bg-zinc-950/70 border-emerald-500/25 text-emerald-300 font-mono">
                {selectedSymbol === 'BOTH' ? enabledSymbols.join(' + ') : selectedSymbol}
              </Badge>
              <span className="text-[9px] text-zinc-600 font-mono">
                v{import.meta.env.VITE_APP_VERSION || '1.4.1'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              <span className={`break-words px-2 py-1 rounded border font-bold ${scannerStatusTone}`}>
                {scannerStatusLabel}
              </span>
              <span className="break-words rounded border border-zinc-800 bg-zinc-950/55 px-2 py-1 text-zinc-300">
                {isDayTradingEnabled && !isScannerMarketClosed ? `Next ${formatMinSec(countdown)}` : scannerWindowLabel}
              </span>
              <span className="break-words rounded border border-zinc-800 bg-zinc-950/55 px-2 py-1 text-zinc-300">
                Broker {brokerLabel}
              </span>
              <span className="break-words rounded border border-zinc-800 bg-zinc-950/55 px-2 py-1 text-zinc-400">
                Max {maxTradesPerDay}/day
              </span>
            </div>
          </div>
        </div>

        {/* Ticker switcher Tabs & Sync Timer */}
        <div className="flex w-full min-w-0 flex-col flex-wrap items-stretch justify-between gap-2 sm:flex-row sm:items-center xl:w-auto xl:justify-end">
          <div className={`motion-panel grid w-full min-w-0 rounded border border-emerald-500/20 bg-zinc-900 p-1 animate-in fade-in duration-200 sm:w-auto ${enabledSymbols.length > 1 ? 'grid-cols-3 sm:min-w-[210px]' : 'grid-cols-1 sm:min-w-[92px]'}`}>
            {enabledSymbols.map(symbol => (
              <button
                key={symbol}
                onClick={() => setSelectedSymbol(symbol)}
                className={`rounded px-2 py-1.5 text-xs font-bold transition-colors sm:px-3 ${
                  selectedSymbol === symbol ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
                }`}
              >
                {symbol}
              </button>
            ))}
            {enabledSymbols.length > 1 && (
              <button
                onClick={() => setSelectedSymbol('BOTH')}
                className={`rounded px-2 py-1.5 text-xs font-bold transition-colors sm:px-3 ${
                  selectedSymbol === 'BOTH' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
                }`}
              >
                BOTH
              </button>
            )}
          </div>

          {isDayTradingEnabled && !isScannerMarketClosed ? (
            <div className="flex w-full min-w-0 items-center justify-between gap-2 rounded border border-emerald-500/30 bg-emerald-950/40 px-3 py-1.5 text-xs sm:w-auto sm:min-w-[164px] sm:justify-start">
              <Clock className="h-4 w-4 text-emerald-400" />
              <span className="min-w-0 break-words font-bold">Rescan in {formatMinSec(countdown)}</span>
              <button
                onClick={handleManualSync}
                className="motion-press ml-1 text-emerald-500 hover:text-emerald-300"
                title="Force Sync Now"
              >
                <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          ) : (
            <div className="flex w-full min-w-0 items-center gap-2 rounded border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-500 sm:w-auto sm:min-w-[164px]">
              <ShieldAlert className={`h-4 w-4 ${isScannerMarketClosed ? 'text-sky-400/80' : 'text-amber-500/70 animate-pulse'}`} />
              <span className="min-w-0 break-words font-bold tracking-wider">{isScannerMarketClosed ? 'Auto resumes at open' : 'Scanner paused'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Decision-first status */}
      <div className={`motion-panel grid gap-3 rounded border p-2.5 lg:grid-cols-[0.75fr_1.5fr_1fr] ${getReadinessTone(primaryDecisionTone)}`}>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase text-zinc-400">Can I trade now?</div>
          <div className="mt-0.5 text-lg font-semibold text-zinc-100">{primaryDecision}</div>
          <div className="mt-0.5 break-words text-[11px] text-zinc-400">
            {canTradeNow ? 'Execution checks are clear for the best pending setup.' : avoidMessage}
          </div>
        </div>
        <div className="min-w-0 border-t border-current/10 pt-2 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <div className="text-[10px] font-semibold uppercase text-zinc-400">Best setup</div>
          {bestScopedSignal ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={`text-[10px] font-semibold ${getSignalSideTone(bestScopedSignal.signal_type)}`}>
                {bestScopedSignal.symbol} {bestScopedSignal.signal_type}
              </Badge>
              <span className="font-mono text-sm font-semibold text-zinc-100">{bestScopedSignal.confidence_score}%</span>
              <span className="text-xs text-zinc-300">{bestScopedSignal.setup_grade || 'ungraded'}</span>
              <span className="font-mono text-xs text-zinc-400">
                entry {formatCurrency(bestScopedSignal.entry_trigger)}
              </span>
            </div>
          ) : (
            <div className="mt-2 text-sm text-zinc-500">No pending directional setup in this view.</div>
          )}
        </div>
        <div className="min-w-0 border-t border-current/10 pt-2 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <div className="text-[10px] font-semibold uppercase text-zinc-400">What to avoid</div>
          <div className="mt-1.5 break-words text-xs text-zinc-100">{avoidMessage}</div>
          {activeBlockers.length > 1 && (
            <div className="mt-1 break-words text-xs text-zinc-400">{activeBlockers.slice(1, 3).join(' · ')}</div>
          )}
        </div>
      </div>

      {/* QQQ/SPY lanes */}
      <div className={`grid gap-3 ${enabledSymbols.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {enabledSymbolSet.has('QQQ') && (
          <SymbolLane
            symbol="QQQ"
            signal={bestQQQSignal}
            regime={qqqDetails}
            blockers={qqqBlockers}
            onSelect={() => {
              setSelectedSymbol('QQQ');
              if (bestQQQSignal) setSelectedSignalId(bestQQQSignal.id);
            }}
          />
        )}
        {enabledSymbolSet.has('SPY') && (
          <SymbolLane
            symbol="SPY"
            signal={bestSPYSignal}
            regime={spyDetails}
            blockers={spyBlockers}
            onSelect={() => {
              setSelectedSymbol('SPY');
              if (bestSPYSignal) setSelectedSignalId(bestSPYSignal.id);
            }}
          />
        )}
      </div>

      {enabledSymbolSet.has('SPY') && (
        <LiveSpyLevelsPanel
          signal={latestSPYSignal}
          log={latestSPYLog}
          websocketConnected={isConnected}
          selectedSymbol={selectedSymbol}
        />
      )}

      <MacroMetricsStrip
        signal={latestMacroSignal}
        liveMacro={liveMacroMetrics}
        fallbackVix={vixValue}
        assessmentSide={bestScopedSignal?.signal_type === 'CALL' || bestScopedSignal?.signal_type === 'PUT'
          ? bestScopedSignal.signal_type
          : latestMacroSignal?.signal_type === 'CALL' || latestMacroSignal?.signal_type === 'PUT'
            ? latestMacroSignal.signal_type
            : null}
      />

      <EngineFlowPanel
        selectedSymbol={selectedSymbol}
        latestSignal={latestSignal}
        latestLog={latestLog}
        latestActionableSignal={latestActionableSignal}
        activeBlockers={activeBlockers}
        canTradeNow={canTradeNow}
        healthData={healthData}
        serviceHealth={serviceHealth}
        websocketConnected={isConnected}
        brokerLabel={brokerLabel}
      />

      {/* Compact context strip */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        
        {/* Widget 1: Glowing Market Regime Gauge */}
        {selectedSymbol === 'BOTH' && enabledSymbols.length > 1 ? (
          <div className="motion-panel flex min-h-[64px] flex-row items-center justify-between rounded border border-zinc-800 bg-zinc-900/35 p-2.5 shadow-inner shadow-[0_0_20px_rgba(16,185,129,0.02)]">
            <div className="grid w-full grid-cols-1 gap-2 font-mono sm:grid-cols-2">
              {/* QQQ Side */}
              <div className="flex min-w-0 flex-col border-b border-zinc-800/80 pb-2 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-2">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="text-[9px] text-emerald-500/70 uppercase font-semibold">QQQ</span>
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${qqqDetails.badgeBg}`}>
                    {qqqDetails.marketRegime === 'EUPHORIA' ? 'RISK-ON' : qqqDetails.marketRegime === 'BULLISH' ? 'BUY' : qqqDetails.marketRegime === 'BEARISH' ? 'FADE' : 'RANGE'}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-300 block mt-1 font-bold tracking-wider">
                  {qqqDetails.marketRegime}
                </span>
                <span className="text-[9px] text-zinc-400 block mt-0.5">
                  GEX: {qqqDetails.currentGexRegime} · VIX: {formatNumber(qqqDetails.vixValue, 1)}
                </span>
              </div>
              
              {/* SPY Side */}
              <div className="flex min-w-0 flex-col sm:pl-1">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="text-[9px] text-emerald-500/70 uppercase font-semibold">SPY</span>
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${spyDetails.badgeBg}`}>
                    {spyDetails.marketRegime === 'EUPHORIA' ? 'RISK-ON' : spyDetails.marketRegime === 'BULLISH' ? 'BUY' : spyDetails.marketRegime === 'BEARISH' ? 'FADE' : 'RANGE'}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-300 block mt-1 font-bold tracking-wider">
                  {spyDetails.marketRegime}
                </span>
                <span className="text-[9px] text-zinc-400 block mt-0.5">
                  GEX: {spyDetails.currentGexRegime} · VIX: {formatNumber(spyDetails.vixValue, 1)}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className={`motion-panel flex min-h-[64px] flex-row items-center justify-between rounded border bg-zinc-900/35 p-2.5 shadow-inner ${regimeGlowColor}`}>
            <div className="flex min-w-0 flex-col justify-center">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[9px] text-emerald-500/70 uppercase tracking-wider font-semibold">REGIME</span>
                <Badge variant="outline" className="text-[8px] px-1 py-0.5 border-emerald-500/20 text-emerald-400 font-bold uppercase">
                  {selectedSymbol}
                </Badge>
              </div>
              <span className="mt-0.5 block break-words text-lg font-extrabold uppercase tracking-widest drop-shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                {marketRegime}
              </span>
              <span className="block break-words text-[9px] text-zinc-400">
                GEX: {currentGexRegime} · VIX: {formatNumber(vixValue, 1)}
              </span>
            </div>
            <div className="flex shrink-0 items-center pl-2">
              <span className={`rounded px-2 py-1 text-[9px] font-extrabold uppercase select-none ${regimeBadgeBg}`}>
                {marketRegime === 'EUPHORIA' ? 'RISK-ON' : marketRegime === 'BULLISH' ? 'BUY DIPS' : marketRegime === 'BEARISH' ? 'FADE RIPS' : 'RANGE'}
              </span>
            </div>
          </div>
        )}

        {/* Widget 2: Mega Caps Tracking Panel */}
        <div className="motion-panel flex min-h-[64px] flex-col justify-center rounded border border-emerald-500/20 bg-zinc-900/25 p-2.5">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="block text-[9px] font-semibold uppercase tracking-wider text-emerald-500/70">Mega-caps</span>
            <Badge variant="outline" className="text-[8px] px-1 py-0.5 border-emerald-500/20 text-emerald-400">NASDAQ Heavy</Badge>
          </div>
          <div className="grid grid-cols-3 gap-1.5 font-mono text-[10px]">
            <div className="flex flex-col justify-between p-1 border border-emerald-500/5 bg-zinc-950/40 rounded text-center">
              <span className="font-semibold text-zinc-400">AAPL</span>
              <span className={AAPL_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {AAPL_change >= 0 ? '▲' : '▼'} {formatPercent(AAPL_change)}
              </span>
            </div>
            <div className="flex flex-col justify-between p-1 border border-emerald-500/5 bg-zinc-950/40 rounded text-center">
              <span className="font-semibold text-zinc-400">MSFT</span>
              <span className={MSFT_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {MSFT_change >= 0 ? '▲' : '▼'} {formatPercent(MSFT_change)}
              </span>
            </div>
            <div className="flex flex-col justify-between p-1 border border-emerald-500/5 bg-zinc-950/40 rounded text-center">
              <span className="font-semibold text-zinc-400">NVDA</span>
              <span className={NVDA_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {NVDA_change >= 0 ? '▲' : '▼'} {formatPercent(NVDA_change)}
              </span>
            </div>
          </div>
        </div>

        {/* Widget 3: Aggregate system health */}
        <div className={`motion-panel flex min-h-[64px] flex-col justify-center rounded border bg-zinc-900/25 p-2.5 ${systemHealthSummary.tone}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-[9px] font-semibold uppercase tracking-wider opacity-80">System</span>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <span className={systemHealthSummary.dot}>●</span>
                <span className="min-w-0 break-words text-sm font-extrabold tracking-wide">{systemHealthSummary.label}</span>
              </div>
              <div className="mt-1 break-words text-[10px] text-zinc-400">{systemHealthSummary.detail}</div>
            </div>
            <Button asChild variant="outline" size="sm" className="h-7 shrink-0 border-current bg-zinc-950/30 px-2 text-[10px]">
              <Link to="/system-health">
                Details
              </Link>
            </Button>
          </div>
        </div>

      </div>

      {/* Execution Setup */}
      <div className="motion-panel border border-emerald-500/15 rounded bg-zinc-900/30 overflow-hidden">
        <div className="flex flex-col justify-between gap-2 border-b border-emerald-500/10 bg-zinc-900/75 px-3 py-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ShieldAlert className={`h-4 w-4 ${isLiveBroker ? 'text-amber-400 animate-pulse' : 'text-emerald-400'}`} />
            <span className="text-xs font-bold text-emerald-300">Execution setup</span>
            {remainingTrades <= 0 && (
              <Badge variant="outline" className="text-[8px] border-red-500/40 text-red-300 bg-red-950/20">
                Daily limit reached
              </Badge>
            )}
            {missingLiveExecutionItems.map(item => (
              <Badge key={item} variant="outline" className="max-w-full whitespace-normal break-words text-[8px] border-amber-500/40 text-amber-300 bg-amber-950/20">
                {item}
              </Badge>
            ))}
          </div>
          <span className="break-words text-[10px] text-zinc-500">
            {isExecutionBlocked ? `${activeBlockers.length} blocker${activeBlockers.length === 1 ? '' : 's'}` : 'Ready for pending signals.'}
          </span>
	        </div>
	        <div className="grid grid-cols-2 gap-px bg-emerald-500/10 sm:grid-cols-3 xl:grid-cols-6">
          {readinessItems.map(item => (
            <div key={item.label} className="motion-panel flex min-h-[44px] min-w-0 flex-col justify-center bg-zinc-950/70 px-3 py-1.5">
              <span className="text-[9px] uppercase text-zinc-500 font-bold">{item.label}</span>
              <span className={`break-words text-xs font-bold ${item.tone}`} title={item.value}>{item.value}</span>
	            </div>
	          ))}
	        </div>
	        {isExecutionBlocked && (
	          <details className="smooth-details border-t border-red-500/10 bg-red-950/10 px-3 py-2">
	            <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase text-red-300">
                Why not trading ({activeBlockers.length})
              </summary>
	            <div className="mt-2 flex flex-wrap gap-1.5">
	              {activeBlockers.map((blocker) => (
	                <span key={blocker} className="max-w-full break-words rounded border border-red-500/25 bg-red-950/20 px-2 py-1 text-[10px] text-red-200">
	                  {blocker}
	                </span>
	              ))}
	            </div>
	          </details>
	        )}
	      </div>

      {/* Row 2: Separated Prominent latest setup notification */}
      <div 
        onClick={() => latestActionableSignal && setSelectedSignalId(latestActionableSignal.id)}
        className={`motion-panel overflow-hidden rounded-lg border backdrop-blur-md ${
          latestActionableSignal 
            ? 'border-emerald-500/30 bg-zinc-900/55 shadow-[0_18px_60px_rgba(0,0,0,0.28)] cursor-pointer hover:border-emerald-400/50 hover:bg-zinc-900/70'
            : 'border-zinc-800 shadow-inner bg-zinc-900/20'
        }`}
      >
        <div className="flex flex-col items-start justify-between gap-2 border-b border-emerald-500/10 bg-zinc-950/65 px-3 py-2.5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-300" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100">
                Latest setup
              </h3>
              <div className="text-[10px] text-zinc-500">scan {'->'} score {'->'} validate {'->'} execute</div>
            </div>
          </div>
          {!isDayTradingEnabled ? (
            <Badge variant="outline" className="bg-zinc-900 text-zinc-400 border-zinc-700 text-[8px] px-1.5 py-0.5">
              OFFLINE
            </Badge>
          ) : latestActionableSignal ? (
            <Badge variant="outline" className="bg-emerald-950/60 text-emerald-200 border-emerald-500/30 text-[9px] px-2 py-0.5 font-semibold">
              Ready to review
            </Badge>
          ) : (
            <span className="text-[10px] text-zinc-500 font-semibold">No active setup</span>
          )}
        </div>
        
        <div className="p-2.5">
          {!isDayTradingEnabled || isScannerMarketClosed ? (
            <div className="flex flex-col items-center justify-center py-4 text-center text-xs text-zinc-500">
              <ShieldAlert className={`mb-2 h-6 w-6 ${isScannerMarketClosed ? 'text-sky-400/80' : 'text-amber-500/80 animate-pulse'}`} />
              <span className="font-bold text-zinc-300">
                {isScannerMarketClosed ? 'Scanner is waiting for market hours' : 'Day trading scanner is paused'}
              </span>
              <span className="text-[10px] text-zinc-500 mt-1 max-w-md">
                {isScannerMarketClosed
                  ? `Background scans auto-resume during ${scannerWindowLabel}. Manual trigger remains available for testing.`
                  : 'Enable it in Settings to resume background scans.'}
              </span>
            </div>
          ) : !latestActionableSignal ? (
            <div className="flex flex-col items-center justify-center py-4 text-center text-xs text-emerald-500/40">
              <AlertCircle className="mb-2 h-6 w-6 opacity-30" />
              <span>No setup meets your filters right now.</span>
              <span className="text-[10px] text-zinc-500 mt-1">Next scan in {formatMinSec(countdown)}.</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 text-xs lg:grid-cols-[1.45fr_1fr]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-extrabold uppercase ${
                    latestActionableSignal.signal_type === 'CALL' ? 'bg-green-950 text-green-300 border border-green-500/30' : 'bg-red-950 text-red-300 border border-red-500/30'
                  }`}>
                    {latestActionableSignal.signal_type} SIGNAL
                  </span>
                  <span className="text-xs font-bold text-emerald-200">
                    {latestActionableSignal.symbol} {formatCurrency(latestActionableSignal.current_price)}
                  </span>
                  <span className="rounded border border-emerald-500/10 bg-zinc-950/70 px-2 py-1 text-[10px] text-emerald-300 sm:ml-auto">
                    Score: {latestActionableSignal.confidence_score}% ({latestActionableSignal.setup_grade || 'B'})
                  </span>
                  {latestActionableSignal.ml_probability !== undefined && latestActionableSignal.ml_probability !== null && (() => {
                    const mlPct = Math.round(Number(latestActionableSignal.ml_probability) * 100);
                    let colorClass = 'text-emerald-400 border-emerald-500/20 bg-emerald-950/20';
                    if (mlPct < 50) {
                      colorClass = 'text-amber-400 border-amber-500/20 bg-amber-950/20';
                    } else if (mlPct < 75) {
                      colorClass = 'text-sky-400 border-sky-500/20 bg-sky-950/20';
                    }
                    return (
                      <span className={`text-[9px] px-1.5 py-0.5 border rounded font-semibold ${colorClass}`}>
                        ML Confidence: {mlPct}%
                      </span>
                    );
                  })()}
                </div>

                <div className="grid grid-cols-1 gap-2 border-t border-emerald-500/10 pt-2.5 text-center sm:grid-cols-3">
                  <div className="min-w-0 rounded border border-zinc-800 bg-zinc-950/65 p-3">
                    <span className="text-[9px] text-zinc-500 block uppercase font-semibold">Entry trigger</span>
                    <span className="break-words font-mono text-sm font-bold text-emerald-200">
                      &gt;{formatCurrency(latestActionableSignal.entry_trigger)}
                    </span>
                  </div>
                  <div className="min-w-0 rounded border border-zinc-800 bg-zinc-950/65 p-3">
                    <span className="text-[9px] text-zinc-500 block uppercase font-semibold">Stop loss</span>
                    <span className="break-words font-mono text-sm font-bold text-red-300">
                      {formatCurrency(latestActionableSignal.stop_loss)}
                    </span>
                  </div>
                  <div className="min-w-0 rounded border border-zinc-800 bg-zinc-950/65 p-3">
                    <span className="text-[9px] text-zinc-500 block uppercase font-semibold">Target level</span>
                    <span className="break-words font-mono text-sm font-bold text-green-300">
                      {formatCurrency(latestActionableSignal.target_price)}
                    </span>
                  </div>
                </div>

                {latestActionableSignal.option_details && (
                  <div className="grid grid-cols-1 gap-2 rounded border border-sky-500/15 bg-sky-950/10 p-2.5 text-center font-mono text-[10px] text-sky-300 sm:grid-cols-3">
                    <div className="min-w-0">
                      <span className="text-[8px] text-zinc-500 block uppercase font-semibold">OPTION CONTRACT</span>
                      <span className="break-all font-bold text-zinc-300">{latestActionableSignal.option_details.ticker}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="text-[8px] text-zinc-500 block uppercase font-semibold">SUGGESTED PREMIUM</span>
                      <span className="break-words font-bold text-sky-300">
                        {formatCurrency(latestActionableSignal.option_details.mark)}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <span className="text-[8px] text-zinc-500 block uppercase font-semibold">PREMIUM SL / TP</span>
                      <span className="break-words font-bold text-zinc-300">
                        {formatCurrency(latestActionableSignal.option_details.suggestedStopLoss)} / {formatCurrency(latestActionableSignal.option_details.suggestedTakeProfit)}
                      </span>
                    </div>
                  </div>
                )}

                {latestActionableSignal.gex && (
                  <div className="break-words rounded border border-emerald-500/10 bg-zinc-950/60 p-2 font-mono text-[10px] text-zinc-300">
                    Saved option plan: entry near {formatCurrency(latestActionableSignal.option_details?.mark)} | premium stop {formatCurrency(latestActionableSignal.option_details?.suggestedStopLoss)} | premium target {formatCurrency(latestActionableSignal.option_details?.suggestedTakeProfit)}
                  </div>
                )}

                {renderGradeDiagnostics(latestActionableSignal)}

                <div className="grid grid-cols-1 gap-2 border-t border-emerald-500/10 pt-2 text-[10px] sm:grid-cols-2 md:grid-cols-4">
                  <div className="min-w-0 rounded border border-emerald-500/10 bg-zinc-950/50 p-2">
                    <span className="block text-zinc-500 uppercase font-bold">Execution</span>
                    <span className={`break-words ${isLiveBroker ? 'text-amber-300 font-bold' : 'text-sky-300 font-bold'}`}>{brokerLabel}</span>
                  </div>
                  <div className="min-w-0 rounded border border-emerald-500/10 bg-zinc-950/50 p-2">
                    <span className="block text-zinc-500 uppercase font-bold">Quantity</span>
                    <span className="break-words font-bold text-emerald-300">{contractsPerTrade} contract{contractsPerTrade === 1 ? '' : 's'}</span>
                  </div>
                  <div className="min-w-0 rounded border border-emerald-500/10 bg-zinc-950/50 p-2">
                    <span className="block text-zinc-500 uppercase font-bold">Est. Max Debit</span>
                    <span className="break-words font-bold text-zinc-200">
                      {latestActionableSignal.option_details?.mark
                        ? formatCurrency(Number(latestActionableSignal.option_details.mark) * contractsPerTrade * 100)
                        : 'N/A'}
                    </span>
                  </div>
                  <div className={`min-w-0 rounded border bg-zinc-950/50 p-2 ${getSignalExecutionTone(latestActionableSignal)}`}>
                    <span className="block uppercase font-bold opacity-80">Status</span>
                    <span className="break-words font-bold">{getSignalExecutionDisplayStatus(latestActionableSignal)}</span>
                  </div>
                </div>
              </div>

              {/* News-Aware AI Coach Panel */}
              <div className="p-3 rounded border border-zinc-800 bg-zinc-950/45 flex flex-col justify-between gap-2.5">
                <div>
                  <span className="text-[9px] text-emerald-500/60 block uppercase font-bold flex items-center gap-1 mb-1.5">
                    <Zap className="h-3 w-3 text-amber-400 animate-pulse" /> AI coach · news-aware
                  </span>

                  {latestActionableSignal.ai_coach_commentary ? (
                    <div className="space-y-1.5">
                      {/* Render commentary line-by-line, highlight PITFALL/CATALYST tokens */}
                      {latestActionableSignal.ai_coach_commentary.split('\n').filter(Boolean).map((line, i) => {
                        const isPitfall = line.includes('⚠️') || line.toUpperCase().includes('PITFALL');
                        const isCatalyst = line.includes('✅') || line.toUpperCase().includes('CATALYST');
                        return (
                          <p
                            key={i}
                            className={`leading-relaxed text-[10px] ${
                              isPitfall
                                ? 'text-amber-300 bg-amber-950/20 px-1.5 py-0.5 rounded border border-amber-500/20'
                                : isCatalyst
                                ? 'text-green-300 bg-green-950/20 px-1.5 py-0.5 rounded border border-green-500/20'
                                : 'text-zinc-300 italic'
                            }`}
                          >
                            {line}
                          </p>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="leading-relaxed text-zinc-500 italic text-[10px]">
                      AI commentary will appear when the next scanner cycle fires with news context...
                    </p>
                  )}

                  {/* News Context accordion */}
                  {latestActionableSignal.news_context && latestActionableSignal.news_context !== 'No material news in the last 6 hours.' && (
                    <div className="mt-2 border-t border-emerald-500/10 pt-1.5">
                      <span className="text-[8px] text-zinc-500 uppercase font-bold flex items-center gap-1 mb-1">
                        📰 NEWS CONTEXT (used for this analysis)
                      </span>
                      <div className="text-[9px] text-zinc-500 leading-relaxed space-y-0.5">
                        {latestActionableSignal.news_context.split('\n').map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {latestActionableSignal.news_context === 'No material news in the last 6 hours.' && (
                    <div className="mt-1.5 text-[8px] text-zinc-600 italic">📰 No material news in last 6h — technical-only analysis.</div>
                  )}

                  {renderTokenUsageBadge(latestActionableSignal.token_usage)}
                </div>
                <div className="flex flex-col gap-2 border-t border-emerald-500/10 pt-2 sm:flex-row sm:justify-end">
                  <Button
                    size="sm"
                    className="h-7 w-full bg-emerald-800 text-[10px] font-bold text-white shadow-[0_0_0_rgba(16,185,129,0)] hover:bg-emerald-700 hover:shadow-[0_0_18px_rgba(16,185,129,0.25)] sm:h-6 sm:w-auto"
                    disabled={isExecutionBlocked || !isExecutableSetupGrade(latestActionableSignal)}
                    onClick={() => handleQuickStatus(latestActionableSignal.id, 'EXECUTED')}
                  >
                    Execute Trade
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-full text-[10px] text-red-400 hover:bg-red-950/25 hover:text-red-300 sm:h-6 sm:w-auto"
                    onClick={() => handleQuickStatus(latestActionableSignal.id, 'CANCELLED')}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Row 3: Signals Process Table + Detailed Inspector */}
      <div className="grid grid-cols-1 2xl:grid-cols-3 gap-4 lg:gap-6 min-w-0">
        
        {/* Table List (Process Monitor) */}
        <div className="motion-panel 2xl:col-span-2 overflow-hidden flex flex-col border border-emerald-500/20 rounded bg-zinc-900/30 min-w-0">
          
          {/* Tab Selector */}
          <div className="flex bg-zinc-950/80 border-b border-emerald-500/20 p-1">
            <button
              onClick={() => setActiveTab('signals')}
              className={`flex-1 py-2 text-xs font-bold font-mono transition-colors rounded ${
                activeTab === 'signals' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/50 hover:text-emerald-400'
              }`}
            >
              Signals
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              className={`flex-1 py-2 text-xs font-bold font-mono transition-colors rounded ${
                activeTab === 'logs' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/50 hover:text-emerald-400'
              }`}
            >
              Scan logs ({filteredLogs.length})
            </button>
          </div>

          {/* Filter bar + action buttons */}
          <div className="flex flex-col flex-wrap items-start justify-between gap-2 border-b border-emerald-500/20 bg-zinc-900 p-2.5 sm:flex-row sm:items-center">
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
              {activeTab === 'signals' && (
                <>
                  <span className="text-[10px] font-bold text-emerald-500/70 uppercase">Filter:</span>
                  {/* Status filter */}
                  {(['ALL', 'PENDING', 'EXECUTED', 'CANCELLED'] as const).map(s => (
                    <button key={s}
                      onClick={() => setFilterStatus(s)}
                      className={`text-[9px] px-2 py-0.5 rounded border font-bold transition-colors ${
                        filterStatus === s
                          ? 'bg-emerald-900/60 text-emerald-200 border-emerald-500/60'
                          : 'bg-zinc-950/40 text-emerald-500/50 border-emerald-500/20 hover:border-emerald-500/40'
                      }`}
                    >{s}</button>
                  ))}
                  <span className="text-emerald-500/20">|</span>
                  {/* Grade filter */}
                  {(['ALL', 'A+', 'A', 'B', 'C'] as const).map(g => (
                    <button key={g}
                      onClick={() => setFilterGrade(g)}
                      className={`text-[9px] px-2 py-0.5 rounded border font-bold transition-colors ${
                        filterGrade === g
                          ? 'bg-sky-900/60 text-sky-200 border-sky-500/60'
                          : 'bg-zinc-950/40 text-sky-500/50 border-sky-500/20 hover:border-sky-500/40'
                      }`}
                    >{g === 'ALL' ? 'ALL GRADES' : g}</button>
                  ))}
                </>
              )}
              {activeTab === 'logs' && (
                <span className="break-words text-[10px] font-bold uppercase text-emerald-500/70">Chronological Scan Runs (5m intervals)</span>
              )}
            </div>
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
              {triggerMsg && (
                <span className="max-w-full break-words text-[9px] text-amber-400 animate-pulse sm:max-w-[220px]">{triggerMsg}</span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full gap-1 border-amber-500/30 bg-zinc-950/40 text-[10px] font-bold text-amber-400 transition-premium hover:border-amber-400 hover:bg-amber-950/30 hover:text-amber-300 hover:shadow-[0_0_12px_rgba(245,158,11,0.2)] sm:w-auto"
                onClick={handleTriggerScan}
                disabled={triggerLoading}
              >
                {triggerLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                {triggerLoading ? 'Scanning...' : 'Trigger scan'}
              </Button>
              <details className="smooth-details relative w-full sm:w-auto">
                <summary className="motion-press h-7 w-full list-none cursor-pointer rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1 text-center text-[10px] font-bold text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 sm:w-auto">
                  Dev tools
                </summary>
                <div className="absolute left-0 z-20 mt-2 w-44 max-w-[calc(100vw-2rem)] space-y-2 rounded border border-zinc-700 bg-zinc-950 p-2 shadow-xl sm:left-auto sm:right-0 sm:w-40">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full text-[10px] font-bold border-emerald-500/30 text-emerald-400 hover:text-emerald-300 hover:border-emerald-400 hover:bg-emerald-950/30 gap-1 bg-zinc-950/40"
                    onClick={async () => {
                      if (confirm("Seed sample day-trading signals and scanner logs into this environment? Existing live signals are not removed.")) {
                        try {
                          const res = await api.seedSignals();
                          if (res.success) {
                            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
                            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.scannerLogs });
                          }
                        } catch (err: any) { alert(`Failed to seed data: ${err.message}`); }
                      }
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-emerald-400" /> SEED
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full text-[10px] font-bold border-red-500/30 text-red-400 hover:text-red-300 hover:border-red-400 hover:bg-red-950/30 gap-1 bg-zinc-950/40"
                    onClick={async () => {
                      if (confirm("This permanently deletes all day-trading signals and scanner logs for this environment. Open trades are not closed. Continue?")) {
                        try {
                          const res = await api.clearSignals();
                          if (res.success) {
                            setSelectedSignalId(null);
                            setSelectedLogId(null);
                            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.signals });
                            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.scannerLogs });
                          }
                        } catch (err: any) { alert(`Failed to clear signals: ${err.message}`); }
                      }
                    }}
                  >
                    <XCircle className="h-3.5 w-3.5" /> WIPE
                  </Button>
                </div>
              </details>
            </div>
          </div>

          {activeTab === 'signals' ? (
            <>
            <div className="space-y-2 md:hidden">
              {isLoading && signals.length === 0 ? (
                <div className="rounded border border-emerald-500/10 bg-zinc-950/60 px-3 py-6 text-center text-xs text-emerald-500/70">
                  <RefreshCw className="mx-auto mb-2 h-4 w-4 animate-spin text-emerald-400" />
                  Loading signals...
                </div>
              ) : tableSignals.length === 0 ? (
                <div className="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-6 text-center text-xs text-zinc-400">
                  No signals match the current filters.
                </div>
              ) : tableSignals.map((sig) => {
                const isSelected = sig.id === selectedSignalId;
                const isSignalExecutable = isExecutableSetupGrade(sig);
                const biasColor = sig.signal_type === 'CALL'
                  ? 'text-green-400'
                  : sig.signal_type === 'PUT'
                    ? 'text-red-400'
                    : 'text-zinc-500';

                return (
                  <div
                    key={`mobile-${sig.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedSignalId(sig.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedSignalId(sig.id);
                      }
                    }}
                    className={`w-full rounded border p-3 text-left transition-colors ${
                      isSelected
                        ? 'border-emerald-400/60 bg-emerald-950/30'
                        : 'border-emerald-500/10 bg-zinc-950/60 hover:border-emerald-500/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-emerald-500">#{sig.id}</span>
                          <span className="font-bold text-emerald-100">{sig.symbol}</span>
                          <span className={`font-bold ${biasColor}`}>{sig.signal_type}</span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">{sig.setup_grade || 'B'}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-zinc-400">{sig.trade_bias || 'No bias recorded'}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-sm font-bold text-sky-400">{sig.confidence_score}%</div>
                        <div className="text-[9px] text-zinc-500">confidence</div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-3">
                      <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                        <div className="text-zinc-500">Price</div>
                        <div className="break-words font-mono text-emerald-300">{formatCurrency(sig.current_price)}</div>
                      </div>
                      <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                        <div className="text-zinc-500">SL</div>
                        <div className="break-words font-mono text-red-300">{formatCurrency(sig.stop_loss)}</div>
                      </div>
                      <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                        <div className="text-zinc-500">TP</div>
                        <div className="break-words font-mono text-green-300">{formatCurrency(sig.target_price)}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="flex flex-wrap gap-1">
                        <span className="rounded-full border border-emerald-500/20 px-2 py-0.5 text-[9px] font-bold text-emerald-300">{sig.status}</span>
                        {(sig.execution_status || sig.execution_error) && (
                          <span className={`rounded border px-2 py-0.5 text-[9px] font-bold ${getSignalExecutionTone(sig)}`}>
                            {getSignalExecutionLabel(sig)}
                          </span>
                        )}
                      </div>
                      {sig.status === 'PENDING' && (
                        <div className="flex w-full gap-1 sm:w-auto" onClick={(event) => event.stopPropagation()}>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 flex-1 px-2 text-[10px] sm:flex-none"
                            disabled={isExecutionBlocked || !isSignalExecutable}
                            onClick={() => handleQuickStatus(sig.id, 'EXECUTED')}
                          >
                            Execute
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 flex-1 px-2 text-[10px] text-red-300 sm:flex-none"
                            onClick={() => handleQuickStatus(sig.id, 'CANCELLED')}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-900/80 border-b border-emerald-500/10 text-emerald-500/80 font-bold">
                    <th className="px-2 py-1.5 text-[10px]"></th>
                    <th className="px-2 py-1.5 text-[10px]">#</th>
                    <th className="px-2 py-1.5 text-[10px]">SYM</th>
                    <th className="px-2 py-1.5 text-[10px]">TYPE</th>
                    <th className="hidden sm:table-cell px-2 py-1.5 text-[10px]">BIAS</th>
                    <th className="px-2 py-1.5 text-[10px]">PRICE</th>
                    <th className="hidden md:table-cell px-2 py-1.5 text-[10px]">ENTRY</th>
                    <th className="hidden md:table-cell px-2 py-1.5 text-[10px]">SL</th>
                    <th className="hidden md:table-cell px-2 py-1.5 text-[10px]">TP</th>
                    <th className="px-2 py-1.5 text-[10px]">CONF</th>
                    <th className="hidden sm:table-cell px-2 py-1.5 text-[10px] text-center">GRADE</th>
                    <th className="px-2 py-1.5 text-[10px]">STATUS</th>
                    <th className="px-2 py-1.5 text-[10px] text-right">ACT</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && signals.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-2 py-8 text-center text-emerald-500/60">
                        <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2 text-emerald-400" />
                        Loading signals...
                      </td>
                    </tr>
                  ) : tableSignals.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-2 py-8 text-center text-red-500/80">
                        [NO SIGNALS MATCH CURRENT FILTERS]
                        <div className="text-[10px] text-emerald-600 mt-2">
                          Adjust filters above or click 'SEED' to insert sample data.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    tableSignals.map(sig => {
                      const isSelected = sig.id === selectedSignalId;
                      const isExpanded = sig.id === expandedRowId;
                      const biasColor =
                        sig.signal_type === 'CALL'
                          ? 'text-green-500 font-bold'
                          : sig.signal_type === 'PUT'
                            ? 'text-red-500 font-bold'
                            : 'text-zinc-500';

                      const statusBadgeClass =
                        sig.status === 'PENDING'
                          ? 'bg-yellow-950/80 text-yellow-400 border border-yellow-500/30'
                          : sig.status === 'EXECUTED'
                            ? 'bg-green-950/80 text-green-400 border border-green-500/30 animate-pulse'
                            : 'bg-red-950/80 text-red-400 border border-red-500/30';

                      const hasAi = !!sig.ai_coach_commentary;
                      const aiPending = sig.signal_type !== 'NONE' && !hasAi;
                      const isSignalExecutable = isExecutableSetupGrade(sig);

                      return (
                        <React.Fragment key={sig.id}>
                          <tr
                            onClick={() => { setSelectedSignalId(sig.id); }}
                            className={`motion-row cursor-pointer border-b border-emerald-500/10 hover:bg-emerald-950/10 ${
                              isSelected ? 'bg-emerald-950/30 border-l-2 border-l-emerald-400 shadow-[inset_4px_0_12px_-4px_rgba(16,185,129,0.25)]' : ''
                            }`}
                          >
                            {/* Expand toggle */}
                            <td className="px-1 py-1.5" onClick={e => { e.stopPropagation(); setExpandedRowId(isExpanded ? null : sig.id); }}>
                              <button className="motion-press text-emerald-500/50 hover:text-emerald-300 transition-colors">
                                <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                              </button>
                            </td>
                            <td className="px-2 py-1.5 font-semibold text-emerald-500">#{sig.id}</td>
                            <td className="px-2 py-1.5 font-bold text-emerald-200">{sig.symbol}</td>
                            <td className={`px-2 py-1.5 font-bold ${biasColor}`}>{sig.signal_type}</td>
                            <td className="hidden sm:table-cell px-2 py-1.5 text-[10px] tracking-tighter text-emerald-400/80">{sig.trade_bias}</td>
                            <td className="px-2 py-1.5 text-emerald-300 font-mono">{formatCurrency(sig.current_price)}</td>
                            <td className="hidden md:table-cell px-2 py-1.5 font-mono">{formatCurrency(sig.entry_trigger)}</td>
                            <td className="hidden md:table-cell px-2 py-1.5 font-mono text-red-400/95">{formatCurrency(sig.stop_loss)}</td>
                            <td className="hidden md:table-cell px-2 py-1.5 font-mono text-green-400/95">{formatCurrency(sig.target_price)}</td>
                            <td className="px-2 py-1.5 font-mono font-bold text-sky-400">{sig.confidence_score}%</td>
                            <td className="hidden sm:table-cell px-2 py-1.5 text-center">
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-300 font-semibold">{sig.setup_grade || 'B'}</span>
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex flex-col gap-1">
                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold w-fit ${statusBadgeClass}`}>{sig.status}</span>
                                {(sig.execution_status || sig.execution_error) && (
                                  <span
                                    className={`px-1.5 py-0.5 rounded border text-[8px] font-bold w-fit max-w-[120px] truncate ${getSignalExecutionTone(sig)}`}
                                    title={sig.execution_error || sig.execution_status || ''}
                                  >
                                    {getSignalExecutionLabel(sig)}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 text-right" onClick={e => e.stopPropagation()}>
                              {sig.status === 'PENDING' ? (
                                <div className="flex justify-end gap-1">
                                  <button onClick={() => handleQuickStatus(sig.id, 'EXECUTED')}
                                    disabled={isExecutionBlocked || !isSignalExecutable}
                                    className="motion-press h-5 w-5 flex items-center justify-center rounded bg-emerald-950 hover:bg-emerald-900 border border-emerald-500/30 text-emerald-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title={isSignalExecutable ? 'Execute' : 'Only A/A+ setups can execute'}>
                                    <Play className="h-2.5 w-2.5" />
                                  </button>
                                  <button onClick={() => handleQuickStatus(sig.id, 'CANCELLED')}
                                    className="motion-press h-5 w-5 flex items-center justify-center rounded bg-red-950/80 hover:bg-red-900/80 border border-red-500/30 text-red-400 transition-colors" title="Cancel">
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-[10px] text-emerald-500/40 italic">LOCKED</span>
                              )}
                            </td>
                          </tr>
                          {/* Inline AI Commentary accordion */}
                          {isExpanded && (
                            <tr className="bg-zinc-950/60 border-b border-emerald-500/10">
                              <td colSpan={13} className="px-4 py-3">
                                <div className="mb-2">
                                  {renderGradeDiagnostics(sig)}
                                </div>
                                {aiPending ? (
                                  <div className="flex items-center gap-2 text-[10px] text-amber-400/80 animate-pulse">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    AI coaching is being generated in the background...
                                  </div>
                                ) : hasAi ? (
                                  <div className="space-y-2">
                                    <span className="text-[10px] font-bold text-amber-400 uppercase flex items-center gap-1">
                                      <Zap className="h-3 w-3" /> AI coach
                                    </span>
                                    <div className="text-[10px] text-zinc-300 space-y-0.5 leading-relaxed">
                                      {(sig.ai_coach_commentary || '').split('\n').filter(Boolean).map((line, i) => {
                                        const isPitfall = line.includes('⚠️') || line.toUpperCase().includes('PITFALL');
                                        const isCatalyst = line.includes('✅') || line.toUpperCase().includes('CATALYST');
                                        return <p key={i} className={isPitfall ? 'text-amber-300' : isCatalyst ? 'text-green-300' : 'text-zinc-300'}>{line}</p>;
                                      })}
                                    </div>
                                    {sig.news_context && sig.news_context !== 'No material news in the last 6 hours.' && (
                                      <details className="mt-1">
                                        <summary className="text-[9px] text-zinc-500 cursor-pointer hover:text-zinc-300">📰 News context used →</summary>
                                        <div className="mt-1 text-[9px] text-zinc-600 space-y-0.5">
                                          {sig.news_context.split('\n').map((l, i) => <div key={i}>{l}</div>)}
                                        </div>
                                      </details>
                                    )}
                                    {renderTokenUsageBadge(sig.token_usage)}
                                  </div>
                                ) : (
                                  <span className="text-[10px] text-zinc-600 italic">No AI commentary for this signal (NO_TRADE or AI disabled).</span>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            </>
          ) : (
            <>
            <div className="space-y-2 md:hidden">
              {logsLoading && logs.length === 0 ? (
                <div className="rounded border border-emerald-500/10 bg-zinc-950/60 px-3 py-6 text-center text-xs text-emerald-500/70">
                  <RefreshCw className="mx-auto mb-2 h-4 w-4 animate-spin text-emerald-400" />
                  Loading scanner logs...
                </div>
              ) : filteredLogs.length === 0 ? (
                <div className="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-6 text-center text-xs text-zinc-400">
                  No scanner run logs found. Trigger a scan to run a live evaluation cycle.
                </div>
              ) : (
                filteredLogs.map((log) => {
                  const isSelected = log.id === selectedLogId;
                  const isExpanded = log.id === expandedLogId;
                  const outcomeColor = log.outcome === 'SIGNAL_GENERATED' ? 'text-green-400' : 'text-red-300';

                  return (
                    <div
                      key={`mobile-log-${log.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedLogId(log.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedLogId(log.id);
                        }
                      }}
                      className={`w-full rounded border p-3 text-left transition-colors ${
                        isSelected
                          ? 'border-emerald-400/60 bg-emerald-950/30'
                          : 'border-emerald-500/10 bg-zinc-950/60 hover:border-emerald-500/30'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-emerald-500">#{log.id}</span>
                            <span className="font-bold text-emerald-100">{log.symbol}</span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-300">
                              {log.regime}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-zinc-400">{formatTime(log.created_at)}</div>
                        </div>
                        <button
                          type="button"
                          className="motion-press shrink-0 text-emerald-500/60 hover:text-emerald-300"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedLogId(isExpanded ? null : log.id);
                            setSelectedLogId(log.id);
                          }}
                          aria-label={isExpanded ? 'Hide log details' : 'Show log details'}
                        >
                          <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                        </button>
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-3">
                        <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                          <div className="text-zinc-500">Spot</div>
                          <div className="break-words font-mono text-emerald-300">{formatCurrency(log.spot_price)}</div>
                        </div>
                        <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                          <div className="text-zinc-500">VIX</div>
                          <div className="break-words font-mono text-zinc-300">{formatNumber(log.vix)}</div>
                        </div>
                        <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                          <div className="text-zinc-500">GEX</div>
                          <div className="break-words font-mono text-zinc-300">{log.gex_available ? 'YES' : 'NO'}</div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className={`break-words text-[10px] font-bold ${outcomeColor}`}>{log.outcome}</span>
                        <span className="text-[10px] text-zinc-500">
                          {log.no_trade_reasons && log.no_trade_reasons.length > 0 ? `${log.no_trade_reasons.length} blockers` : 'No blockers'}
                        </span>
                      </div>

                      {isExpanded && (
                        <div className="mt-3 space-y-2.5 border-t border-emerald-500/10 pt-3">
                          <div className="text-[10px] font-bold uppercase text-emerald-400">Indicators at run</div>
                          {log.indicators ? (
                            <div className="grid grid-cols-1 gap-2 rounded border border-emerald-500/10 bg-zinc-950/80 p-2 text-[10px] sm:grid-cols-2">
                              <div className="break-words"><span className="text-zinc-500">VWAP:</span> {formatCurrency(log.indicators.vwap)}</div>
                              <div className="break-words"><span className="text-zinc-500">ATR14:</span> {formatCurrency(log.indicators.atr14)}</div>
                              <div className="break-words"><span className="text-zinc-500">EMA9:</span> {formatCurrency(log.indicators.ema9)}</div>
                              <div className="break-words"><span className="text-zinc-500">EMA21:</span> {formatCurrency(log.indicators.ema21)}</div>
                            </div>
                          ) : (
                            <div className="text-[10px] italic text-zinc-600">No indicators saved for this log.</div>
                          )}
                          {log.no_trade_reasons && log.no_trade_reasons.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[10px] font-bold uppercase text-red-400">Blockers</div>
                              <ul className="list-disc space-y-1 pl-4 text-[10px] text-red-300/95">
                                {log.no_trade_reasons.map((reason, idx) => (
                                  <li key={idx} className="break-words">{reason}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-900/80 border-b border-emerald-500/10 text-emerald-500/80 font-bold font-mono">
                    <th className="px-2 py-1.5 text-[10px]"></th>
                    <th className="px-2 py-1.5 text-[10px]">#</th>
                    <th className="px-2 py-1.5 text-[10px]">TIME</th>
                    <th className="px-2 py-1.5 text-[10px]">SYM</th>
                    <th className="px-2 py-1.5 text-[10px]">SPOT</th>
                    <th className="px-2 py-1.5 text-[10px]">REGIME</th>
                    <th className="px-2 py-1.5 text-[10px]">VIX</th>
                    <th className="px-2 py-1.5 text-[10px]">GEX</th>
                    <th className="px-2 py-1.5 text-[10px]">OUTCOME</th>
                    <th className="px-2 py-1.5 text-[10px] text-right">DETAILS</th>
                  </tr>
                </thead>
                <tbody>
                  {logsLoading && logs.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-2 py-8 text-center text-emerald-500/60">
                        <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2 text-emerald-400" />
                        Loading scanner logs...
                      </td>
                    </tr>
                  ) : filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-2 py-8 text-center text-red-500/80 font-bold">
                        [NO SCANNER RUN LOGS FOUND]
                        <div className="text-[10px] text-emerald-600 mt-2 font-normal">
                          Click Trigger scan above to run a live scanner evaluation cycle.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map(log => {
                      const isSelected = log.id === selectedLogId;
                      const isExpanded = log.id === expandedLogId;
                      const outcomeColor = log.outcome === 'SIGNAL_GENERATED' ? 'text-green-400 font-bold animate-pulse' : 'text-red-400/80';
                      
                      return (
                        <React.Fragment key={log.id}>
                          <tr
                            onClick={() => { setSelectedLogId(log.id); }}
                            className={`motion-row cursor-pointer border-b border-emerald-500/10 hover:bg-emerald-950/10 ${
                              isSelected ? 'bg-emerald-950/30 border-l-2 border-l-emerald-400 shadow-[inset_4px_0_12px_-4px_rgba(16,185,129,0.25)]' : ''
                            }`}
                          >
                            <td className="px-1 py-1.5" onClick={e => { e.stopPropagation(); setExpandedLogId(isExpanded ? null : log.id); }}>
                              <button className="motion-press text-emerald-500/50 hover:text-emerald-300 transition-colors">
                                <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                              </button>
                            </td>
                            <td className="px-2 py-1.5 font-semibold text-emerald-500">#{log.id}</td>
                            <td className="px-2 py-1.5 text-zinc-400 font-mono">{formatTime(log.created_at)}</td>
                            <td className="px-2 py-1.5 font-bold text-emerald-200">{log.symbol}</td>
                            <td className="px-2 py-1.5 font-mono text-emerald-300">{formatCurrency(log.spot_price)}</td>
                            <td className="px-2 py-1.5 text-zinc-400 uppercase">{log.regime}</td>
                            <td className="px-2 py-1.5 text-zinc-400 font-mono">{formatNumber(log.vix)}</td>
                            <td className="px-2 py-1.5 text-zinc-400">{log.gex_available ? 'YES' : 'NO'}</td>
                            <td className={`px-2 py-1.5 ${outcomeColor}`}>{log.outcome}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-[9px] text-zinc-500">
                              {log.no_trade_reasons && log.no_trade_reasons.length > 0 ? `${log.no_trade_reasons.length} blockers` : 'None'}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-zinc-950/60 border-b border-emerald-500/10">
                              <td colSpan={10} className="px-4 py-3">
                                <div className="space-y-2.5">
                                  <div className="text-[10px] font-bold text-emerald-400 uppercase">INDICATORS AT RUN:</div>
                                  {log.indicators ? (
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] bg-zinc-950/80 p-2 rounded border border-emerald-500/10">
                                      <div><span className="text-zinc-500">VWAP:</span> {formatCurrency(log.indicators.vwap)}</div>
                                      <div><span className="text-zinc-500">ATR14:</span> {formatCurrency(log.indicators.atr14)}</div>
                                      <div><span className="text-zinc-500">EMA9:</span> {formatCurrency(log.indicators.ema9)}</div>
                                      <div><span className="text-zinc-500">EMA21:</span> {formatCurrency(log.indicators.ema21)}</div>
                                    </div>
                                  ) : (
                                    <div className="text-[10px] text-zinc-600 italic">No indicators saved for this log.</div>
                                  )}
                                  
                                  {log.no_trade_reasons && log.no_trade_reasons.length > 0 && (
                                    <div className="space-y-1">
                                      <div className="text-[10px] font-bold text-red-400 uppercase">BLOCKERS:</div>
                                      <ul className="text-[10px] text-red-300/95 list-disc pl-4 space-y-1">
                                        {log.no_trade_reasons.map((r, idx) => (
                                          <li key={idx}>{r}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
 
         {/* Detailed Inspector Panel */}
         <div className="motion-panel flex min-w-0 flex-col overflow-hidden rounded border border-emerald-500/20 bg-zinc-900/20 max-h-[70vh] 2xl:max-h-none">
           <div className="flex flex-col items-start justify-between gap-2 border-b border-emerald-500/20 bg-zinc-900 p-3 sm:flex-row sm:items-center">
             <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
               <Info className="h-3.5 w-3.5 text-emerald-400" />
               OPTION DETAILS
             </span>
             {selectedSignal && (
               <Badge variant="outline" className="max-w-full whitespace-normal break-words text-[10px] border-emerald-500/30 text-emerald-400">
                 {selectedSignal.symbol} #{selectedSignal.id}
               </Badge>
             )}
           </div>
 
           <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs sm:p-4">
             {!selectedSignal ? (
               <div className="h-full flex flex-col items-center justify-center text-center text-emerald-500/40">
                 <HelpCircle className="h-10 w-10 opacity-30 mb-2" />
                 Select an alert from the left log table to inspect its technical details.
               </div>
             ) : (
               <div className="space-y-4 motion-enter">
                 {/* Meta details */}
                 <div className="grid grid-cols-1 gap-2 border-b border-emerald-500/10 pb-3 sm:grid-cols-3">
                   <div className="min-w-0">
                     <span className="text-[10px] text-emerald-500/60 block">MARKET DATE</span>
                     <span className="break-words font-semibold text-emerald-300">{selectedSignal.market_date || '-'}</span>
                   </div>
                   <div className="min-w-0">
                     <span className="text-[10px] text-emerald-500/60 block">TIME STAMP</span>
                     <span className="break-words font-semibold text-emerald-300">
                       {formatTime(selectedSignal.created_at)}
                     </span>
                   </div>
                   <div className="min-w-0">
                      <span className="text-[10px] text-emerald-500/60 block">ML CONFIDENCE</span>
                      {selectedSignal.ml_probability !== undefined && selectedSignal.ml_probability !== null ? (() => {
                        const mlPct = Math.round(Number(selectedSignal.ml_probability) * 100);
                        let colorClass = 'text-emerald-400';
                        if (mlPct < 50) {
                          colorClass = 'text-amber-400';
                        } else if (mlPct < 75) {
                          colorClass = 'text-sky-400';
                        }
                        return <span className={`font-bold ${colorClass}`}>{mlPct}%</span>;
                      })() : (
                        <span className="font-bold text-zinc-500">N/A</span>
                      )}
                    </div>
                 </div>

                 {renderGradeDiagnostics(selectedSignal)}

                 <div className={`rounded border p-2.5 text-[10px] ${getSignalExecutionTone(selectedSignal)}`}>
                   <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                     <span className="font-bold uppercase">EXECUTION_STATUS</span>
                     <span className="break-words font-bold">{getSignalExecutionDisplayStatus(selectedSignal)}</span>
                   </div>
                   <div className="grid grid-cols-1 gap-x-4 gap-y-1 font-mono sm:grid-cols-2">
                     <div className="flex min-w-0 justify-between gap-2">
                       <span className="opacity-70">Broker</span>
                       <span className="break-words text-right font-semibold">{getExecutionBrokerLabel(selectedSignal.execution_broker)}</span>
                     </div>
                     <div className="flex min-w-0 justify-between gap-2">
                       <span className="opacity-70">Contracts</span>
                       <span className="font-semibold">{selectedSignal.contracts_requested ?? '-'}</span>
                     </div>
                     <div className="flex min-w-0 justify-between gap-2 sm:col-span-2">
                       <span className="opacity-70">Order ID</span>
                       <span className="break-all text-right font-semibold">{selectedSignal.broker_order_id || '-'}</span>
                     </div>
                     <div className="flex min-w-0 justify-between gap-2 sm:col-span-2">
                       <span className="opacity-70">Trade ID</span>
                       <span className="break-all text-right font-semibold">{selectedSignal.broker_trade_id || '-'}</span>
                     </div>
                   </div>
                   {selectedSignal.execution_error && (
                     <div className={`mt-2 break-words rounded-md border px-2 py-2 leading-relaxed ${getSignalExecutionDetailTone(selectedSignal)}`}>
                       {selectedSignal.execution_error}
                     </div>
                   )}
                 </div>
 
                 {/* Option Contract Details Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-sky-400 uppercase flex items-center gap-1">
                     <TrendingUp className="h-3 w-3 text-sky-400" /> Option contract
                   </span>
                   {selectedSignal.option_details ? (
                     <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded border border-sky-500/30 bg-zinc-950/60 p-2.5 font-mono text-[11px] text-zinc-300 sm:grid-cols-2">
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5 sm:col-span-2">
                         <span className="text-emerald-500/70">TICKER</span>
                         <span className="break-all text-right font-bold text-sky-300">{selectedSignal.option_details.ticker || 'N/A'}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">OPTION TYPE</span>
                         <span className={`font-bold ${selectedSignal.option_details.side === 'CALL' ? 'text-green-400 animate-pulse' : 'text-red-400 animate-pulse'}`}>
                           {selectedSignal.option_details.side || 'N/A'}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">STRIKE</span>
                         <span className="font-semibold text-emerald-300">
                           {formatCurrency(selectedSignal.option_details.strike)}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">PREMIUM (MARK)</span>
                         <span className="font-bold text-emerald-300">
                           {formatCurrency(selectedSignal.option_details.mark)}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EXPIRATION</span>
                         <span className="break-words text-right">{selectedSignal.option_details.expiry || 'N/A'}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">BID / ASK</span>
                         <span className="break-words text-right">
                           {selectedSignal.option_details.bid !== undefined && selectedSignal.option_details.ask !== undefined
                             ? `${formatCurrency(selectedSignal.option_details.bid)} / ${formatCurrency(selectedSignal.option_details.ask)}`
                             : 'N/A'}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">SPREAD</span>
                         <span className="break-words text-right">
                           {selectedSignal.option_details.spread !== undefined && selectedSignal.option_details.spreadPct !== undefined
                             ? `${formatCurrency(selectedSignal.option_details.spread)} (${formatPercent(selectedSignal.option_details.spreadPct)})`
                             : 'N/A'}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">VOLUME</span>
                         <span className="break-words text-right">{Number.isFinite(Number(selectedSignal.option_details.volume)) ? Number(selectedSignal.option_details.volume).toLocaleString() : 'N/A'}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">OPEN INTEREST</span>
                         <span className="break-words text-right">{Number.isFinite(Number(selectedSignal.option_details.openInterest)) ? Number(selectedSignal.option_details.openInterest).toLocaleString() : 'N/A'}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">SUGGESTED SL</span>
                         <span className="text-red-400 font-semibold">
                           {formatCurrency(selectedSignal.option_details.suggestedStopLoss)}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">SUGGESTED TP</span>
                         <span className="text-green-400 font-semibold">
                           {formatCurrency(selectedSignal.option_details.suggestedTakeProfit)}
                         </span>
                       </div>
                     </div>
                    ) : (
                      <div className="text-zinc-500 italic p-3 bg-zinc-950/40 rounded border border-zinc-800/50 font-mono text-[10px] leading-relaxed">
                        {activeTab === 'logs' 
                          ? 'Selected record is a background scanner execution log. Option contract specs are only saved for active trade signals.'
                          : 'No option contract specs exist for this historical record.'}
                      </div>
                    )}
                 </div>

                 {/* Indicators Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <Activity className="h-3 w-3" /> Technical indicators
                   </span>
                   {selectedSignal.indicators ? (
                     <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded border border-emerald-500/10 bg-zinc-950/60 p-2.5 font-mono text-[11px] sm:grid-cols-2">
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">VWAP</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.indicators.vwap)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ATR14</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.indicators.atr14)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EMA 9</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.indicators.ema9)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EMA 21</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.indicators.ema21)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ORH (15m)</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.indicators.openingRangeHigh)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ORL (15m)</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.indicators.openingRangeLow)}</span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No technical data available.</div>
                   )}
                 </div>
 
                 {/* GEX Blocks */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <TrendingUp className="h-3 w-3" /> Gamma exposure
                   </span>
                   {selectedSignal.gex ? (
                     <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded border border-emerald-500/10 bg-zinc-950/60 p-2.5 font-mono text-[11px] sm:grid-cols-2">
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Net GEX</span>
                         <span className={`break-words text-right ${Number(selectedSignal.gex.netGex) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                           {Number.isFinite(Number(selectedSignal.gex.netGex)) ? Number(selectedSignal.gex.netGex).toLocaleString() : 'N/A'}
                         </span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">GEX Regime</span>
                         <span className="break-words text-right font-semibold text-emerald-300">{selectedSignal.gex.regime || 'N/A'}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Flip Strike</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.gex.flipStrike)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Call Wall</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.gex.callWall)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Put Wall</span>
                         <span className="break-words text-right">{formatCurrency(selectedSignal.gex.putWall)}</span>
                       </div>
                       <div className="flex min-w-0 justify-between gap-2 border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Flow Dir.</span>
                         <span className="break-words text-right text-[10px] font-semibold text-sky-400">{selectedSignal.gex.flowDirection || 'N/A'}</span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No GEX data available.</div>
                   )}
                 </div>
 
                 {/* Volatility Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <Activity className="h-3 w-3" /> VOLATILITY
                   </span>
                   {selectedSignal.volatility ? (
                     <div className="flex flex-col gap-2 rounded border border-emerald-500/10 bg-zinc-950/60 p-2.5 font-mono text-[11px] sm:flex-row sm:justify-between sm:gap-4">
                       <div className="flex min-w-0 items-center justify-between gap-2">
                         <span className="text-emerald-500/70">VIX:</span>
                         <span className="break-words text-right font-semibold text-emerald-200">
                           {formatNumber(selectedSignal.volatility.vixQuote)}
                         </span>
                       </div>
                       <div className="flex min-w-0 items-center justify-between gap-2">
                         <span className="text-emerald-500/70">VIX Daily Chg:</span>
                         <span className={`break-words text-right font-semibold ${Number(selectedSignal.volatility.vixChangePercent) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                           {formatPercent(selectedSignal.volatility.vixChangePercent, 2)}
                         </span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No VIX data available.</div>
                   )}
                 </div>
 
                 {/* Block Reasons / No Trade reasons */}
                 {selectedSignal.no_trade_reasons && selectedSignal.no_trade_reasons.length > 0 && (
                   <div className="space-y-1">
                     <span className="text-[10px] font-bold text-red-400 uppercase flex items-center gap-1">
                       <ShieldAlert className="h-3.5 w-3.5 text-red-500 animate-pulse" /> No-trade blockers
                     </span>
                     <ul className="bg-red-950/15 border border-red-500/20 p-3 rounded text-[11px] space-y-1.5">
                       {selectedSignal.no_trade_reasons.map((reason, idx) => (
                         <li key={idx} className="flex gap-2 text-red-300">
                           <span className="text-red-500 font-bold select-none">[!]</span>
                           <span className="min-w-0 break-words">{reason}</span>
                         </li>
                       ))}
                     </ul>
                   </div>
                 )}

                 {/* AI Coach Commentary */}
                 {selectedSignal.ai_coach_commentary && (
                   <div className="space-y-1">
                     <span className="text-[10px] font-bold text-amber-400 uppercase flex items-center gap-1">
                       <Zap className="h-3 w-3 text-amber-400 animate-pulse" /> AI coach
                     </span>
                     <div className="bg-zinc-950/60 border border-amber-500/15 p-2.5 rounded text-[10px] space-y-1">
                       {selectedSignal.ai_coach_commentary.split('\n').filter(Boolean).map((line, i) => {
                         const isPitfall = line.includes('⚠️') || line.toUpperCase().includes('PITFALL');
                         const isCatalyst = line.includes('✅') || line.toUpperCase().includes('CATALYST');
                         return (
                           <p key={i} className={`break-words ${isPitfall ? 'text-amber-300' : isCatalyst ? 'text-green-300' : 'text-zinc-300 italic'}`}>
                             {line}
                           </p>
                         );
                       })}
                     </div>
                   </div>
                 )}

                 {/* News Context */}
                 {selectedSignal.news_context && selectedSignal.news_context !== 'No material news in the last 6 hours.' && (
                   <div className="space-y-1">
                     <span className="text-[10px] font-bold text-zinc-400 uppercase flex items-center gap-1">
                       News context at scan
                     </span>
                     <div className="space-y-0.5 rounded border border-zinc-700/30 bg-zinc-950/40 p-2 text-[9px] leading-relaxed text-zinc-500">
                       {selectedSignal.news_context.split('\n').map((line, i) => <div key={i} className="break-words">{line}</div>)}
                     </div>
                   </div>
                 )}

                 {renderTokenUsageBadge(selectedSignal.token_usage)}
               </div>
             )}
           </div>
         </div>
       </div>

      <Dialog open={!!executeDialogSignal} onOpenChange={(isOpen) => !isOpen && setExecuteDialogSignal(null)}>
        <DialogContent className="max-w-md border-emerald-500/20 bg-zinc-950 text-zinc-100 data-[state=open]:duration-200 data-[state=closed]:duration-150">
          <DialogHeader>
            <DialogTitle className="text-emerald-300">Confirm Trade Execution</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Review the exact order path before sending this signal to the configured execution broker.
            </DialogDescription>
          </DialogHeader>

          {executeDialogSignal && (
            <div className="space-y-3 text-xs font-mono">
              {isLiveBroker && (
                <div className="rounded border border-amber-500/30 bg-amber-950/20 p-3 text-amber-200">
                  Wealthsimple/SnapTrade is live trading. This can place a real order in the selected account.
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Broker</span>
                  <span className={isLiveBroker ? 'text-amber-300 font-bold' : 'text-sky-300 font-bold'}>{brokerLabel}</span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Quantity</span>
                  <span className="text-emerald-300 font-bold">{contractsPerTrade} contract{contractsPerTrade === 1 ? '' : 's'}</span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2 col-span-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Contract</span>
                  <span className="text-zinc-100 font-bold break-all">
                    {executeDialogSignal.option_details?.ticker || `${executeDialogSignal.symbol} ${executeDialogSignal.signal_type}`}
                  </span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Premium</span>
                  <span className="text-zinc-100 font-bold">
                    {formatCurrency(executeDialogSignal.option_details?.mark)}
                  </span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Est. Debit</span>
                  <span className="text-zinc-100 font-bold">
                    {executeDialogSignal.option_details?.mark !== undefined
                      ? formatCurrency(Number(executeDialogSignal.option_details.mark) * contractsPerTrade * 100)
                      : 'N/A'}
                  </span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Stop / Target</span>
                  <span className="text-zinc-100 font-bold">
                    {formatCurrency(executeDialogSignal.stop_loss)} / {formatCurrency(executeDialogSignal.target_price)}
                  </span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Order</span>
                  <span className="text-zinc-100 font-bold">{settings.order_type || 'LIMIT'} {settings.entry_slippage_pct || 3}%</span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              className="text-zinc-300 hover:bg-zinc-900"
              onClick={() => setExecuteDialogSignal(null)}
              disabled={executingSignalId !== null}
            >
              Cancel
            </Button>
            <Button
              className={isLiveBroker ? 'bg-amber-600 hover:bg-amber-500 text-black font-bold' : 'bg-emerald-700 hover:bg-emerald-600 text-white font-bold'}
              onClick={confirmExecuteSignal}
              disabled={executingSignalId !== null}
            >
              {executingSignalId !== null ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {isLiveBroker ? 'Send Live Order' : 'Execute'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
     </div>
   );
 }
