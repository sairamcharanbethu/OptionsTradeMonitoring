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
}

const API_BASE = '/api';

export const api = {
  async getPositions(): Promise<Position[]> {
    const res = await fetch(`${API_BASE}/positions?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to fetch positions');
    const data = await res.json();

    // PostgreSQL returns DECIMAL as strings. Convert to numbers.
    return data.map((pos: any) => ({
      ...pos,
      strike_price: Number(pos.strike_price),
      entry_price: Number(pos.entry_price),
      stop_loss_trigger: pos.stop_loss_trigger ? Number(pos.stop_loss_trigger) : undefined,
      take_profit_trigger: pos.take_profit_trigger ? Number(pos.take_profit_trigger) : undefined,
      trailing_high_price: pos.trailing_high_price ? Number(pos.trailing_high_price) : undefined,
      current_price: pos.current_price ? Number(pos.current_price) : undefined,
      realized_pnl: pos.realized_pnl ? Number(pos.realized_pnl) : undefined,
      loss_avoided: pos.loss_avoided ? Number(pos.loss_avoided) : undefined,
      delta: pos.delta ? Number(pos.delta) : undefined,
      theta: pos.theta ? Number(pos.theta) : undefined,
      gamma: pos.gamma ? Number(pos.gamma) : undefined,
      vega: pos.vega ? Number(pos.vega) : undefined,
      iv: pos.iv ? Number(pos.iv) : undefined,
    }));
  },

  async searchSymbols(q: string): Promise<{ symbol: string, name: string }[]> {
    const res = await fetch(`${API_BASE}/positions/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error('Failed to search symbols');
    return res.json();
  },

  async getPositionHistory(id: number): Promise<{ price: number, recorded_at: string }[]> {
    const res = await fetch(`${API_BASE}/positions/${id}/history`);
    if (!res.ok) throw new Error('Failed to fetch position history');
    const data = await res.json();
    return data.map((d: any) => ({
      price: Number(d.price),
      recorded_at: d.recorded_at
    }));
  },

  async createPosition(data: Partial<Position>): Promise<Position> {
    const res = await fetch(`${API_BASE}/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create position');
    return res.json();
  },

  async closePosition(id: number, price?: number): Promise<Position> {
    const res = await fetch(`${API_BASE}/positions/${id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price }),
    });
    if (!res.ok) throw new Error('Failed to close position');
    return res.json();
  },

  async reopenPosition(id: number): Promise<Position> {
    const res = await fetch(`${API_BASE}/positions/${id}/reopen`, {
      method: 'PATCH',
    });
    if (!res.ok) throw new Error('Failed to reopen position');
    return res.json();
  },

  async updatePosition(id: number, data: Partial<Position>): Promise<Position> {
    const res = await fetch(`${API_BASE}/positions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update position');
    return res.json();
  },

  async deletePosition(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/positions/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete position');
  },

  async getMarketStatus(): Promise<{ open: boolean; marketHours: string; timezone: string }> {
    const response = await fetch(`${API_BASE}/market/status`);
    if (!response.ok) throw new Error('Failed to fetch market status');
    return response.json();
  },

  async forcePoll(): Promise<void> {
    const res = await fetch(`${API_BASE}/market/force-poll`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to force sync market data');
  },

  async analyzePosition(positionId: number): Promise<{ analysis: string; verdict: string }> {
    const res = await fetch(`${API_BASE}/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId })
    });
    if (!res.ok) throw new Error('Failed to analyze position');
    return res.json();
  },

  async getSettings(): Promise<Record<string, string>> {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
  },

  async updateSettings(settings: Record<string, string>): Promise<void> {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Failed to update settings');
  }
};
