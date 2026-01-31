export interface User {
  id: number;
  username: string;
  role: 'USER' | 'ADMIN';
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
  status: 'OPEN' | 'CLOSED' | 'STOP_TRIGGERED' | 'PROFIT_TRIGGERED';
  created_at: string;
  updated_at: string;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  iv?: number;

  underlying_price?: number;
  analyzed_support?: number;
  analyzed_resistance?: number;
  suggested_stop_loss?: number;
  suggested_take_profit_1?: number;
  suggested_take_profit_2?: number;
  analysis_data?: any;
}

const API_BASE = '/api';

const getToken = () => localStorage.getItem('token');

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

export const api = {
  // Auth
  async signup(data: any): Promise<{ token: string, user: User }> {
    const res = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Signup failed');
    }
    const result = await res.json();
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
      const err = await res.json();
      throw new Error(err.error || 'Signin failed');
    }
    const result = await res.json();
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

  // Live Analysis
  async getLiveCandles(symbol: string): Promise<{ symbol: string; symbolId: number; interval: string; candles: any[] }> {
    const res = await authFetch(`${API_BASE}/live-analysis/candles/${encodeURIComponent(symbol)}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch candles');
    }
    return res.json();
  },

  async searchLiveSymbols(query: string): Promise<{ results: any[] }> {
    const res = await authFetch(`${API_BASE}/live-analysis/search/${encodeURIComponent(query)}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Search failed');
    }
    return res.json();
  },

  async subscribeLiveAnalysis(symbol: string): Promise<{ success: boolean; symbol: string; symbolId: number }> {
    const res = await authFetch(`${API_BASE}/live-analysis/subscribe/${encodeURIComponent(symbol)}`, {
      method: 'POST'
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Subscription failed');
    }
    return res.json();
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

    return data.map((pos: any) => ({
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
      analysis_data: pos.analysis_data || undefined,
    }));
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

  async predictStock(symbol: string): Promise<any> {
    const res = await authFetch(`${API_BASE}/ai/predict/${symbol}`);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || 'Failed to fetch prediction');
    }
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

  // Questrade Integration
  async getQuestradeConfig(): Promise<any> {
    const res = await authFetch(`${API_BASE}/settings/questrade/config`);
    if (!res.ok) throw new Error('Failed to fetch Questrade config');
    return res.json();
  },
  async saveQuestradeClient(clientId: string): Promise<void> {
    const res = await authFetch(`${API_BASE}/settings/questrade/client`, {
      method: 'POST',
      body: JSON.stringify({ clientId })
    });
    if (!res.ok) throw new Error('Failed to save Questrade client ID');
  },
  async saveQuestradeToken(data: any): Promise<void> {
    const res = await authFetch(`${API_BASE}/settings/questrade/token`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to save Questrade token');
  },

  async updateSettings(settings: Record<string, string>): Promise<void> {
    const res = await authFetch(`${API_BASE}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Failed to update settings');
  }
};

