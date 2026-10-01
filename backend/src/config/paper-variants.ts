import { SWING_EXIT_POLICY } from './swing-exit-policy';

/**
 * Parallel paper variant lanes for the swing system.
 *
 * One live slot holding up to seven days yields one or two trades a week, so
 * a hundred-trade sample takes a year. Paper has no such limit: every engine
 * setup is offered to each variant lane, each lane keeps its own ledger
 * (`paper_strategy` / `strategy_name`), and the weekly report compares them.
 * The baseline lane `SWING` runs the exact live rules; the others change ONE
 * thing each so a difference in results can be attributed.
 *
 * Exit parameters are frozen onto each position at entry
 * (`analysis_data.variant`) so a later edit here never changes how an open
 * position is managed.
 */
export type PaperVariant = {
  /** `paper_strategy` / `strategy_name` value; also the paper_strategy_controls key. */
  name: string;
  label: string;
  description: string;
  /** `inherit` = same AI gate as live; `off` = take every engine-ACTIVE setup. */
  aiGate: 'inherit' | 'off';
  premiumStopPct: number;
  trailPct: number;
  /** Apply the profit-lock ladder (StopLossEngine.profitLockFloor). */
  profitLock: boolean;
  exitBeforeExpiryDte: number;
  maxHoldMinutes: number;
};

const base = {
  aiGate: 'inherit' as const,
  premiumStopPct: SWING_EXIT_POLICY.premiumStopPct,
  trailPct: SWING_EXIT_POLICY.trailPct,
  profitLock: true,
  exitBeforeExpiryDte: SWING_EXIT_POLICY.exitBeforeExpiryDte,
  maxHoldMinutes: SWING_EXIT_POLICY.maxHoldMinutes
};

export const PAPER_SWING_BASELINE = 'SWING';

export const PAPER_SWING_VARIANTS: readonly PaperVariant[] = [
  { ...base, name: PAPER_SWING_BASELINE, label: 'Swing (live rules)', description: 'Exactly the live 9-10 DTE rules: AI gate, 20% premium stop, 15% trail, profit-lock ladder.' },
  { ...base, name: 'SWING_NOAI', label: 'Swing · AI gate off', description: 'Takes every engine-ACTIVE setup; measures what the AI gate adds or costs.', aiGate: 'off' },
  { ...base, name: 'SWING_WIDE_STOP', label: 'Swing · 30% stop', description: 'Premium stop 30% instead of 20%; tests whether the stop is too tight for 9-10 DTE theta/vol noise.', premiumStopPct: 30 },
  { ...base, name: 'SWING_TIGHT_STOP', label: 'Swing · 12% stop', description: 'Premium stop 12%; tests whether cutting losers faster improves expectancy.', premiumStopPct: 12 },
  { ...base, name: 'SWING_NO_LOCK', label: 'Swing · no profit lock', description: 'Trail arms only at the TP1 underlying target; no 1.2x/1.5x profit-lock ladder.', profitLock: false }
];

export const PAPER_SWING_VARIANT_NAMES: readonly string[] = PAPER_SWING_VARIANTS.map((v) => v.name);

export function isPaperSwingVariant(name: unknown): boolean {
  return PAPER_SWING_VARIANT_NAMES.includes(String(name || ''));
}

export function paperVariantByName(name: unknown): PaperVariant {
  return PAPER_SWING_VARIANTS.find((v) => v.name === String(name || '')) || PAPER_SWING_VARIANTS[0];
}

/** The exit parameters frozen onto a position at entry. */
export type FrozenVariantParams = Pick<PaperVariant, 'name' | 'premiumStopPct' | 'trailPct' | 'profitLock' | 'exitBeforeExpiryDte' | 'maxHoldMinutes'>;

export function freezeVariant(variant: PaperVariant): FrozenVariantParams {
  return {
    name: variant.name,
    premiumStopPct: variant.premiumStopPct,
    trailPct: variant.trailPct,
    profitLock: variant.profitLock,
    exitBeforeExpiryDte: variant.exitBeforeExpiryDte,
    maxHoldMinutes: variant.maxHoldMinutes
  };
}

/**
 * Exit parameters for an open position: the frozen copy in `analysis_data.variant`
 * when present (entries made after variants existed), else the variant's current
 * definition by lane name, else the baseline. Never throws.
 */
export function variantParamsForPosition(position: any): FrozenVariantParams {
  const analysis = typeof position?.analysis_data === 'string'
    ? (() => { try { return JSON.parse(position.analysis_data) || {}; } catch { return {}; } })()
    : (position?.analysis_data || {});
  const frozen = analysis?.variant;
  const fallback = freezeVariant(paperVariantByName(position?.paper_strategy));
  if (!frozen || typeof frozen !== 'object') return fallback;
  const num = (value: unknown, dflt: number) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : dflt);
  return {
    name: String(frozen.name || fallback.name),
    premiumStopPct: num(frozen.premiumStopPct, fallback.premiumStopPct),
    trailPct: num(frozen.trailPct, fallback.trailPct),
    profitLock: typeof frozen.profitLock === 'boolean' ? frozen.profitLock : fallback.profitLock,
    exitBeforeExpiryDte: num(frozen.exitBeforeExpiryDte, fallback.exitBeforeExpiryDte),
    maxHoldMinutes: Number.isFinite(Number(frozen.maxHoldMinutes)) && Number(frozen.maxHoldMinutes) >= 0 ? Number(frozen.maxHoldMinutes) : fallback.maxHoldMinutes
  };
}
