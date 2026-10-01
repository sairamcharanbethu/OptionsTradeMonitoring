/**
 * Swing backtest benchmark — TypeScript mirror of `shared/swing-expectations.json`
 * (the runtime image does not ship `shared/`; the parity test keeps them equal).
 *
 * Modelled premiums over the frozen UW cache, 2026-04-14 to 2026-08-21. It is
 * the reference the weekly parity report compares paper lanes against. It is
 * NOT a target and is never updated by live data; regenerate it by re-running
 * `uw_swing_backtest.py` and editing both files.
 */
export const SWING_EXPECTATIONS = {
  generatedAt: '2026-10-01',
  source: 'uw_swing_backtest.py',
  window: { start: '2026-04-14', end: '2026-08-21', sessions: 91 },
  premiumModel: 'black-scholes, prior-close ATM IV per session, ask-buy/bid-sell modelled spread',
  trades: 78,
  wins: 20,
  winRate: 0.2564,
  totalPnl: -324.34,
  avgPnlPerTrade: -4.16,
  profitFactor: 0.83,
  medianHoldHours: 0.2,
  maxHoldHours: 22.6,
  byStrategy: {
    CONTINUATION: { trades: 65, wins: 15, totalPnl: -417.07 },
    GEX_WALL_BREAK_FAIL: { trades: 13, wins: 5, totalPnl: 92.73 }
  },
  exitMix: {
    TARGET_2: 19,
    GAP_STOP: 1,
    T1_TRAIL_STOP: 2,
    TRAIL_STOP: 14,
    PREMIUM_STOP: 3,
    STOP: 39
  },
  underlyingDeltaOne: { greenRate: 0.3846, meanPointsPerTrade: -0.13, sePoints: 0.13, profitFactor: 0.74 }
} as const;

export type SwingExpectations = typeof SWING_EXPECTATIONS;
