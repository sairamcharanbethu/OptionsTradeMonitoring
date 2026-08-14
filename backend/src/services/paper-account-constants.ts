export const SHARED_PAPER_ACCOUNT_ID = 'shared-paper';

export const PAPER_STRATEGIES = {
  DAY_TRADING: 'DAY_TRADING',
  WALL_REACTION: 'WALL_REACTION'
} as const;

export type PaperStrategy = typeof PAPER_STRATEGIES[keyof typeof PAPER_STRATEGIES];
