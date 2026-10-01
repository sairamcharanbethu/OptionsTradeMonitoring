/**
 * Swing (9-10 DTE SPY) exit policy — the TypeScript mirror of
 * `shared/swing-exit-policy.json`.
 *
 * The JSON is the contract; this file is hand-mirrored because the runtime
 * image does not ship `shared/`. `swing-exit-policy.test.ts` deep-equals the
 * two, and `strategy-engine/test_swing_exit_policy.py` does the same for the
 * Python mirror, so live code, paper code and the backtest cannot drift apart
 * silently. Edit the JSON first, then both mirrors.
 */
export const SWING_EXIT_POLICY = {
  version: 1,
  /** Strict primary expiry window in calendar days. */
  minDte: 9,
  maxDte: 10,
  /** Exit-before-expiry: never hold into <= this many calendar DTE. */
  exitBeforeExpiryDte: 2,
  /** Time stop from entry (7 days). 0 disables. */
  maxHoldMinutes: 10080,
  /** Premium stop below entry until the trail arms, in percent. */
  premiumStopPct: 20,
  /** Synthetic trailing stop below the premium peak once armed, in percent. */
  trailPct: 15,
  /** Profit-lock ladder: peak >= entry*trigger -> floor = entry; peak >= entry*rung2 -> floor = entry*rung2Floor. */
  profitLock: {
    triggerMult: 1.2,
    rung2Mult: 1.5,
    rung2FloorMult: 1.25
  },
  /** Engine-side T1 premium lock (paper tracking): arms at +armPct, closes back at +floorPct. */
  t1PremiumLock: {
    armPct: 20,
    floorPct: 10
  },
  /** Default per-trade total debit cap in dollars (settings override). */
  maxTotalDebitDollars: 500
} as const;

export type SwingExitPolicy = typeof SWING_EXIT_POLICY;

/**
 * Premium stop percent for a strategy entry: the engine's `paper_policy.premium_stop_pct`
 * when it carries a sane value, else the policy default. Shared by the live
 * execution path and both paper entry paths so they cannot disagree.
 */
export function resolvePremiumStopPct(signalOrSnapshot: any): number {
  const configured = Number(signalOrSnapshot?.paper_policy?.premium_stop_pct);
  return Number.isFinite(configured) && configured > 0 && configured < 100
    ? configured
    : SWING_EXIT_POLICY.premiumStopPct;
}

/** Trailing-stop multiplier (e.g. 0.85 for a 15% trail). */
export const SWING_TRAIL_MULT = 1 - SWING_EXIT_POLICY.trailPct / 100;

/** Max hold expressed in days, for code that measures hold time in days. */
export const SWING_MAX_HOLD_DAYS = SWING_EXIT_POLICY.maxHoldMinutes / (24 * 60);
