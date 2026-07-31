export interface User {
  id: number;
  username: string;
  role: 'USER' | 'ADMIN';
}

export interface SignalReplayRequest {
  symbols?: string[];
  startDate?: string;
  endDate?: string;
  contractsPerTrade?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  maxTradesPerDay?: number;
  dailyProfitTarget?: number;
  dailyLossLimit?: number;
  interval?: '1m' | '5m' | '15m' | '1h' | '1d';
  maxSignals?: number;
}

export interface SignalReplayScenario {
  name: string;
  description: string;
  skippedSignals: number;
  skippedReasons: Record<string, number>;
  summary: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    averageWin: number;
    averageLoss: number;
    profitFactor: number;
    maxDrawdown: number;
    daysTested: number;
    greenDays: number;
    redDays: number;
    targetDays: number;
    lossLimitDays: number;
  };
  fillRealism: {
    rawTotalPnl: number;
    realisticTotalPnl: number;
    pnlDelta: number;
    skippedTrades: number;
    penalizedTrades: number;
    unchangedTrades: number;
  };
}

export interface SignalReplayResponse {
  config: SignalReplayRequest;
  signalsLoaded: number;
  generatedSignalsLoaded: number;
  blockedSignalsLoaded: number;
  signalsUsable: number;
  missingOptionData: number;
  blockedReplay: {
    blockedSignals: number;
    withContracts: number;
    replayedTrades: number;
    missingContract: number;
    missingPriceHistory: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    averagePnl: number;
    attribution: Array<{
      category: string;
      blockedSignals: number;
      replayedTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      totalPnl: number;
    }>;
    examples: Array<{
      signalId: number;
      date: string;
      symbol: string;
      side: 'CALL' | 'PUT';
      optionTicker: string;
      blockers: string[];
      outcome: 'WIN' | 'LOSS';
      pnl: number;
      exitReason: string;
    }>;
    ai: {
      status: 'INSUFFICIENT_EVIDENCE' | 'READY' | 'UNAVAILABLE';
      verdict: string | null;
      analysis: string | null;
      recommendations: string[];
      generatedAt: string | null;
    };
  };
  research: {
    experiment: 'vix_term_structure';
    candidateScenario: 'vix_contango';
    minimumRatio: number;
    signalsWithTermStructure: number;
    signalsMissingTermStructure: number;
    signalsBackfilledFromIbkr: number;
    signalsUnavailableForBackfill: number;
    minimumComparableTrades: number;
    status: 'INSUFFICIENT_DATA' | 'READY_FOR_REVIEW';
    baseline: Pick<SignalReplayScenario['summary'], 'trades' | 'winRate' | 'totalPnl' | 'profitFactor' | 'maxDrawdown'>;
    candidate: Pick<SignalReplayScenario['summary'], 'trades' | 'winRate' | 'totalPnl' | 'profitFactor' | 'maxDrawdown'>;
    delta: Pick<SignalReplayScenario['summary'], 'trades' | 'winRate' | 'totalPnl' | 'profitFactor' | 'maxDrawdown'>;
    notes: string[];
  };
  scenarios: SignalReplayScenario[];
}

export interface Position {
  id: number;
  symbol: string;
  option_type: 'CALL' | 'PUT';
  strike_price: number;
  expiration_date: string;
  entry_price: number;
  quantity: number;
  stop_loss_trigger?: number;
  take_profit_trigger?: number;
  trailing_high_price?: number;
  trailing_stop_loss_pct?: number;
  realized_pnl?: number;
  loss_avoided?: number;
  current_price?: number;
  underlying_stop_price?: number;
  status: 'PENDING_ORDER' | 'OPEN' | 'CLOSED' | 'STOP_TRIGGERED' | 'PROFIT_TRIGGERED';
  created_at: string;
  updated_at: string;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  iv?: number;
  max_favorable_price?: number;
  max_adverse_price?: number;
  mfe_pct?: number;
  mae_pct?: number;

  underlying_price?: number;
  analyzed_support?: number;
  analyzed_resistance?: number;
  suggested_stop_loss?: number;
  suggested_take_profit_1?: number;
  suggested_take_profit_2?: number;
  analysis_data?: any;
  is_simulated?: boolean;
  account_id?: string;
  execution_broker?: string;
  broker_order_id?: string;
  broker_trade_id?: string;
  broker_exit_order_id?: string;
  broker_exit_trade_id?: string;
  execution_account_id?: string;
  execution_status?: string;
  execution_error?: string;
  exit_retry_count?: number;
  last_broker_sync_at?: string;
  last_broker_order_status?: string;
  contracts_requested?: number;
  exit_price?: number;
  exit_requested_at?: string;
  exit_reason?: string;
  exit_order_type?: string;
  profit_trim_status?: string;
  profit_trim_quantity?: number;
  profit_trim_price?: number;
  profit_trim_order_id?: string;
  profit_trim_trade_id?: string;
  profit_trimmed_at?: string;
  notes?: string;
  signal_id?: number;
  strategy_setup_id?: string;
  strategy_engine_version?: string;
  strategy_lifecycle_status?: string;
  strategy_policy_fingerprint?: string;
  strategy_snapshot?: Record<string, any>;
  strategy_managed?: boolean;
  strategy_exit_requested_at?: string;
  strategy_exit_reason?: string;
}

export interface ClosedTradesResponse {
  trades: Position[];
  summary: {
    total: number;
    totalPnl: number;
    wins: number;
    losses: number;
    averagePnl: number;
    winRate: number;
  };
  page: number;
  limit: number;
  totalPages: number;
}

export interface TradeUsageResponse {
  used: number;
  max: number;
  remaining: number;
}

export interface TradeRuntimeResponse<T> {
  generatedAt: string;
  source: 'redis' | 'db';
  ageMs: number;
  data: T;
}

export interface AdapterHealth {
  status: string;
  latencyMs: number | null;
  lastGoodAt: string | null;
  lastError: string | null;
  freshnessMs: number | null;
  degradedReason: string | null;
  source: string;
}

export interface RuntimeConfigItem {
  id: string;
  group: 'Deployment' | 'Market Data' | 'AI Service' | 'Broker Execution' | 'Alerts';
  label: string;
  source: 'env' | 'settings' | 'default' | 'runtime';
  status: 'configured' | 'missing' | 'default' | 'attention';
  secret: boolean;
  value: string | null;
  detail: string;
}

export interface RuntimeConfigResponse {
  generatedAt: string;
  items: RuntimeConfigItem[];
}

export interface TradeEvent {
  id: number;
  user_id: number;
  position_id: number;
  event_type: string;
  message?: string | null;
  metadata?: any;
  created_at: string;
}

export interface TradeCommandCenterResponse {
  trade: Position;
  signal: any | null;
  nextAction: {
    label: string;
    detail: string;
  };
  riskPlan: {
    entryPrice: number;
    currentPrice: number | null;
    quantity: number;
    stopLoss: number | null;
    takeProfit: number | null;
    estimatedMaxLoss: number | null;
    mfePct: number | null;
    maePct: number | null;
    trim: {
      status: string | null;
      quantity: number | null;
      price: number | null;
      orderId: string | null;
      filledAt: string | null;
    };
    underlyingPlan: {
      stop: number | null;
      target: number | null;
    };
  };
  brokerProof: {
    broker: string;
    accountId: string | null;
    entryOrderId: string | null;
    entryTradeId: string | null;
    exitOrderId: string | null;
    exitTradeId: string | null;
    trimOrderId: string | null;
    trimTradeId: string | null;
    lastBrokerStatus: string | null;
    lastBrokerSyncAt: string | null;
    executionStatus: string | null;
    executionError: string | null;
  };
  events: TradeEvent[];
  generatedAt: string;
}

export interface TradeReportResponse {
  range: string;
  generatedAt: string;
  summary: {
    total: number;
    totalPnl: number;
    averagePnl: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number | null;
    bestTrade: number;
    worstTrade: number;
    averageWin: number;
    averageLoss: number;
    takeProfitExits: number;
    stopLossExits: number;
    supersededExits: number;
    manualExits: number;
    trimmedTrades: number;
  };
  bySymbol: Array<{
    symbol: string;
    total: number;
    totalPnl: number;
    wins: number;
    losses: number;
    winRate: number;
    averagePnl: number;
  }>;
  recentOutcomes: Array<Position & { outcomeDriver: string }>;
  skippedExecutions: Array<{
    signal_id: number;
    status?: string;
    execution_status?: string;
    execution_error?: string | null;
    updated_at: string;
    symbol?: string;
    signal_type?: string;
    trade_bias?: string;
    setup_grade?: string;
    no_trade_reasons?: string[];
  }>;
}

export interface TradeAlertsResponse {
  generatedAt: string;
  summary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
  alerts: Array<{
    id: string;
    severity: 'critical' | 'warning' | 'info';
    category: 'stale-entry' | 'stale-exit' | 'skipped-entry' | 'broker-degraded';
    title: string;
    message: string;
    tradeId?: number;
    signalId?: number;
    createdAt: string;
    metadata?: any;
  }>;
}

export interface CoveredCallSymbolResult {
  symbol: string;
  name: string;
  exchange?: string | null;
  quoteType?: string | null;
}

export interface CoveredCallCandidate {
  ticker: string;
  expiration: string;
  dte: number;
  strike: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  theta: number | null;
  impliedVolatility: number | null;
  premiumPerContract: number;
  premiumYieldPct: number;
  annualizedYieldPct: number;
  otmPct: number;
  score: number;
  eligible: boolean;
  reasons: string[];
}

export interface CoveredCallAnalysis {
  symbol: string;
  generatedAt: string;
  profile: 'conservative';
  quote: {
    price: number;
    name: string | null;
    currency: string | null;
    marketState: string | null;
  };
  scan: {
    minDte: number;
    maxDte: number;
    expirationsChecked: string[];
    contractsReviewed: number;
  };
  best: CoveredCallCandidate | null;
  candidates: CoveredCallCandidate[];
  news: Array<{
    title: string;
    publisher: string | null;
    link: string | null;
    publishedAt: string | null;
  }>;
  ai: {
    summary: string;
    bestContractTicker: string | null;
    riskNotes: string[];
    incomeRationale: string;
    avoidIf: string[];
    fallback: boolean;
    error?: string;
  };
}

export interface ManualEntrySettings {
  defaultTicker: string;
  contracts: number;
  trimCount: number;
  slippagePct: number;
  orderType: 'MARKET' | 'LIMIT';
  takeProfitPct: number | null;
  stopLossPct: number | null;
}

export interface ManualEntryQuote {
  ticker: string | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  spreadPct: number | null;
  quoteAgeMs?: number | null;
  timestamp: string | null;
}

export interface ManualEntryChain {
  symbol: string;
  optionType: 'CALL' | 'PUT';
  dte: 0 | 1 | 2;
  expiration: string;
  underlyingPrice: number | null;
  strikes: Array<{
    strike: number;
    ticker: string;
    bid: number | null;
    ask: number | null;
    mark: number | null;
    spreadPct: number | null;
    volume: number | null;
    openInterest: number | null;
    delta: number | null;
  }>;
}

const API_BASE = '/api';

const getToken = () => localStorage.getItem('token');

const readApiJson = async (res: Response, fallbackMessage: string) => {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!contentType.includes('application/json')) {
    const looksLikeHtml = text.trimStart().startsWith('<');
    throw new Error(
      looksLikeHtml
        ? 'API returned HTML instead of JSON. Check that the backend is running and /api is proxied correctly.'
        : fallbackMessage
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(fallbackMessage);
  }
};

const authFetch = async (url: string, options: any = {}) => {
  const token = getToken();
  const headers: any = {
    ...options.headers,
    'Authorization': token ? `Bearer ${token}` : '',
  };

  // Only set Content-Type if there's a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !url.includes('/auth/me')) {
    localStorage.removeItem('token');
    window.location.href = '/'; // Or trigger auth state change
  }
  return res;
};

const normalizePosition = (pos: any): Position => ({
  ...pos,
  strike_price: Number(pos.strike_price),
  entry_price: Number(pos.entry_price),
  quantity: Number(pos.quantity),
  stop_loss_trigger: pos.stop_loss_trigger != null ? Number(pos.stop_loss_trigger) : undefined,
  take_profit_trigger: pos.take_profit_trigger != null ? Number(pos.take_profit_trigger) : undefined,
  trailing_high_price: pos.trailing_high_price != null ? Number(pos.trailing_high_price) : undefined,
  current_price: pos.current_price != null ? Number(pos.current_price) : undefined,
  underlying_stop_price: pos.underlying_stop_price != null ? Number(pos.underlying_stop_price) : undefined,
  realized_pnl: pos.realized_pnl != null ? Number(pos.realized_pnl) : undefined,
  loss_avoided: pos.loss_avoided != null ? Number(pos.loss_avoided) : undefined,
  delta: pos.delta != null ? Number(pos.delta) : undefined,
  theta: pos.theta != null ? Number(pos.theta) : undefined,
  gamma: pos.gamma != null ? Number(pos.gamma) : undefined,
  vega: pos.vega != null ? Number(pos.vega) : undefined,
  iv: pos.iv != null ? Number(pos.iv) : undefined,
  underlying_price: pos.underlying_price != null ? Number(pos.underlying_price) : undefined,
  analyzed_support: pos.analyzed_support != null ? Number(pos.analyzed_support) : undefined,
  analyzed_resistance: pos.analyzed_resistance != null ? Number(pos.analyzed_resistance) : undefined,
  suggested_stop_loss: pos.suggested_stop_loss != null ? Number(pos.suggested_stop_loss) : undefined,
  suggested_take_profit_1: pos.suggested_take_profit_1 != null ? Number(pos.suggested_take_profit_1) : undefined,
  suggested_take_profit_2: pos.suggested_take_profit_2 != null ? Number(pos.suggested_take_profit_2) : undefined,
  contracts_requested: pos.contracts_requested != null ? Number(pos.contracts_requested) : undefined,
  exit_price: pos.exit_price != null ? Number(pos.exit_price) : undefined,
  exit_retry_count: pos.exit_retry_count != null ? Number(pos.exit_retry_count) : undefined,
  profit_trim_quantity: pos.profit_trim_quantity != null ? Number(pos.profit_trim_quantity) : undefined,
  profit_trim_price: pos.profit_trim_price != null ? Number(pos.profit_trim_price) : undefined,
  analysis_data: pos.analysis_data || undefined,
});

export const api = {
  // Auth
  async signup(data: any): Promise<{ token: string, user: User }> {
    const res = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await readApiJson(res, 'Signup failed');
      throw new Error(err.error || 'Signup failed');
    }
    const result = await readApiJson(res, 'Signup failed');
    localStorage.setItem('token', result.token);
    return result;
  },

  async signin(data: any): Promise<{ token: string, user: User }> {
    const res = await fetch(`${API_BASE}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await readApiJson(res, 'Signin failed');
      throw new Error(err.error || 'Signin failed');
    }
    const result = await readApiJson(res, 'Signin failed');
    localStorage.setItem('token', result.token);
    return result;
  },

  async getMe(): Promise<User> {
    const res = await authFetch(`${API_BASE}/auth/me`);
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
  },

  logout() {
    localStorage.removeItem('token');
    window.location.reload();
  },

  isAuthenticated(): boolean {
    return !!getToken();
  },

  // Admin
  async getAISettings(): Promise<any> {
    const res = await authFetch(`${API_BASE}/settings/ai`);
    if (!res.ok) throw new Error('Failed to fetch AI settings');
    return res.json();
  },

  async updateAISettings(data: any): Promise<void> {
    const res = await authFetch(`${API_BASE}/settings/ai`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to update AI settings');
  },

  async getAllUsers(): Promise<User[]> {
    const res = await authFetch(`${API_BASE}/admin/users`);
    if (!res.ok) throw new Error('Failed to fetch users');
    return res.json();
  },

  async updateUserRole(id: number, role: 'USER' | 'ADMIN'): Promise<void> {
    const res = await authFetch(`${API_BASE}/admin/users/${id}/role`, {
      method: 'POST',
      body: JSON.stringify({ role })
    });
    if (!res.ok) throw new Error('Failed to update user role');
  },

  async deleteUser(id: number): Promise<void> {
    const res = await authFetch(`${API_BASE}/admin/users/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete user');
    }
  },

  async resetUserPassword(id: number): Promise<void> {
    const res = await authFetch(`${API_BASE}/admin/users/${id}/reset-password`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to reset password');
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await authFetch(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to change password');
    }
  },

  async updateUsername(username: string): Promise<{ token: string, user: User }> {
    const res = await authFetch(`${API_BASE}/auth/update-profile`, {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update username');
    }
    const result = await res.json();
    localStorage.setItem('token', result.token);
    return result;
  },

  // Positions
  async getPositions(): Promise<Position[]> {
    const res = await authFetch(`${API_BASE}/positions?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch positions');
    const data = await res.json();

    return data.map(normalizePosition);
  },

  async getOpenTrades(): Promise<Position[]> {
    const res = await authFetch(`${API_BASE}/trades/open?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch open Wealthsimple trades');
    const data = await res.json();
    return data.map(normalizePosition);
  },

  async getOpenTradesRuntime(): Promise<TradeRuntimeResponse<Position[]>> {
    const res = await authFetch(`${API_BASE}/trades/open/runtime?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch open Wealthsimple trade runtime state');
    const data = await res.json();
    return { ...data, data: data.data.map(normalizePosition) };
  },

  async getTradeRuntime(id: number): Promise<TradeRuntimeResponse<Position>> {
    const res = await authFetch(`${API_BASE}/trades/${id}/runtime?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch Wealthsimple trade runtime state');
    const data = await res.json();
    return { ...data, data: normalizePosition(data.data) };
  },

  async getTradeCommandCenter(id: number): Promise<TradeCommandCenterResponse> {
    const res = await authFetch(`${API_BASE}/trades/${id}/command?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch trade command center');
    const data = await res.json();
    return { ...data, trade: normalizePosition(data.trade) };
  },

  async getTradeEvents(id: number): Promise<TradeEvent[]> {
    const res = await authFetch(`${API_BASE}/trades/${id}/events?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch trade events');
    return res.json();
  },

  async getTradeUsage(): Promise<TradeUsageResponse> {
    const res = await authFetch(`${API_BASE}/trades/usage?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch daily trade usage');
    return res.json();
  },

  async getClosedTrades(filters: {
    from?: string;
    to?: string;
    symbol?: string;
    result?: 'all' | 'win' | 'loss';
    page?: number;
    limit?: number;
  } = {}): Promise<ClosedTradesResponse> {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value));
    });
    params.set('t', String(Date.now()));
    const res = await authFetch(`${API_BASE}/trades/closed?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to fetch closed Wealthsimple trades');
    const data = await res.json();
    return {
      ...data,
      trades: data.trades.map(normalizePosition)
    };
  },

  async getTradeReport(range = '30d'): Promise<TradeReportResponse> {
    const params = new URLSearchParams({ range, t: String(Date.now()) });
    const res = await authFetch(`${API_BASE}/trades/report?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to fetch trade report');
    const data = await res.json();
    return {
      ...data,
      recentOutcomes: data.recentOutcomes.map(normalizePosition)
    };
  },

  async getTradeAlerts(): Promise<TradeAlertsResponse> {
    const res = await authFetch(`${API_BASE}/trades/alerts?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch trade alerts');
    return res.json();
  },

  async closeWealthsimpleTrade(id: number, quantity?: number): Promise<Position> {
    const res = await authFetch(`${API_BASE}/trades/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ quantity }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to submit Wealthsimple close order');
    }
    return normalizePosition(await res.json());
  },

  async refreshWealthsimpleTradeOrderStatus(id: number): Promise<{ trade: Position; sync: any }> {
    const res = await authFetch(`${API_BASE}/trades/${id}/order-status`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to refresh Wealthsimple order status');
    }
    const data = await res.json();
    return { ...data, trade: normalizePosition(data.trade) };
  },

  async retryWealthsimpleClose(id: number, quantity?: number): Promise<Position> {
    const res = await authFetch(`${API_BASE}/trades/${id}/retry-close`, {
      method: 'POST',
      body: JSON.stringify({ quantity }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to retry Wealthsimple close order');
    }
    return normalizePosition(await res.json());
  },

  async getClosedPositions(page: number = 1, limit: number = 10): Promise<{ positions: Position[]; total: number; page: number; limit: number; totalPages: number }> {
    const res = await authFetch(`${API_BASE}/positions/history?page=${page}&limit=${limit}`);
    if (!res.ok) throw new Error('Failed to fetch closed positions');
    const data = await res.json();

    return {
      ...data,
      positions: data.positions.map((pos: any) => ({
        ...pos,
        strike_price: Number(pos.strike_price),
        entry_price: Number(pos.entry_price),
        stop_loss_trigger: pos.stop_loss_trigger != null ? Number(pos.stop_loss_trigger) : undefined,
        take_profit_trigger: pos.take_profit_trigger != null ? Number(pos.take_profit_trigger) : undefined,
        trailing_high_price: pos.trailing_high_price != null ? Number(pos.trailing_high_price) : undefined,
        current_price: pos.current_price != null ? Number(pos.current_price) : undefined,
        realized_pnl: pos.realized_pnl != null ? Number(pos.realized_pnl) : undefined,
        loss_avoided: pos.loss_avoided != null ? Number(pos.loss_avoided) : undefined,
        delta: pos.delta != null ? Number(pos.delta) : undefined,
        theta: pos.theta != null ? Number(pos.theta) : undefined,
        gamma: pos.gamma != null ? Number(pos.gamma) : undefined,
        vega: pos.vega != null ? Number(pos.vega) : undefined,
        iv: pos.iv != null ? Number(pos.iv) : undefined,
        underlying_price: pos.underlying_price != null ? Number(pos.underlying_price) : undefined,
        analyzed_support: pos.analyzed_support != null ? Number(pos.analyzed_support) : undefined,
        analyzed_resistance: pos.analyzed_resistance != null ? Number(pos.analyzed_resistance) : undefined,
        suggested_stop_loss: pos.suggested_stop_loss != null ? Number(pos.suggested_stop_loss) : undefined,
        suggested_take_profit_1: pos.suggested_take_profit_1 != null ? Number(pos.suggested_take_profit_1) : undefined,
        suggested_take_profit_2: pos.suggested_take_profit_2 != null ? Number(pos.suggested_take_profit_2) : undefined,
        contracts_requested: pos.contracts_requested != null ? Number(pos.contracts_requested) : undefined,
        analysis_data: pos.analysis_data || undefined,
      }))
    };
  },

  async getPositionUpdates(): Promise<Record<number, Partial<Position>>> {
    const res = await authFetch(`${API_BASE}/positions/updates?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch position updates');
    const data = await res.json();
    const result: Record<number, Partial<Position>> = {};

    for (const [key, val] of Object.entries(data)) {
      const id = Number(key);
      const p = val as any; // Cast to any to access raw fields
      result[id] = {
        ...p,
        current_price: p.current_price != null ? Number(p.current_price) : undefined,
        stop_loss_trigger: p.stop_loss_trigger != null ? Number(p.stop_loss_trigger) : undefined,
        take_profit_trigger: p.take_profit_trigger != null ? Number(p.take_profit_trigger) : undefined,
        trailing_high_price: p.trailing_high_price != null ? Number(p.trailing_high_price) : undefined,
        trailing_stop_loss_pct: p.trailing_stop_loss_pct != null ? Number(p.trailing_stop_loss_pct) : undefined,
        realized_pnl: p.realized_pnl != null ? Number(p.realized_pnl) : undefined,
        loss_avoided: p.loss_avoided != null ? Number(p.loss_avoided) : undefined,
        delta: p.delta != null ? Number(p.delta) : undefined,
        theta: p.theta != null ? Number(p.theta) : undefined,
        gamma: p.gamma != null ? Number(p.gamma) : undefined,
        vega: p.vega != null ? Number(p.vega) : undefined,
        iv: p.iv != null ? Number(p.iv) : undefined,
        underlying_price: p.underlying_price != null ? Number(p.underlying_price) : undefined,
      };
    }
    return result;
  },

  async searchSymbols(q: string): Promise<{ symbol: string, name: string }[]> {
    const res = await authFetch(`${API_BASE}/positions/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error('Failed to search symbols');
    return res.json();
  },

  async searchCoveredCallSymbols(q: string): Promise<CoveredCallSymbolResult[]> {
    const res = await authFetch(`${API_BASE}/covered-calls/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error('Failed to search covered call symbols');
    return res.json();
  },

  async analyzeCoveredCalls(symbol: string): Promise<CoveredCallAnalysis> {
    const res = await authFetch(`${API_BASE}/covered-calls/analyze`, {
      method: 'POST',
      body: JSON.stringify({ symbol, profile: 'conservative' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to analyze covered calls');
    }
    return res.json();
  },

  async getPositionHistory(id: number): Promise<{ price: number, recorded_at: string }[]> {
    const res = await authFetch(`${API_BASE}/positions/${id}/history`);
    if (!res.ok) throw new Error('Failed to fetch position history');
    const data = await res.json();
    return data.map((d: any) => ({
      price: Number(d.price),
      recorded_at: d.recorded_at
    }));
  },

  async createPosition(data: Partial<Position>): Promise<Position> {
    const res = await authFetch(`${API_BASE}/positions`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create position');
    return res.json();
  },

  async closePosition(id: number, price?: number, quantity?: number): Promise<Position> {
    const res = await authFetch(`${API_BASE}/positions/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ price, quantity }),
    });
    if (!res.ok) throw new Error('Failed to close position');
    return res.json();
  },

  async getPortfolioStats(): Promise<{
    totalTrades: number;
    closedTrades: number;
    winRate: number;
    profitFactor: number;
    totalRealizedPnl: number;
    equityCurve: Array<{ date: string, pnl: number }>;
  }> {
    const res = await authFetch(`${API_BASE}/positions/stats`);
    if (!res.ok) throw new Error('Failed to fetch portfolio stats');
    return res.json();
  },

  async reopenPosition(id: number): Promise<Position> {
    const res = await authFetch(`${API_BASE}/positions/${id}/reopen`, {
      method: 'PATCH',
    });
    if (!res.ok) throw new Error('Failed to reopen position');
    return res.json();
  },

  async updatePosition(id: number, data: Partial<Position>): Promise<Position> {
    const res = await authFetch(`${API_BASE}/positions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update position');
    return res.json();
  },

  async deletePosition(id: number): Promise<void> {
    const res = await authFetch(`${API_BASE}/positions/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete position');
  },

  async bulkDeletePositions(ids: number[]): Promise<void> {
    const res = await authFetch(`${API_BASE}/positions/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error('Failed to bulk delete positions');
  },

  async getMarketStatus(): Promise<{ open: boolean; marketHours: string; timezone: string }> {
    const response = await authFetch(`${API_BASE}/market/status`);
    if (!response.ok) throw new Error('Failed to fetch market status');
    return response.json();
  },

  async syncPosition(id: number): Promise<void> {
    const res = await authFetch(`${API_BASE}/positions/${id}/sync`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to sync position data');
  },

  async forcePoll(): Promise<void> {
    const res = await authFetch(`${API_BASE}/market/force-poll`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to force sync market data');
  },

  async analyzePosition(positionId: number): Promise<{ analysis: string; verdict: string }> {
    const res = await authFetch(`${API_BASE}/ai/analyze`, {
      method: 'POST',
      body: JSON.stringify({ positionId })
    });
    if (!res.ok) throw new Error('Failed to analyze position');
    return res.json();
  },

  async getPortfolioBriefing(): Promise<{ briefing: string; discord_message: string }> {
    const res = await authFetch(`${API_BASE}/ai/briefing`);
    if (!res.ok) throw new Error('Failed to fetch portfolio briefing');
    return res.json();
  },

  async getSettings(): Promise<Record<string, string>> {
    const res = await authFetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
  },

  async getManualEntrySettings(): Promise<ManualEntrySettings> {
    const res = await authFetch(`${API_BASE}/manual-entry/settings`);
    if (!res.ok) throw new Error('Failed to fetch manual entry settings');
    return res.json();
  },

  async updateManualEntrySettings(settings: ManualEntrySettings): Promise<ManualEntrySettings> {
    const res = await authFetch(`${API_BASE}/manual-entry/settings`, {
      method: 'POST',
      body: JSON.stringify(settings)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update manual entry settings');
    }
    return res.json();
  },

  async getManualEntryChain(params: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    dte: 0 | 1 | 2;
  }): Promise<ManualEntryChain> {
    const query = new URLSearchParams({
      symbol: params.symbol,
      optionType: params.optionType,
      dte: String(params.dte),
      t: String(Date.now())
    });
    const res = await authFetch(`${API_BASE}/manual-entry/chain?${query.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch manual entry chain');
    }
    return res.json();
  },

  async getManualEntryQuote(params: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strike: number;
    expiration: string;
  }): Promise<ManualEntryQuote> {
    const query = new URLSearchParams({
      symbol: params.symbol,
      optionType: params.optionType,
      strike: String(params.strike),
      expiration: params.expiration,
      t: String(Date.now())
    });
    const res = await authFetch(`${API_BASE}/manual-entry/quote?${query.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch manual entry quote');
    }
    return res.json();
  },

  async submitManualEntryOrder(payload: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strike: number;
    expiration: string;
    quantity: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number | null;
    underlyingStopPrice?: number | null;
  }): Promise<any> {
    const res = await authFetch(`${API_BASE}/manual-entry/orders`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to submit manual entry order');
    }
    return res.json();
  },

  async trimManualEntryPosition(id: number, quantity?: number): Promise<Position> {
    const res = await authFetch(`${API_BASE}/manual-entry/positions/${id}/trim`, {
      method: 'POST',
      body: JSON.stringify({ quantity })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to submit manual entry trim order');
    }
    return normalizePosition(await res.json());
  },

  async updateSettings(settings: Record<string, string>): Promise<void> {
    const res = await authFetch(`${API_BASE}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Failed to update settings');
  },

  async getRuntimeConfig(): Promise<RuntimeConfigResponse> {
    const res = await authFetch(`${API_BASE}/settings/runtime-config`);
    if (!res.ok) throw new Error('Failed to fetch runtime config');
    return res.json();
  },

  async runSignalReplay(payload: SignalReplayRequest): Promise<SignalReplayResponse> {
    const res = await authFetch(`${API_BASE}/backtests/signal-replay`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || error.error || 'Signal replay failed');
    }
    return res.json();
  },

  async testDiscordWebhook(webhookUrl: string): Promise<void> {
    const res = await authFetch(`${API_BASE}/settings/test-discord`, {
      method: 'POST',
      body: JSON.stringify({ webhookUrl })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to test Discord webhook');
    }
  },

  // ─── Goals ───
  async getGoals(): Promise<Goal[]> {
    const res = await authFetch(`${API_BASE}/goals`);
    if (!res.ok) throw new Error('Failed to fetch goals');
    return res.json();
  },

  async createGoal(data: { name: string; target_amount: number; start_date: string; end_date: string }): Promise<Goal> {
    const res = await authFetch(`${API_BASE}/goals`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to create goal');
    return res.json();
  },

  async updateGoal(id: number, data: Partial<{ name: string; target_amount: number; start_date: string; end_date: string }>): Promise<Goal> {
    const res = await authFetch(`${API_BASE}/goals/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to update goal');
    return res.json();
  },

  async deleteGoal(id: number): Promise<void> {
    const res = await authFetch(`${API_BASE}/goals/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete goal');
  },

  async getGoalEntries(goalId: number): Promise<GoalEntry[]> {
    const res = await authFetch(`${API_BASE}/goals/${goalId}/entries`);
    if (!res.ok) throw new Error('Failed to fetch goal entries');
    return res.json();
  },

  async addGoalEntry(goalId: number, data: { entry_date: string; amount: number; notes?: string }): Promise<GoalEntry> {
    const res = await authFetch(`${API_BASE}/goals/${goalId}/entries`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add entry');
    }
    return res.json();
  },

  async updateGoalEntry(goalId: number, entryId: number, data: Partial<{ entry_date: string; amount: number; notes: string }>): Promise<GoalEntry> {
    const res = await authFetch(`${API_BASE}/goals/${goalId}/entries/${entryId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to update entry');
    return res.json();
  },

  async deleteGoalEntry(goalId: number, entryId: number): Promise<void> {
    const res = await authFetch(`${API_BASE}/goals/${goalId}/entries/${entryId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete entry');
  },

  async getGoalInsights(goalId: number): Promise<GoalInsights> {
    const res = await authFetch(`${API_BASE}/goals/${goalId}/insights`);
    if (!res.ok) throw new Error('Failed to fetch goal insights');
    return res.json();
  },

  // ─── Snaptrade ───
  async connectSnaptrade(): Promise<{ redirectURI: string }> {
    const res = await authFetch(`${API_BASE}/snaptrade/connect`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to generate Wealthsimple connection URL');
    }
    return res.json();
  },

  async getSnaptradeConnections(): Promise<any> {
    const res = await authFetch(`${API_BASE}/snaptrade/connections`);
    if (!res.ok) throw new Error('Failed to fetch Wealthsimple connection status');
    return res.json();
  },

  async resetSnaptradeReadOnlyConnections(): Promise<any> {
    const res = await authFetch(`${API_BASE}/snaptrade/reset-readonly-connections`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to reset read-only Wealthsimple connection');
    }
    return res.json();
  },

  async syncSnaptradePortfolio(): Promise<{ success: boolean; syncedAccounts: number }> {
    const res = await authFetch(`${API_BASE}/snaptrade/sync`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to sync Wealthsimple portfolio');
    return res.json();
  },

  async syncSnaptradePendingOrders(): Promise<any> {
    const res = await authFetch(`${API_BASE}/snaptrade/sync-pending-orders`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to sync Wealthsimple pending orders');
    }
    return res.json();
  },

  async placeSnaptradeDevOptionOrder(payload: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strike: string;
    expiration: string;
    quantity: string;
    orderType: 'LIMIT' | 'MARKET';
    limitPrice: string;
    mark: string;
    confirmation: string;
  }): Promise<any> {
    const res = await authFetch(`${API_BASE}/snaptrade/dev/place-option-order`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to place Wealthsimple test option order');
    }
    return res.json();
  },

  async getSnaptradePortfolio(): Promise<{ accounts: any[]; positions: any[] }> {
    const res = await authFetch(`${API_BASE}/snaptrade/portfolio`);
    if (!res.ok) throw new Error('Failed to fetch Wealthsimple portfolio');
    return res.json();
  },

  async getSnaptradeBriefing(refresh = false): Promise<{ briefing: any; lastReviewedAt: string | null }> {
    const res = await authFetch(`${API_BASE}/snaptrade/briefing${refresh ? '?refresh=true' : ''}`);
    if (!res.ok) throw new Error('Failed to generate Wealthsimple AI briefing');
    return res.json();
  },

  // --- Day Trading Signals ---
  async getSignalsHealth(): Promise<{
    yahooFinance: AdapterHealth & { endpoint?: string; checkedAt?: string };
    ibkr: AdapterHealth & { endpoint?: string; checkedAt?: string };
    openRouter: AdapterHealth & { endpoint?: string; checkedAt?: string };
    discord: AdapterHealth & { endpoint?: string; checkedAt?: string };
  }> {
    const res = await authFetch(`${API_BASE}/signals/health`);
    if (!res.ok) throw new Error('Failed to fetch day trading API health');
    return res.json();
  },

  async getServicesHealth(): Promise<{
    liveExitMonitor: AdapterHealth & {
      status: string;
      active: boolean;
      provider: string;
      quotesProcessed: number;
      matchedUpdates: number;
      lastQuoteAt: string | null;
      lastMatchedAt: string | null;
      lastError: string | null;
    };
    optionHistoryCapture?: AdapterHealth & {
      status: string;
      capturedQuotes: number;
      persistedQuotes: number;
      pendingQuotes: number;
      lastCapturedAt: string | null;
      lastPersistedAt: string | null;
      lastError: string | null;
    };
    streams: {
      ibkr: AdapterHealth & {
        status: string;
        connected: boolean;
        provider: string;
        mode?: 'live' | 'paper';
        host?: string;
        port?: number;
        marketDataType?: number;
        activeSubscriptions: number;
        lastMessageAt: string | null;
        lastError: string | null;
        reconnectAttempts: number;
      };
    };
    marketData?: {
      ibkr?: AdapterHealth & {
        status: string;
        connected: boolean;
        provider: string;
        mode?: 'live' | 'paper';
        host?: string;
        port?: number;
        marketDataType?: number;
        latencyMs: number | null;
        lastError: string | null;
      };
    };
    poller: AdapterHealth & { status: string; running: boolean };
    strategyEngine?: AdapterHealth & {
      status: string;
      mode: 'legacy' | 'shadow' | 'primary';
      connected: boolean;
      providerFreshnessMs: number | null;
      lastSeen: string | null;
      lastError: string | null;
      transport?: {
        redis: 'DISABLED' | 'CONNECTING' | 'UP' | 'DEGRADED';
        lastRedisEventAt: string | null;
        filePollFallback: boolean;
      };
    };
    scanner: AdapterHealth & {
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
    snaptradePendingOrders?: AdapterHealth & {
      status: string;
      running: boolean;
      lastRunAt: string | null;
      lastResult: any;
      lastWatchdogResult?: any;
      lastError: string | null;
      intervalSeconds: number;
      redisRehydratedAt?: string | null;
      redisRehydratedUsers?: number;
      queuedSyncLastRunAt?: string | null;
      queuedSyncProcessed?: number;
    };
    tradeRedis?: AdapterHealth & {
      status: string;
      connected: boolean;
      queueDepth: number | null;
      metrics: Record<string, number>;
      generatedAt?: string | null;
    };
    postgres?: AdapterHealth;
    generatedAt: string;
  }> {
    const res = await authFetch(`${API_BASE}/services/health`);
    if (!res.ok) throw new Error('Failed to fetch runtime service health');
    return res.json();
  },

  async injectDevQuote(payload: {
    provider: string;
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strike: string;
    expiration: string;
    bid: string;
    ask: string;
    last: string;
    underlyingPrice: string;
  }): Promise<any> {
    const res = await authFetch(`${API_BASE}/services/dev/quote`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to inject dev quote');
    }
    return res.json();
  },

  async triggerScan(): Promise<{ success: boolean; message: string }> {
    const res = await authFetch(`${API_BASE}/signals/trigger`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to trigger scan');
    return res.json();
  },

  async getLiveMacroMetrics(): Promise<LiveMacroMetrics> {
    const res = await authFetch(`${API_BASE}/signals/macro?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch live macro metrics');
    return res.json();
  },

  async getSignals(): Promise<Signal[]> {
    const res = await authFetch(`${API_BASE}/signals?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch signals');
    const data = await res.json();
    return data.map((sig: any) => ({
      ...sig,
      current_price: Number(sig.current_price),
      entry_trigger: sig.entry_trigger != null ? Number(sig.entry_trigger) : undefined,
      stop_loss: sig.stop_loss != null ? Number(sig.stop_loss) : undefined,
      target_price: sig.target_price != null ? Number(sig.target_price) : undefined,
      confidence_score: Number(sig.confidence_score),
      contracts_requested: sig.contracts_requested != null ? Number(sig.contracts_requested) : null,
    }));
  },

  async getStrategyState(): Promise<StrategyEngineState> {
    const res = await authFetch(`${API_BASE}/signals/strategy-state?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch strategy state');
    return res.json();
  },

  async getStrategyHistory(): Promise<StrategyHistorySetup[]> {
    const res = await authFetch(`${API_BASE}/signals/strategy-history?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch strategy setup history');
    const rows = await res.json();
    return rows.map((row: any) => ({
      ...row,
      spot: row.spot == null ? null : Number(row.spot),
      entry_trigger: row.entry_trigger == null ? null : Number(row.entry_trigger),
      invalidation: row.invalidation == null ? null : Number(row.invalidation),
      target: row.target == null ? null : Number(row.target),
      confidence_score: Number(row.confidence_score || 0),
      contracts_requested: row.contracts_requested == null ? null : Number(row.contracts_requested),
      position_id: row.position_id == null ? null : Number(row.position_id),
      entry_price: row.entry_price == null ? null : Number(row.entry_price),
      position_current_price: row.position_current_price == null ? null : Number(row.position_current_price),
      exit_price: row.exit_price == null ? null : Number(row.exit_price),
      realized_pnl: row.realized_pnl == null ? null : Number(row.realized_pnl),
      quantity: row.quantity == null ? null : Number(row.quantity),
      lifecycle_events: Array.isArray(row.lifecycle_events) ? row.lifecycle_events : []
    }));
  },

  async getSignalRiskAssessment(id: number): Promise<SignalRiskAssessment> {
    const res = await authFetch(`${API_BASE}/signals/${id}/risk-assessment`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || err.message || `AI risk assessment failed (${res.status})`);
    }
    return res.json();
  },

  async updateSignalStatus(id: number, status: 'PENDING' | 'EXECUTED' | 'CANCELLED'): Promise<{
    id: number;
    status: string;
    execution_status?: string | null;
    execution_broker?: string | null;
    broker_order_id?: string | null;
    broker_trade_id?: string | null;
    quantity?: number | null;
  }> {
    const res = await authFetch(`${API_BASE}/signals/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update signal status');
    }
    return res.json();
  },

  async clearSignals(): Promise<{ success: boolean; message: string }> {
    const res = await authFetch(`${API_BASE}/signals`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to clear signals');
    return res.json();
  },

  async seedSignals(): Promise<{ success: boolean; insertedCount: number }> {
    const res = await authFetch(`${API_BASE}/signals/seed`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to seed signals');
    return res.json();
  },

  async getScannerLogs(): Promise<ScannerLog[]> {
    const res = await authFetch(`${API_BASE}/signals/logs?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch scanner logs');
    const data = await res.json();
    return data.map((log: any) => ({
      ...log,
      spot_price: Number(log.spot_price),
      vix: log.vix != null ? Number(log.vix) : null
    }));
  }
};

export interface IndicatorsJSON {
  vwap?: number;
  openingRangeHigh?: number;
  openingRangeLow?: number;
  atr14?: number;
  ema9?: number;
  ema21?: number;
  [key: string]: any;
}

export interface GexJSON {
  netGex?: number;
  regime?: string;
  flipStrike?: number;
  callWall?: number;
  putWall?: number;
  kingNode?: number;
  flowDirection?: string;
  [key: string]: any;
}

export interface VolatilityJSON {
  vixQuote?: number;
  vixChangePercent?: number;
  tenYearYield?: number;
  tenYearChangePercent?: number;
  tenYearChangeBps?: number;
  dxy?: {
    symbol?: string;
    value?: number;
    changePercent?: number;
  };
  oil?: {
    symbol?: string;
    value?: number;
    changePercent?: number;
  };
  gold?: {
    symbol?: string;
    value?: number;
    changePercent?: number;
  };
  macroRegime?: {
    regime?: string;
    score?: number;
    directionBias?: string;
    confidenceAdjustment?: number;
    thresholdAdjustment?: number;
    blockers?: string[];
    warnings?: string[];
    contributors?: string[];
  };
  [key: string]: any;
}

export interface LiveMacroMetrics extends VolatilityJSON {
  generatedAt: string;
  assets?: {
    vix?: any;
    tenYear?: any;
    dxy?: any;
    oil?: any;
    gold?: any;
  };
  assessments?: {
    CALL?: VolatilityJSON['macroRegime'];
    PUT?: VolatilityJSON['macroRegime'];
  };
}

export interface OptionDetailsJSON {
  ticker?: string;
  side?: 'CALL' | 'PUT';
  strike?: number;
  expiry?: string;
  bid?: number;
  ask?: number;
  spread?: number;
  spreadPct?: number;
  mark?: number;
  volume?: number;
  openInterest?: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  usingTheoreticalPricing?: boolean;
  planned_contracts?: number;
  planned_limit_price?: number;
  planned_total_debit?: number;
  strategy_max_total_debit_dollars?: number;
  targets?: number[];
  exit_target_number?: number;
  setupId?: string;
  gradeDiagnostics?: {
    baseScore: number;
    macroScore: number;
    macroConfidenceAdjustment: number;
    pricingPenalty: number;
    finalConfidence: number;
    setupGrade: string;
    gradeKey: 'A+' | 'A' | 'B' | 'UNKNOWN';
    executable: boolean;
    thresholds: {
      standard: number;
      full: number;
      fullMacro: number;
    };
    reasons: string[];
    warnings: string[];
    blockers: string[];
    pricingWarnings: string[];
  };
  decision?: {
    signalId?: number;
    symbol: string;
    side: 'CALL' | 'PUT';
    createdAt: string;
    contract: {
      ticker: string | null;
      strike: number | null;
      expiry: string | null;
    };
    quote: {
      mark: number | null;
      bid: number | null;
      ask: number | null;
      spreadPct: number | null;
      volume: number | null;
      openInterest: number | null;
      usingTheoreticalPricing: boolean;
    };
    grade: OptionDetailsJSON['gradeDiagnostics'];
  };
  [key: string]: any;
}

export interface Signal {
  id: number;
  symbol: string;
  signal_type: 'CALL' | 'PUT' | 'NONE';
  trade_bias: string;
  current_price: number;
  entry_trigger?: number;
  stop_loss?: number;
  target_price?: number;
  confidence_score: number;
  setup_grade?: string;
  status: 'PENDING' | 'EXECUTED' | 'CANCELLED';
  indicators?: IndicatorsJSON;
  gex?: GexJSON;
  volatility?: VolatilityJSON;
  no_trade_reasons?: string[];
  option_expiration_date?: string;
  market_date?: string;
  created_at: string;
  execution_broker?: string | null;
  broker_order_id?: string | null;
  broker_trade_id?: string | null;
  execution_status?: string | null;
  execution_error?: string | null;
  contracts_requested?: number | null;
  news_context?: string | null;
  ai_coach_commentary?: string | null;
  ml_probability?: number | null;
  option_details?: OptionDetailsJSON;
  token_usage?: {
    classifier?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
    coach?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  } | null;
  engine_version?: string | null;
  strategy_name?: string | null;
  strategy_setup_id?: string | null;
  lifecycle_status?: string | null;
  entry_allowed?: boolean;
  activated_at?: string | null;
  policy_fingerprint?: string | null;
  strategy_snapshot?: Record<string, any> | null;
}

export interface SignalRiskAssessment {
  verdict: 'ALIGNED' | 'MIXED' | 'CONFLICTED' | 'WAIT';
  summary: string;
  likelyPath: string;
  ifRight: string;
  ifWrong: string;
  action: string;
  gexRead: string;
  supportingFactors: string[];
  riskFlags: string[];
  maxPlannedLoss: number | null;
  generatedAt: string;
}

export interface StrategyLifecycleEvent {
  id: number;
  status: string;
  state?: string | null;
  phase?: string | null;
  entryAllowed: boolean;
  targetsHit: number;
  closeReason?: string | null;
  blockers: string[];
  createdAt: string;
}

export interface StrategyHistorySetup {
  id: number;
  setup_id: string;
  side: 'CALL' | 'PUT';
  strategy_name?: string | null;
  lifecycle_status: string;
  signal_status: string;
  spot?: number | null;
  entry_trigger?: number | null;
  invalidation?: number | null;
  target?: number | null;
  confidence_score: number;
  option_details?: OptionDetailsJSON | null;
  no_trade_reasons?: string[] | null;
  created_at: string;
  activated_at?: string | null;
  user_execution_status?: string | null;
  execution_broker?: string | null;
  execution_status?: string | null;
  execution_error?: string | null;
  contracts_requested?: number | null;
  position_id?: number | null;
  position_status?: string | null;
  entry_price?: number | null;
  position_current_price?: number | null;
  exit_price?: number | null;
  realized_pnl?: number | null;
  quantity?: number | null;
  expiration_date?: string | null;
  position_created_at?: string | null;
  position_updated_at?: string | null;
  lifecycle_events: StrategyLifecycleEvent[];
}

export interface StrategyEngineState {
  mode: 'legacy' | 'shadow' | 'primary';
  setupId: string | null;
  receivedAt: string | null;
  ageSeconds: number | null;
  error: string | null;
  health: Record<string, any> | null;
  signal: Record<string, any> | null;
  transport?: {
    redis: 'DISABLED' | 'CONNECTING' | 'UP' | 'DEGRADED';
    lastRedisEventAt: string | null;
    filePollFallback: boolean;
  };
}

export interface ScannerLog {
  id: number;
  symbol: string;
  spot_price: number;
  regime: string;
  vix?: number | null;
  gex_available: boolean;
  indicators?: IndicatorsJSON;
  outcome: 'SIGNAL_GENERATED' | 'BLOCKED';
  no_trade_reasons?: string[];
  created_at: string;
}

export interface Goal {
  id: number;
  user_id: number;
  name: string;
  target_amount: number;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at: string;
}

export interface GoalEntry {
  id: number;
  goal_id: number;
  entry_date: string;
  amount: number;
  notes?: string;
  created_at: string;
}

export interface GoalInsights {
  goalId: number;
  goalName: string;
  targetAmount: number;
  totalEarned: number;
  percentComplete: number;
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
  dailyAverage: number;
  projectedTotal: number;
  remainingPerDay: number;
  expectedPercent: number;
  progressDelta: number;
  status: 'COMPLETED' | 'AHEAD' | 'ON_TRACK' | 'AT_RISK' | 'BEHIND';
  // Streak
  currentStreak: number;
  longestStreak: number;
  // Win Rate
  totalEntries: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
}
