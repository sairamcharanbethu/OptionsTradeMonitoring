import React, { useState, useEffect, useRef } from 'react';
import { useSignals, useSettings, useScannerLogs, useSnaptradePortfolio, useTradeUsage, QUERY_KEYS } from '@/hooks/useDashboardData';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, Signal, ScannerLog } from '@/lib/api';
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
  Heart,
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
  yahooFinance: { status: string; latencyMs: number };
  sscgexPortal: { status: string; latencyMs: number };
  polygon: { status: string; latencyMs: number };
  openRouter: { status: string; latencyMs: number };
  discord: { status: string; latencyMs: number };
  alpaca?: { status: string; latencyMs: number };
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
    questrade: {
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
    questrade: {
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
  const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  return `${Math.round(diffSeconds / 60)}m ago`;
};

const renderTokenUsageBadge = (usage: any) => {
  if (!usage || (!usage.classifier && !usage.coach)) return null;
  const totalTokens = (usage.classifier?.total_tokens || 0) + (usage.coach?.total_tokens || 0);
  
  return (
    <div className="flex flex-wrap gap-2.5 mt-2 items-center text-[9px] text-zinc-400 font-mono bg-zinc-950/60 p-2 px-2.5 rounded border border-emerald-500/10 w-full animate-in fade-in duration-300">
      <div className="flex items-center gap-1">
        <Database className="h-3 w-3 text-emerald-400" />
        <span>TOTAL TOKENS: <strong className="text-zinc-200 font-bold">{totalTokens.toLocaleString()}</strong></span>
      </div>
      {usage.classifier && (
        <>
          <span className="text-zinc-700">|</span>
          <span>CLASSIFIER: <strong className="text-purple-400 font-bold">{usage.classifier.total_tokens}</strong> ({usage.classifier.prompt_tokens} in/{usage.classifier.completion_tokens} out)</span>
        </>
      )}
      {usage.coach && (
        <>
          <span className="text-zinc-700">|</span>
          <span>COACH: <strong className="text-amber-400 font-bold">{usage.coach.total_tokens}</strong> ({usage.coach.prompt_tokens} in/{usage.coach.completion_tokens} out)</span>
        </>
      )}
    </div>
  );
};

const getExecutionBrokerLabel = (broker?: string | null) => {
  switch (broker) {
    case 'alpaca_paper':
      return 'Alpaca Paper';
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
  if (signal.execution_status === 'FAILED' || signal.execution_error) return 'border-red-500/40 text-red-300 bg-red-950/20';
  if (signal.execution_status === 'SKIPPED') return 'border-amber-500/40 text-amber-300 bg-amber-950/20';
  if (signal.execution_status === 'PENDING') return 'border-amber-500/40 text-amber-300 bg-amber-950/20';
  if (signal.status === 'EXECUTED') return 'border-emerald-500/40 text-emerald-300 bg-emerald-950/20';
  return 'border-zinc-700 text-zinc-400 bg-zinc-950/40';
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

export default function DayTradingTerminal() {
  const queryClient = useQueryClient();
  // Smart poll: 3s for 3 mins after a signal with no AI commentary; otherwise 10s
  const [fastPollUntil, setFastPollUntil] = useState<number>(0);
  const pollInterval = Date.now() < fastPollUntil ? 3000 : 10000;
  const { data: signals = [], isLoading, isFetching, refetch } = useSignals(pollInterval);
  const { data: logs = [], isLoading: logsLoading, isFetching: logsFetching, refetch: refetchLogs } = useScannerLogs(pollInterval);
  const { data: settings = {} } = useSettings();
  const { data: snaptradePortfolio } = useSnaptradePortfolio();
  const { data: tradeUsage, refetch: refetchTradeUsage } = useTradeUsage();
  const isDayTradingEnabled = settings.day_trading_enabled !== 'false';

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
  const [selectedSymbol, setSelectedSymbol] = useState<'QQQ' | 'SPY' | 'BOTH'>('QQQ');
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterGrade, setFilterGrade] = useState<string>('ALL');
  const [countdown, setCountdown] = useState(300);
  const [showChart, setShowChart] = useState(true);
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  const [healthData, setHealthData] = useState<ApiHealthState>({
    yahooFinance: { status: 'UP', latencyMs: 95 },
    sscgexPortal: { status: 'UP', latencyMs: 140 },
    polygon: { status: 'UP', latencyMs: 110 },
    openRouter: { status: 'UP', latencyMs: 310 },
    discord: { status: 'UP', latencyMs: 120 },
    alpaca: { status: 'N/A', latencyMs: 0 }
  });
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthState>(defaultServiceHealth);
  const [healthLoading, setHealthLoading] = useState(false);
  const [executeDialogSignal, setExecuteDialogSignal] = useState<Signal | null>(null);
  const [executingSignalId, setExecutingSignalId] = useState<number | null>(null);
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
          fetchHealth();
          return 300;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refetch, refetchLogs, isDayTradingEnabled, isScannerMarketClosed]);

  // Sync manually
  const handleManualSync = () => {
    refetch();
    refetchLogs();
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

  // Filter signals: by symbol tab, then status and grade filters
  const filteredSignals = signals
    .filter(s => selectedSymbol === 'BOTH' || s.symbol === selectedSymbol)
    .filter(s => filterStatus === 'ALL' || s.status === filterStatus)
    .filter(s => {
      if (filterGrade === 'ALL') return true;
      return getSetupGradeKey(s.setup_grade) === filterGrade;
    });

  const filteredLogs = logs
    .filter(l => selectedSymbol === 'BOTH' || l.symbol === selectedSymbol);

  // Get currently selected signal object
  const realSelectedSignal = filteredSignals.find(s => s.id === selectedSignalId) || null;
  const selectedLog = filteredLogs.find(l => l.id === selectedLogId) || null;

  const selectedSignal = activeTab === 'signals'
    ? realSelectedSignal
    : (selectedLog ? {
        id: selectedLog.id,
        symbol: selectedLog.symbol,
        market_date: new Date(selectedLog.created_at).toLocaleDateString('en-US'),
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

  // Find the single LATEST actionable signal for QQQ or SPY (within the last 24h)
  const latestActionableSignal = filteredSignals.find(s => s.signal_type !== 'NONE' && s.status === 'PENDING') || null;

  // Active signals table should exclude the latest actionable setup alert
  const tableSignals = latestActionableSignal
    ? filteredSignals.filter(s => s.id !== latestActionableSignal.id)
    : filteredSignals;

  // Set default selected signal when signals load or tab changes
  useEffect(() => {
    if (tableSignals.length > 0) {
      setSelectedSignalId(tableSignals[0].id);
    } else {
      setSelectedSignalId(null);
    }
  }, [selectedSymbol, signals]);

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

  const latestQQQSignal = signals.find(s => s.symbol === 'QQQ') || null;
  const latestSPYSignal = signals.find(s => s.symbol === 'SPY') || null;
  const latestQQQLog = logs.find(l => l.symbol === 'QQQ') || null;
  const latestSPYLog = logs.find(l => l.symbol === 'SPY') || null;

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
    || (settings.alpaca_auto_trade === 'true' ? 'alpaca_paper' : settings.snaptrade_auto_trade === 'true' ? 'wealthsimple_snaptrade' : 'none');
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
  const isExecutionBlocked = remainingTrades <= 0 || missingLiveExecutionItems.length > 0;
  const readinessItems = [
    { label: 'Broker', value: brokerLabel, tone: isLiveBroker ? 'text-amber-300' : configuredBroker === 'alpaca_paper' ? 'text-sky-300' : 'text-zinc-400' },
    { label: 'Size', value: `${contractsPerTrade} contract${contractsPerTrade === 1 ? '' : 's'}`, tone: 'text-emerald-300' },
    { label: 'Daily', value: `${tradesToday}/${dailyLimit} used`, tone: remainingTrades > 0 ? 'text-emerald-300' : 'text-red-300' },
    { label: 'Order', value: `${settings.order_type || 'LIMIT'} ${settings.entry_slippage_pct || 3}%`, tone: 'text-zinc-300' },
    { label: 'Account', value: isLiveBroker ? selectedAccountLabel : 'Paper/sim', tone: isLiveBroker && !settings.snaptrade_trading_account_id ? 'text-red-300' : 'text-zinc-300' },
    ...(isLiveBroker ? [{ label: 'Balance', value: selectedAccountBalance, tone: selectedSnaptradeAccount ? 'text-emerald-300' : 'text-amber-300' }] : [])
  ];

  return (
    <div className="terminal-scanline motion-enter flex flex-col gap-4 lg:gap-5 font-mono bg-zinc-950 text-emerald-400 p-3 sm:p-4 rounded-lg border border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.05)] max-w-full overflow-hidden">
      
      {/* Top Banner & Timer Bar */}
      <div className="flex flex-col xl:flex-row justify-between items-stretch xl:items-center border-b border-emerald-500/20 pb-4 gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-9 w-9 rounded border border-emerald-500/25 bg-emerald-950/35 flex items-center justify-center shrink-0 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
            <TerminalIcon className="h-[18px] w-[18px] text-emerald-300" />
          </div>
          <div className="flex flex-col min-w-0 gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg sm:text-2xl font-extrabold text-emerald-100 leading-none break-words">0DTE command center</h2>
              <Badge variant="outline" className="text-[9px] bg-zinc-950/70 border-emerald-500/25 text-emerald-300 font-mono">
                {selectedSymbol === 'BOTH' ? 'QQQ + SPY' : selectedSymbol}
              </Badge>
              <span className="text-[9px] text-zinc-600 font-mono">
                v{import.meta.env.VITE_APP_VERSION || '1.4.1'}
              </span>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className={`px-2 py-1 rounded border font-bold ${scannerStatusTone}`}>
                {scannerStatusLabel}
              </span>
              <span className="px-2 py-1 rounded border border-zinc-800 bg-zinc-950/55 text-zinc-300">
                Next scan {isDayTradingEnabled && !isScannerMarketClosed ? formatMinSec(countdown) : scannerWindowLabel}
              </span>
              <span className="px-2 py-1 rounded border border-zinc-800 bg-zinc-950/55 text-zinc-300">
                Broker {brokerLabel}
              </span>
              <span className="px-2 py-1 rounded border border-zinc-800 bg-zinc-950/55 text-zinc-400">
                Max {maxTradesPerDay}/day
              </span>
            </div>
          </div>
        </div>

        {/* Ticker switcher Tabs & Sync Timer */}
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3 w-full xl:w-auto justify-between xl:justify-end">
          <div className="motion-panel grid grid-cols-3 bg-zinc-900 p-1 rounded border border-emerald-500/20 animate-in fade-in duration-200 min-w-[230px]">
            <button
              onClick={() => setSelectedSymbol('QQQ')}
              className={`px-4 py-2 text-xs font-bold rounded transition-all ${
                selectedSymbol === 'QQQ' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              QQQ
            </button>
            <button
              onClick={() => setSelectedSymbol('SPY')}
              className={`px-4 py-2 text-xs font-bold rounded transition-all ${
                selectedSymbol === 'SPY' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              SPY
            </button>
            <button
              onClick={() => setSelectedSymbol('BOTH')}
              className={`px-4 py-2 text-xs font-bold rounded transition-all ${
                selectedSymbol === 'BOTH' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              BOTH
            </button>
          </div>

          {isDayTradingEnabled && !isScannerMarketClosed ? (
            <div className="flex items-center justify-between sm:justify-start gap-2 text-xs bg-emerald-950/40 border border-emerald-500/30 px-3 py-2 rounded min-w-[178px]">
              <Clock className="h-4 w-4 text-emerald-400" />
              <span className="font-bold">Rescan in {formatMinSec(countdown)}</span>
              <button
                onClick={handleManualSync}
                className="motion-press ml-1 text-emerald-500 hover:text-emerald-300"
                title="Force Sync Now"
              >
                <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs bg-zinc-900/60 border border-zinc-700 px-3 py-2 rounded text-zinc-500 min-w-[178px]">
              <ShieldAlert className={`h-4 w-4 ${isScannerMarketClosed ? 'text-sky-400/80' : 'text-amber-500/70 animate-pulse'}`} />
              <span className="font-bold tracking-wider">{isScannerMarketClosed ? 'Auto resumes at open' : 'Scanner paused'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Row 1: Dashboard Gauges / Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        
        {/* Widget 1: Glowing Market Regime Gauge */}
        {selectedSymbol === 'BOTH' ? (
          <div className="motion-panel flex flex-row items-center justify-between p-3 border rounded bg-zinc-900/40 shadow-inner transition-all duration-300 min-h-[76px] border-zinc-800 shadow-[0_0_20px_rgba(16,185,129,0.02)]">
            <div className="grid grid-cols-2 gap-3 w-full font-mono">
              {/* QQQ Side */}
              <div className="flex flex-col border-r border-zinc-800/80 pr-2">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[9px] text-emerald-500/70 uppercase font-semibold">QQQ REGIME</span>
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${qqqDetails.badgeBg}`}>
                    {qqqDetails.marketRegime === 'EUPHORIA' ? '🔥 RISK-ON' : qqqDetails.marketRegime === 'BULLISH' ? '🟢 BUY' : qqqDetails.marketRegime === 'BEARISH' ? '🔴 FADE' : '🟡 RANGE'}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-300 block mt-1 font-bold tracking-wider">
                  {qqqDetails.marketRegime}
                </span>
                <span className="text-[9px] text-zinc-400 block mt-0.5">
                  GEX: {qqqDetails.currentGexRegime} · VIX: {qqqDetails.vixValue.toFixed(1)}
                </span>
              </div>
              
              {/* SPY Side */}
              <div className="flex flex-col pl-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[9px] text-emerald-500/70 uppercase font-semibold">SPY REGIME</span>
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${spyDetails.badgeBg}`}>
                    {spyDetails.marketRegime === 'EUPHORIA' ? '🔥 RISK-ON' : spyDetails.marketRegime === 'BULLISH' ? '🟢 BUY' : spyDetails.marketRegime === 'BEARISH' ? '🔴 FADE' : '🟡 RANGE'}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-300 block mt-1 font-bold tracking-wider">
                  {spyDetails.marketRegime}
                </span>
                <span className="text-[9px] text-zinc-400 block mt-0.5">
                  GEX: {spyDetails.currentGexRegime} · VIX: {spyDetails.vixValue.toFixed(1)}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className={`motion-panel flex flex-row items-center justify-between p-3 border rounded bg-zinc-900/40 shadow-inner transition-all duration-300 min-h-[76px] ${regimeGlowColor}`}>
            <div className="flex flex-col justify-center">
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-emerald-500/70 uppercase tracking-wider font-semibold">REGIME</span>
                <Badge variant="outline" className="text-[8px] px-1 py-0.5 border-emerald-500/20 text-emerald-400 font-bold uppercase">
                  {selectedSymbol}
                </Badge>
              </div>
              <span className="text-xl font-extrabold tracking-widest block uppercase drop-shadow-[0_0_10px_rgba(16,185,129,0.2)] mt-0.5">
                {marketRegime}
              </span>
              <span className="text-[9px] text-zinc-400 block">
                GEX: {currentGexRegime} · VIX: {vixValue.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center">
              <span className={`px-2 py-1 rounded text-[9px] font-extrabold uppercase select-none ${regimeBadgeBg}`}>
                {marketRegime === 'EUPHORIA' ? '🔥 ULTRA RISK-ON' : marketRegime === 'BULLISH' ? '🟢 BUY THE DIPS' : marketRegime === 'BEARISH' ? '🔴 FADE THE RIPS' : '🟡 RANGE'}
              </span>
            </div>
          </div>
        )}

        {/* Widget 2: Mega Caps Tracking Panel */}
        <div className="motion-panel p-3 border border-emerald-500/20 rounded bg-zinc-900/30 flex flex-col justify-center min-h-[76px]">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[9px] text-emerald-500/70 block uppercase tracking-wider font-semibold">MEGA-CAPS CO-TREND</span>
            <Badge variant="outline" className="text-[8px] px-1 py-0.5 border-emerald-500/20 text-emerald-400">NASDAQ Heavy</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
            <div className="flex flex-col justify-between p-1 border border-emerald-500/5 bg-zinc-950/40 rounded text-center">
              <span className="font-semibold text-zinc-400">AAPL</span>
              <span className={AAPL_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {AAPL_change >= 0 ? '▲' : '▼'} {AAPL_change.toFixed(1)}%
              </span>
            </div>
            <div className="flex flex-col justify-between p-1 border border-emerald-500/5 bg-zinc-950/40 rounded text-center">
              <span className="font-semibold text-zinc-400">MSFT</span>
              <span className={MSFT_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {MSFT_change >= 0 ? '▲' : '▼'} {MSFT_change.toFixed(1)}%
              </span>
            </div>
            <div className="flex flex-col justify-between p-1 border border-emerald-500/5 bg-zinc-950/40 rounded text-center">
              <span className="font-semibold text-zinc-400">NVDA</span>
              <span className={NVDA_change >= 0 ? 'text-green-400' : 'text-red-400'}>
                {NVDA_change >= 0 ? '▲' : '▼'} {NVDA_change.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>

        {/* Widget 3: Real-Time API Health Panel */}
        <div className="motion-panel p-3 border border-emerald-500/20 rounded bg-zinc-900/30 flex flex-col justify-center min-h-[76px]">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[9px] text-emerald-500/70 block uppercase tracking-wider font-semibold">INTEGRATION HEALTH STATUS</span>
            {healthLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />
            ) : (
              <Badge variant="outline" className="text-[8px] px-1 py-0.5 border-emerald-500/20 text-emerald-400 font-mono">Normal</Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-1 text-[9px] font-mono justify-between">
            {healthData.yahooFinance.status !== 'N/A' && (
              <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="Yahoo Finance">
                <span className={healthData.yahooFinance.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">YF</span>
                <span className="text-zinc-300">{healthData.yahooFinance.latencyMs}ms</span>
              </div>
            )}
            {healthData.sscgexPortal.status !== 'N/A' && (
              <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="GEX Portal API">
                <span className={healthData.sscgexPortal.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">GEX</span>
                <span className="text-zinc-300">{healthData.sscgexPortal.latencyMs}ms</span>
              </div>
            )}
            {healthData.polygon.status !== 'N/A' && (
              <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="Polygon API">
                <span className={healthData.polygon.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">POLY</span>
                <span className="text-zinc-300">{healthData.polygon.latencyMs}ms</span>
              </div>
            )}
            {healthData.openRouter.status !== 'N/A' && (
              <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="OpenRouter AI">
                <span className={healthData.openRouter.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">AI</span>
                <span className="text-zinc-300">{healthData.openRouter.latencyMs}ms</span>
              </div>
            )}
            {healthData.discord?.status !== 'N/A' && (
              <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="Discord Webhook API">
                <span className={healthData.discord?.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">DISC</span>
                <span className="text-zinc-300">{healthData.discord?.latencyMs ?? 0}ms</span>
              </div>
            )}
            {healthData.alpaca?.status !== 'N/A' && (
              <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="Alpaca API">
                <span className={healthData.alpaca?.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">ALPA</span>
                <span className="text-zinc-300">{healthData.alpaca?.latencyMs ?? 0}ms</span>
              </div>
            )}
            <div className="px-1.5 py-0.5 border border-emerald-500/5 bg-zinc-950/40 rounded flex items-center gap-1" title="Real-Time Streaming WebSocket">
              <span className={isConnected ? 'text-green-400 animate-pulse' : 'text-red-400 animate-pulse'}>●</span>
              <span className="text-zinc-500 font-bold">STREAM</span>
              <span className="text-zinc-300">{isConnected ? 'LIVE' : 'CONN...'}</span>
            </div>
          </div>
        </div>

        {/* Widget 4: Runtime service health */}
        <div className="motion-panel p-3 border border-cyan-500/20 rounded bg-zinc-900/30 flex flex-col justify-center min-h-[76px]">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[9px] text-cyan-300/80 block uppercase tracking-wider font-semibold">LIVE EXIT SERVICES</span>
            <Badge
              variant="outline"
              className={`text-[8px] px-1 py-0.5 font-mono ${
                serviceHealth.liveExitMonitor.status === 'UP'
                  ? 'border-cyan-500/30 text-cyan-300'
                  : serviceHealth.liveExitMonitor.status === 'DEGRADED'
                    ? 'border-amber-500/40 text-amber-300'
                    : 'border-red-500/40 text-red-300'
              }`}
            >
              {serviceHealth.liveExitMonitor.provider.toUpperCase()}
            </Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[9px] font-mono">
            <div className="px-1.5 py-1 border border-cyan-500/10 bg-zinc-950/40 rounded" title={serviceHealth.liveExitMonitor.lastError || 'Live exit monitor'}>
              <div className="flex items-center gap-1">
                <span className={serviceHealth.liveExitMonitor.status === 'UP' ? 'text-green-400 animate-pulse' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">EXIT</span>
              </div>
              <div className="text-zinc-300">{serviceHealth.liveExitMonitor.matchedUpdates} matches</div>
            </div>
            <div className="px-1.5 py-1 border border-cyan-500/10 bg-zinc-950/40 rounded" title="Latest stream tick processed by live exit monitor">
              <div className="text-zinc-500 font-bold">LAST TICK</div>
              <div className="text-zinc-300">{formatRelativeTime(serviceHealth.liveExitMonitor.lastQuoteAt)}</div>
            </div>
            <div className="px-1.5 py-1 border border-cyan-500/10 bg-zinc-950/40 rounded" title="Active option stream subscriptions">
              <div className="text-zinc-500 font-bold">SUBS</div>
              <div className="text-zinc-300">
                {serviceHealth.liveExitMonitor.provider === 'alpaca'
                  ? serviceHealth.streams.alpaca.activeSubscriptions
                  : serviceHealth.streams.questrade.activeSubscriptions}
              </div>
            </div>
            <div className="px-1.5 py-1 border border-cyan-500/10 bg-zinc-950/40 rounded" title="Polling fallback remains available if stream misses ticks">
              <div className="flex items-center gap-1">
                <span className={serviceHealth.poller.running ? 'text-green-400' : 'text-red-400'}>●</span>
                <span className="text-zinc-500 font-bold">FALLBACK</span>
              </div>
              <div className="text-zinc-300">{serviceHealth.poller.running ? 'poller on' : 'poller off'}</div>
            </div>
          </div>
        </div>

      </div>

      {/* Execution Setup */}
      <div className="motion-panel border border-emerald-500/15 rounded bg-zinc-900/30 overflow-hidden">
        <div className="p-2.5 px-3 bg-zinc-900/80 border-b border-emerald-500/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className={`h-4 w-4 ${isLiveBroker ? 'text-amber-400 animate-pulse' : 'text-emerald-400'}`} />
            <span className="text-xs font-bold text-emerald-300">Execution setup</span>
            {remainingTrades <= 0 && (
              <Badge variant="outline" className="text-[8px] border-red-500/40 text-red-300 bg-red-950/20">
                Daily limit reached
              </Badge>
            )}
            {missingLiveExecutionItems.map(item => (
              <Badge key={item} variant="outline" className="text-[8px] border-amber-500/40 text-amber-300 bg-amber-950/20">
                {item}
              </Badge>
            ))}
          </div>
          <span className="text-[10px] text-zinc-500">
            {isExecutionBlocked ? 'Resolve blockers before sending an order.' : 'Ready for pending signals.'}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-px bg-emerald-500/10">
          {readinessItems.map(item => (
            <div key={item.label} className="motion-panel bg-zinc-950/70 px-3 py-2 min-h-[54px] flex flex-col justify-center">
              <span className="text-[9px] uppercase text-zinc-500 font-bold">{item.label}</span>
              <span className={`text-xs font-bold truncate ${item.tone}`} title={item.value}>{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Row 2: Separated Prominent latest setup notification */}
      <div 
        onClick={() => latestActionableSignal && setSelectedSignalId(latestActionableSignal.id)}
        className={`motion-panel border rounded-lg backdrop-blur-md overflow-hidden transition-all duration-500 ${
          latestActionableSignal 
            ? 'border-emerald-500/50 shadow-[0_0_25px_rgba(16,185,129,0.15)] bg-zinc-900/45 cursor-pointer hover:bg-zinc-900/60 hover:shadow-[0_0_35px_rgba(16,185,129,0.25)] hover:border-emerald-400' 
            : 'border-emerald-500/10 shadow-inner bg-zinc-900/15'
        }`}
      >
        <div className="bg-emerald-950/20 border-b border-emerald-500/15 p-2.5 px-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-400" />
            <h3 className="text-xs font-extrabold text-emerald-300">
              Latest trade setup
            </h3>
          </div>
          {!isDayTradingEnabled ? (
            <Badge variant="outline" className="bg-zinc-900 text-zinc-400 border-zinc-700 text-[8px] px-1.5 py-0.5">
              OFFLINE
            </Badge>
          ) : latestActionableSignal ? (
            <Badge variant="outline" className="bg-emerald-950 text-emerald-300 border-emerald-500/40 text-[8px] px-1.5 py-0.5 font-bold">
              Ready to review
            </Badge>
          ) : (
            <span className="text-[9px] text-emerald-500/40 font-bold">No active setup</span>
          )}
        </div>
        
        <div className="p-3">
          {!isDayTradingEnabled || isScannerMarketClosed ? (
            <div className="py-6 flex flex-col items-center justify-center text-center text-zinc-500 text-xs">
              <ShieldAlert className={`h-8 w-8 mb-2 ${isScannerMarketClosed ? 'text-sky-400/80' : 'text-amber-500/80 animate-pulse'}`} />
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
            <div className="py-5 flex flex-col items-center justify-center text-center text-emerald-500/40 text-xs">
              <AlertCircle className="h-8 w-8 opacity-30 mb-2" />
              <span>No setup meets your filters right now.</span>
              <span className="text-[10px] text-zinc-500 mt-1">Next scan in {formatMinSec(countdown)}.</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
              <div className="lg:col-span-2 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-extrabold uppercase ${
                    latestActionableSignal.signal_type === 'CALL' ? 'bg-green-950 text-green-300 border border-green-500/30' : 'bg-red-950 text-red-300 border border-red-500/30'
                  }`}>
                    {latestActionableSignal.signal_type} SIGNAL
                  </span>
                  <span className="text-xs font-bold text-emerald-200">
                    {latestActionableSignal.symbol} ${latestActionableSignal.current_price.toFixed(2)}
                  </span>
                  <span className="text-[9px] text-emerald-400/70 ml-auto bg-zinc-950/60 p-1 border border-emerald-500/5 rounded">
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

                <div className="grid grid-cols-3 gap-3 border-t border-emerald-500/10 pt-2.5 text-center">
                  <div className="bg-zinc-950/40 border border-emerald-500/10 p-2 rounded">
                    <span className="text-[9px] text-emerald-500/60 block uppercase font-semibold">ENTRY TRIGGER</span>
                    <span className="text-xs font-bold font-mono text-emerald-200">
                      &gt;${latestActionableSignal.entry_trigger?.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-zinc-950/40 border border-emerald-500/10 p-2 rounded">
                    <span className="text-[9px] text-emerald-500/60 block uppercase font-semibold">STOP LOSS</span>
                    <span className="text-xs font-bold font-mono text-red-400">
                      ${latestActionableSignal.stop_loss?.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-zinc-950/40 border border-emerald-500/10 p-2 rounded">
                    <span className="text-[9px] text-emerald-500/60 block uppercase font-semibold">TARGET LEVEL</span>
                    <span className="text-xs font-bold font-mono text-green-400">
                      ${latestActionableSignal.target_price?.toFixed(2)}
                    </span>
                  </div>
                </div>

                {latestActionableSignal.option_details && (
                  <div className="grid grid-cols-3 gap-3 border-t border-emerald-500/10 pt-2.5 text-center text-[10px] font-mono text-sky-400 bg-zinc-950/20 p-2 rounded">
                    <div>
                      <span className="text-[8px] text-zinc-500 block uppercase font-semibold">OPTION CONTRACT</span>
                      <span className="font-bold text-zinc-300">{latestActionableSignal.option_details.ticker}</span>
                    </div>
                    <div>
                      <span className="text-[8px] text-zinc-500 block uppercase font-semibold">SUGGESTED PREMIUM</span>
                      <span className="font-bold text-sky-300">
                        ${latestActionableSignal.option_details.mark !== undefined ? Number(latestActionableSignal.option_details.mark).toFixed(2) : 'N/A'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[8px] text-zinc-500 block uppercase font-semibold">PREMIUM SL / TP</span>
                      <span className="font-bold text-zinc-300">
                        ${latestActionableSignal.option_details.suggestedStopLoss !== undefined ? Number(latestActionableSignal.option_details.suggestedStopLoss).toFixed(2) : 'N/A'} / ${latestActionableSignal.option_details.suggestedTakeProfit !== undefined ? Number(latestActionableSignal.option_details.suggestedTakeProfit).toFixed(2) : 'N/A'}
                      </span>
                    </div>
                  </div>
                )}

                {/* Option premium suggestion */}
                {latestActionableSignal.gex && (
                  <div className="bg-zinc-950/60 border border-emerald-500/10 p-2 rounded font-mono text-[10px] text-sky-400">
                    Options plan: buy premium near ${latestActionableSignal.indicators?.vwap ? (Number(latestActionableSignal.indicators.vwap) * 0.003).toFixed(2) : '1.50'} | stop -20% | target +40%
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 border-t border-emerald-500/10 pt-2 text-[10px]">
                  <div className="bg-zinc-950/50 border border-emerald-500/10 rounded p-2">
                    <span className="block text-zinc-500 uppercase font-bold">Execution</span>
                    <span className={isLiveBroker ? 'text-amber-300 font-bold' : 'text-sky-300 font-bold'}>{brokerLabel}</span>
                  </div>
                  <div className="bg-zinc-950/50 border border-emerald-500/10 rounded p-2">
                    <span className="block text-zinc-500 uppercase font-bold">Quantity</span>
                    <span className="text-emerald-300 font-bold">{contractsPerTrade} contract{contractsPerTrade === 1 ? '' : 's'}</span>
                  </div>
                  <div className="bg-zinc-950/50 border border-emerald-500/10 rounded p-2">
                    <span className="block text-zinc-500 uppercase font-bold">Est. Max Debit</span>
                    <span className="text-zinc-200 font-bold">
                      {latestActionableSignal.option_details?.mark
                        ? `$${(Number(latestActionableSignal.option_details.mark) * contractsPerTrade * 100).toFixed(2)}`
                        : 'N/A'}
                    </span>
                  </div>
                  <div className={`bg-zinc-950/50 border rounded p-2 ${getSignalExecutionTone(latestActionableSignal)}`}>
                    <span className="block uppercase font-bold opacity-80">Status</span>
                    <span className="font-bold">{latestActionableSignal.execution_status || latestActionableSignal.status}</span>
                  </div>
                </div>
              </div>

              {/* News-Aware AI Coach Panel */}
              <div className="p-3 rounded border border-emerald-500/10 bg-zinc-950/30 flex flex-col justify-between gap-2.5">
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
                <div className="flex justify-end gap-2 border-t border-emerald-500/10 pt-2">
                  <Button
                    size="sm"
                    className="h-6 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-[10px] shadow-[0_0_0_rgba(16,185,129,0)] hover:shadow-[0_0_18px_rgba(16,185,129,0.25)]"
                    disabled={isExecutionBlocked || !isExecutableSetupGrade(latestActionableSignal)}
                    onClick={() => handleQuickStatus(latestActionableSignal.id, 'EXECUTED')}
                  >
                    Execute Trade
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-red-400 hover:text-red-300 hover:bg-red-950/25 text-[10px]"
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

      {/* TradingView Chart Embed - Horizontal Full Width */}
      <div className="motion-panel border border-emerald-500/20 rounded bg-zinc-900/30 overflow-hidden flex flex-col">
        <div className="p-2.5 px-3 bg-zinc-900 border-b border-emerald-500/20 flex justify-between items-center">
          <div className="flex items-center gap-2 min-w-0">
            <Activity className="h-4 w-4 text-emerald-400 animate-pulse shrink-0" />
            <div className="min-w-0">
              <span className="block text-xs font-bold text-emerald-300">
                Live chart · {selectedSymbol === 'BOTH' ? 'QQQ and SPY' : selectedSymbol}
              </span>
              <span className="block text-[9px] text-zinc-500 truncate">5m candles with EMA9, EMA21, and VWAP</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowChart(!showChart)}
              className="motion-press text-[9px] font-bold border border-emerald-500/35 text-emerald-400 hover:bg-emerald-950/20 px-2 py-0.5 rounded bg-zinc-950/40 transition-colors font-mono"
            >
              {showChart ? 'Collapse' : 'Expand'}
            </button>
            <Badge variant="outline" className="text-[9px] border-emerald-500/20 text-emerald-400 font-semibold font-mono">
              Real-time
            </Badge>
          </div>
        </div>
        {showChart && (
          <div className={`w-full ${selectedSymbol === 'BOTH' ? 'h-[300px] sm:h-[360px] lg:h-[420px] grid grid-cols-1 md:grid-cols-2 gap-2 p-2 bg-zinc-950' : 'h-[300px] sm:h-[360px] lg:h-[420px] bg-zinc-950'} animate-in fade-in slide-in-from-top-1 duration-200`}>
            {(selectedSymbol === 'BOTH' || selectedSymbol === 'QQQ') && (
              <iframe
                title="TradingView Real-Time Chart QQQ"
                src="https://s.tradingview.com/widgetembed/?frameElementId=tradingview_chart_qqq&symbol=NASDAQ:QQQ&interval=5&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=18181b&studies=%5B%22STD%3BEMA%22%2C%22STD%3BVWAP%22%5D&theme=dark&style=1&timezone=America%2FNew_York"
                width="100%"
                height="100%"
                style={{ border: 'none' }}
              />
            )}
            {(selectedSymbol === 'BOTH' || selectedSymbol === 'SPY') && (
              <iframe
                title="TradingView Real-Time Chart SPY"
                src="https://s.tradingview.com/widgetembed/?frameElementId=tradingview_chart_spy&symbol=AMEX:SPY&interval=5&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=18181b&studies=%5B%22STD%3BEMA%22%2C%22STD%3BVWAP%22%5D&theme=dark&style=1&timezone=America%2FNew_York"
                width="100%"
                height="100%"
                style={{ border: 'none' }}
              />
            )}
          </div>
        )}
      </div>

      {/* Row 3: Signals Process Table + Detailed Inspector */}
      <div className="grid grid-cols-1 2xl:grid-cols-3 gap-4 lg:gap-6 min-w-0">
        
        {/* Table List (Process Monitor) */}
        <div className="motion-panel 2xl:col-span-2 overflow-hidden flex flex-col border border-emerald-500/20 rounded bg-zinc-900/30 min-w-0">
          
          {/* Tab Selector */}
          <div className="flex bg-zinc-950/80 border-b border-emerald-500/20 p-1">
            <button
              onClick={() => setActiveTab('signals')}
              className={`flex-1 py-2 text-xs font-bold font-mono transition-all rounded ${
                activeTab === 'signals' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/50 hover:text-emerald-400'
              }`}
            >
              Signals
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              className={`flex-1 py-2 text-xs font-bold font-mono transition-all rounded ${
                activeTab === 'logs' ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30' : 'text-emerald-500/50 hover:text-emerald-400'
              }`}
            >
              Scan logs ({filteredLogs.length})
            </button>
          </div>

          {/* Filter bar + action buttons */}
          <div className="p-2.5 bg-zinc-900 border-b border-emerald-500/20 flex flex-col sm:flex-row flex-wrap gap-2 items-start sm:items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
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
                <span className="text-[10px] text-emerald-500/70 font-bold uppercase">Chronological Scan Runs (5m intervals)</span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {triggerMsg && (
                <span className="text-[9px] text-amber-400 animate-pulse max-w-[180px] truncate">{triggerMsg}</span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] font-bold border-amber-500/30 text-amber-400 hover:text-amber-300 hover:border-amber-400 hover:bg-amber-950/30 hover:shadow-[0_0_12px_rgba(245,158,11,0.2)] transition-all duration-300 gap-1 bg-zinc-950/40"
                onClick={handleTriggerScan}
                disabled={triggerLoading}
              >
                {triggerLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                {triggerLoading ? 'SCANNING...' : 'TRIGGER SCAN'}
              </Button>
              <details className="smooth-details relative">
                <summary className="motion-press h-7 list-none cursor-pointer text-[10px] font-bold border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 rounded px-2 py-1 bg-zinc-950/40">
                  DEV TOOLS
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-40 rounded border border-zinc-700 bg-zinc-950 p-2 shadow-xl space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full text-[10px] font-bold border-emerald-500/30 text-emerald-400 hover:text-emerald-300 hover:border-emerald-400 hover:bg-emerald-950/30 gap-1 bg-zinc-950/40"
                    onClick={async () => {
                      if (confirm("Are you sure you want to seed mock data?")) {
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
                      if (confirm("Wipe all day trading signals and logs from database?")) {
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
            <div className="overflow-x-auto">
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
                        RETRIEVING FROM POSTGRES...
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
                            className={`motion-row border-b border-emerald-500/10 hover:bg-emerald-950/10 cursor-pointer transition-all duration-300 ${
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
                            <td className="px-2 py-1.5 text-emerald-300 font-mono">${Number(sig.current_price).toFixed(2)}</td>
                            <td className="hidden md:table-cell px-2 py-1.5 font-mono">{sig.entry_trigger ? `$${Number(sig.entry_trigger).toFixed(2)}` : '-'}</td>
                            <td className="hidden md:table-cell px-2 py-1.5 font-mono text-red-400/95">{sig.stop_loss ? `$${Number(sig.stop_loss).toFixed(2)}` : '-'}</td>
                            <td className="hidden md:table-cell px-2 py-1.5 font-mono text-green-400/95">{sig.target_price ? `$${Number(sig.target_price).toFixed(2)}` : '-'}</td>
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
                                    {sig.execution_error ? 'EXEC ERROR' : sig.execution_status}
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
                                {aiPending ? (
                                  <div className="flex items-center gap-2 text-[10px] text-amber-400/80 animate-pulse">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    AI coaching is being generated in the background...
                                  </div>
                                ) : hasAi ? (
                                  <div className="space-y-2">
                                    <span className="text-[10px] font-bold text-amber-400 uppercase flex items-center gap-1">
                                      <Zap className="h-3 w-3" /> AI_COACH_COMMENTARY
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
          ) : (
            <div className="overflow-x-auto">
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
                        RETRIEVING SCANNER LOGS FROM POSTGRES...
                      </td>
                    </tr>
                  ) : filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-2 py-8 text-center text-red-500/80 font-bold">
                        [NO SCANNER RUN LOGS FOUND]
                        <div className="text-[10px] text-emerald-600 mt-2 font-normal">
                          Click 'TRIGGER SCAN' above to run a live scanner evaluation cycle.
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
                            className={`motion-row border-b border-emerald-500/10 hover:bg-emerald-950/10 cursor-pointer transition-all duration-300 ${
                              isSelected ? 'bg-emerald-950/30 border-l-2 border-l-emerald-400 shadow-[inset_4px_0_12px_-4px_rgba(16,185,129,0.25)]' : ''
                            }`}
                          >
                            <td className="px-1 py-1.5" onClick={e => { e.stopPropagation(); setExpandedLogId(isExpanded ? null : log.id); }}>
                              <button className="motion-press text-emerald-500/50 hover:text-emerald-300 transition-colors">
                                <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                              </button>
                            </td>
                            <td className="px-2 py-1.5 font-semibold text-emerald-500">#{log.id}</td>
                            <td className="px-2 py-1.5 text-zinc-400 font-mono">{new Date(log.created_at).toLocaleTimeString('en-US')}</td>
                            <td className="px-2 py-1.5 font-bold text-emerald-200">{log.symbol}</td>
                            <td className="px-2 py-1.5 font-mono text-emerald-300">${Number(log.spot_price).toFixed(2)}</td>
                            <td className="px-2 py-1.5 text-zinc-400 uppercase">{log.regime}</td>
                            <td className="px-2 py-1.5 text-zinc-400 font-mono">{log.vix != null ? Number(log.vix).toFixed(2) : '-'}</td>
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
                                      <div><span className="text-zinc-500">VWAP:</span> ${Number(log.indicators.vwap).toFixed(2)}</div>
                                      <div><span className="text-zinc-500">ATR14:</span> ${Number(log.indicators.atr14).toFixed(2)}</div>
                                      <div><span className="text-zinc-500">EMA9:</span> {log.indicators.ema9 ? `$${Number(log.indicators.ema9).toFixed(2)}` : '-'}</div>
                                      <div><span className="text-zinc-500">EMA21:</span> {log.indicators.ema21 ? `$${Number(log.indicators.ema21).toFixed(2)}` : '-'}</div>
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
          )}
        </div>
 
         {/* Detailed Inspector Panel */}
         <div className="motion-panel border border-emerald-500/20 rounded bg-zinc-900/20 flex flex-col h-[440px] 2xl:h-auto overflow-hidden min-w-0">
           <div className="p-3 bg-zinc-900 border-b border-emerald-500/20 flex justify-between items-center">
             <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
               <Info className="h-3.5 w-3.5 text-emerald-400" />
               OPTION DETAILS
             </span>
             {selectedSignal && (
               <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                 {selectedSignal.symbol} #{selectedSignal.id}
               </Badge>
             )}
           </div>
 
           <div className="p-4 flex-1 overflow-y-auto space-y-4 text-xs">
             {!selectedSignal ? (
               <div className="h-full flex flex-col items-center justify-center text-center text-emerald-500/40">
                 <HelpCircle className="h-10 w-10 opacity-30 mb-2" />
                 Select an alert from the left log table to inspect its technical details.
               </div>
             ) : (
               <div className="space-y-4 motion-enter">
                 {/* Meta details */}
                 <div className="grid grid-cols-3 gap-2 border-b border-emerald-500/10 pb-3">
                   <div>
                     <span className="text-[10px] text-emerald-500/60 block">MARKET DATE</span>
                     <span className="font-semibold text-emerald-300">{selectedSignal.market_date || '-'}</span>
                   </div>
                   <div>
                     <span className="text-[10px] text-emerald-500/60 block">TIME STAMP</span>
                     <span className="font-semibold text-emerald-300">
                       {new Date(selectedSignal.created_at).toLocaleTimeString('en-US')}
                     </span>
                   </div>
                   <div>
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

                 <div className={`rounded border p-2.5 text-[10px] ${getSignalExecutionTone(selectedSignal)}`}>
                   <div className="flex items-center justify-between gap-2 mb-2">
                     <span className="font-bold uppercase">EXECUTION_STATUS</span>
                     <span className="font-bold">{selectedSignal.execution_status || selectedSignal.status}</span>
                   </div>
                   <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
                     <div className="flex justify-between gap-2">
                       <span className="opacity-70">Broker</span>
                       <span className="font-semibold truncate">{getExecutionBrokerLabel(selectedSignal.execution_broker)}</span>
                     </div>
                     <div className="flex justify-between gap-2">
                       <span className="opacity-70">Contracts</span>
                       <span className="font-semibold">{selectedSignal.contracts_requested ?? '-'}</span>
                     </div>
                     <div className="flex justify-between gap-2 col-span-2">
                       <span className="opacity-70">Order ID</span>
                       <span className="font-semibold truncate">{selectedSignal.broker_order_id || '-'}</span>
                     </div>
                     <div className="flex justify-between gap-2 col-span-2">
                       <span className="opacity-70">Trade ID</span>
                       <span className="font-semibold truncate">{selectedSignal.broker_trade_id || '-'}</span>
                     </div>
                   </div>
                   {selectedSignal.execution_error && (
                     <div className="mt-2 border-t border-current/20 pt-2 text-red-200 leading-relaxed">
                       {selectedSignal.execution_error}
                     </div>
                   )}
                 </div>
 
                 {/* Option Contract Details Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-sky-400 uppercase flex items-center gap-1">
                     <TrendingUp className="h-3 w-3 text-sky-400" /> OPTION_CONTRACT_DETAILS
                   </span>
                   {selectedSignal.option_details ? (
                     <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-sky-500/30 font-mono text-[11px] text-zinc-300">
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5 col-span-2">
                         <span className="text-emerald-500/70">TICKER</span>
                         <span className="font-bold text-sky-300">{selectedSignal.option_details.ticker || 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">OPTION TYPE</span>
                         <span className={`font-bold ${selectedSignal.option_details.side === 'CALL' ? 'text-green-400 animate-pulse' : 'text-red-400 animate-pulse'}`}>
                           {selectedSignal.option_details.side || 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">STRIKE</span>
                         <span className="font-semibold text-emerald-300">
                           {selectedSignal.option_details.strike !== undefined ? `$${Number(selectedSignal.option_details.strike).toFixed(2)}` : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">PREMIUM (MARK)</span>
                         <span className="font-bold text-emerald-300">
                           {selectedSignal.option_details.mark !== undefined ? `$${Number(selectedSignal.option_details.mark).toFixed(2)}` : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EXPIRATION</span>
                         <span>{selectedSignal.option_details.expiry || 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">BID / ASK</span>
                         <span>
                           {selectedSignal.option_details.bid !== undefined && selectedSignal.option_details.ask !== undefined
                             ? `$${Number(selectedSignal.option_details.bid).toFixed(2)} / $${Number(selectedSignal.option_details.ask).toFixed(2)}`
                             : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">SPREAD</span>
                         <span>
                           {selectedSignal.option_details.spread !== undefined && selectedSignal.option_details.spreadPct !== undefined
                             ? `$${Number(selectedSignal.option_details.spread).toFixed(2)} (${Number(selectedSignal.option_details.spreadPct).toFixed(1)}%)`
                             : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">VOLUME</span>
                         <span>{selectedSignal.option_details.volume !== undefined ? Number(selectedSignal.option_details.volume).toLocaleString() : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">OPEN INTEREST</span>
                         <span>{selectedSignal.option_details.openInterest !== undefined ? Number(selectedSignal.option_details.openInterest).toLocaleString() : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">SUGGESTED SL</span>
                         <span className="text-red-400 font-semibold">
                           {selectedSignal.option_details.suggestedStopLoss !== undefined ? `$${Number(selectedSignal.option_details.suggestedStopLoss).toFixed(2)}` : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">SUGGESTED TP</span>
                         <span className="text-green-400 font-semibold">
                           {selectedSignal.option_details.suggestedTakeProfit !== undefined ? `$${Number(selectedSignal.option_details.suggestedTakeProfit).toFixed(2)}` : 'N/A'}
                         </span>
                       </div>
                     </div>
                    ) : (
                      <div className="text-zinc-500 italic p-3 bg-zinc-950/40 rounded border border-zinc-800/50 font-mono text-[10px] leading-relaxed">
                        {activeTab === 'logs' 
                          ? 'INFO: Selected record is a background scanner execution log. Option contract specifications are only generated and saved for active trade signals.'
                          : 'INFO: No option contract specifications exist for this historical record.'}
                      </div>
                    )}
                 </div>

                 {/* Indicators Block */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <Activity className="h-3 w-3" /> TECHNICAL_INDICATORS
                   </span>
                   {selectedSignal.indicators ? (
                     <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">VWAP</span>
                         <span>{selectedSignal.indicators.vwap ? `$${Number(selectedSignal.indicators.vwap).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ATR14</span>
                         <span>{selectedSignal.indicators.atr14 ? `$${Number(selectedSignal.indicators.atr14).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EMA 9</span>
                         <span>{selectedSignal.indicators.ema9 ? `$${Number(selectedSignal.indicators.ema9).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">EMA 21</span>
                         <span>{selectedSignal.indicators.ema21 ? `$${Number(selectedSignal.indicators.ema21).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ORH (15m)</span>
                         <span>{selectedSignal.indicators.openingRangeHigh ? `$${Number(selectedSignal.indicators.openingRangeHigh).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">ORL (15m)</span>
                         <span>{selectedSignal.indicators.openingRangeLow ? `$${Number(selectedSignal.indicators.openingRangeLow).toFixed(2)}` : 'N/A'}</span>
                       </div>
                     </div>
                   ) : (
                     <div className="text-emerald-500/50 italic p-2 bg-zinc-950/40 rounded border border-emerald-500/5">No technical data available.</div>
                   )}
                 </div>
 
                 {/* GEX Blocks */}
                 <div className="space-y-1">
                   <span className="text-[10px] font-bold text-emerald-500 uppercase flex items-center gap-1">
                     <TrendingUp className="h-3 w-3" /> GAMMA_EXPOSURE_PROFILE
                   </span>
                   {selectedSignal.gex ? (
                     <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Net GEX</span>
                         <span className={Number(selectedSignal.gex.netGex) >= 0 ? 'text-green-400' : 'text-red-400'}>
                           {selectedSignal.gex.netGex ? `${Number(selectedSignal.gex.netGex).toLocaleString()}` : 'N/A'}
                         </span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">GEX Regime</span>
                         <span className="font-semibold text-emerald-300">{selectedSignal.gex.regime || 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Flip Strike</span>
                         <span>{selectedSignal.gex.flipStrike ? `$${Number(selectedSignal.gex.flipStrike).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Call Wall</span>
                         <span>{selectedSignal.gex.callWall ? `$${Number(selectedSignal.gex.callWall).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Put Wall</span>
                         <span>{selectedSignal.gex.putWall ? `$${Number(selectedSignal.gex.putWall).toFixed(2)}` : 'N/A'}</span>
                       </div>
                       <div className="flex justify-between border-b border-emerald-500/5 pb-0.5">
                         <span className="text-emerald-500/70">Flow Dir.</span>
                         <span className="font-semibold text-sky-400 text-[10px]">{selectedSignal.gex.flowDirection || 'N/A'}</span>
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
                     <div className="flex gap-4 justify-between bg-zinc-950/60 p-2.5 rounded border border-emerald-500/10 font-mono text-[11px]">
                       <div className="flex items-center gap-2">
                         <span className="text-emerald-500/70">VIX:</span>
                         <span className="font-semibold text-emerald-200">
                           {selectedSignal.volatility.vixQuote ? Number(selectedSignal.volatility.vixQuote).toFixed(2) : 'N/A'}
                         </span>
                       </div>
                       <div className="flex items-center gap-2">
                         <span className="text-emerald-500/70">VIX Daily Chg:</span>
                         <span className={`font-semibold ${Number(selectedSignal.volatility.vixChangePercent) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                           {selectedSignal.volatility.vixChangePercent ? `${Number(selectedSignal.volatility.vixChangePercent).toFixed(2)}%` : 'N/A'}
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
                       <ShieldAlert className="h-3.5 w-3.5 text-red-500 animate-pulse" /> NO_TRADE_BLOCK_REASONS
                     </span>
                     <ul className="bg-red-950/15 border border-red-500/20 p-3 rounded text-[11px] space-y-1.5">
                       {selectedSignal.no_trade_reasons.map((reason, idx) => (
                         <li key={idx} className="flex gap-2 text-red-300">
                           <span className="text-red-500 font-bold select-none">[!]</span>
                           <span>{reason}</span>
                         </li>
                       ))}
                     </ul>
                   </div>
                 )}

                 {/* AI Coach Commentary */}
                 {selectedSignal.ai_coach_commentary && (
                   <div className="space-y-1">
                     <span className="text-[10px] font-bold text-amber-400 uppercase flex items-center gap-1">
                       <Zap className="h-3 w-3 text-amber-400 animate-pulse" /> AI_COACH_COMMENTARY
                     </span>
                     <div className="bg-zinc-950/60 border border-amber-500/15 p-2.5 rounded text-[10px] space-y-1">
                       {selectedSignal.ai_coach_commentary.split('\n').filter(Boolean).map((line, i) => {
                         const isPitfall = line.includes('⚠️') || line.toUpperCase().includes('PITFALL');
                         const isCatalyst = line.includes('✅') || line.toUpperCase().includes('CATALYST');
                         return (
                           <p key={i} className={isPitfall ? 'text-amber-300' : isCatalyst ? 'text-green-300' : 'text-zinc-300 italic'}>
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
                       📰 NEWS_CONTEXT_AT_SCAN
                     </span>
                     <div className="bg-zinc-950/40 border border-zinc-700/30 p-2 rounded text-[9px] text-zinc-500 space-y-0.5 leading-relaxed">
                       {selectedSignal.news_context.split('\n').map((line, i) => <div key={i}>{line}</div>)}
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
                    {executeDialogSignal.option_details?.mark !== undefined ? `$${Number(executeDialogSignal.option_details.mark).toFixed(2)}` : 'N/A'}
                  </span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Est. Debit</span>
                  <span className="text-zinc-100 font-bold">
                    {executeDialogSignal.option_details?.mark !== undefined
                      ? `$${(Number(executeDialogSignal.option_details.mark) * contractsPerTrade * 100).toFixed(2)}`
                      : 'N/A'}
                  </span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-900/70 p-2">
                  <span className="block text-[9px] text-zinc-500 uppercase">Stop / Target</span>
                  <span className="text-zinc-100 font-bold">
                    ${executeDialogSignal.stop_loss?.toFixed(2) || 'N/A'} / ${executeDialogSignal.target_price?.toFixed(2) || 'N/A'}
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
