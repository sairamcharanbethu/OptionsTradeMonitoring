export type OptionType = 'CALL' | 'PUT';
export type TrailingType = 'DOLLAR' | 'PERCENT';

export type OptionsCalculatorInputs = {
  optionType: OptionType;
  quantity: string;
  entryPrice: string;
  currentPrice: string;
  currentBid: string;
  currentAsk: string;
  highestPrice: string;
  trailingType: TrailingType;
  trailingAmount: string;
  limitOffset: string;
  manualStop: string;
  profitTarget: string;
  accountSize: string;
  maxRiskPercent: string;
};

export type CalculatorError = {
  field: keyof OptionsCalculatorInputs;
  message: string;
};

export const OPTIONS_CALCULATOR_STORAGE_KEY = 'strikepilot.optionsCalculator.v1';
export const OPTIONS_CONTRACT_MULTIPLIER = 100;
export const TRAILING_PLANNER_PERCENTAGES = [5, 10, 15, 20, 25] as const;

export const DEFAULT_OPTIONS_CALCULATOR_INPUTS: OptionsCalculatorInputs = {
  optionType: 'CALL',
  quantity: '5',
  entryPrice: '0.53',
  currentPrice: '0.65',
  currentBid: '0.64',
  currentAsk: '0.66',
  highestPrice: '0.70',
  trailingType: 'PERCENT',
  trailingAmount: '15',
  limitOffset: '0.02',
  manualStop: '0.45',
  profitTarget: '1.00',
  accountSize: '25000',
  maxRiskPercent: '1'
};

const requiredLabels: Partial<Record<keyof OptionsCalculatorInputs, string>> = {
  quantity: 'Quantity',
  entryPrice: 'Entry price',
  currentPrice: 'Current option price',
  currentBid: 'Current bid',
  currentAsk: 'Current ask',
  highestPrice: 'High-water mark',
  trailingAmount: 'Trailing amount',
  limitOffset: 'Stop-limit offset',
  accountSize: 'Account size',
  maxRiskPercent: 'Maximum risk'
};

const numberValue = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0;
const optionalNumber = (value: string) => value === '' ? null : numberValue(value);

export function normalizeCalculatorInputs(value: unknown): OptionsCalculatorInputs {
  if (!value || typeof value !== 'object') return DEFAULT_OPTIONS_CALCULATOR_INPUTS;
  const saved = value as Partial<Record<keyof OptionsCalculatorInputs, unknown>>;
  return Object.fromEntries(
    Object.entries(DEFAULT_OPTIONS_CALCULATOR_INPUTS).map(([key, fallback]) => {
      const candidate = saved[key as keyof OptionsCalculatorInputs];
      if (key === 'optionType') return [key, candidate === 'PUT' ? 'PUT' : 'CALL'];
      if (key === 'trailingType') return [key, candidate === 'DOLLAR' ? 'DOLLAR' : 'PERCENT'];
      return [key, candidate === null || candidate === undefined ? fallback : String(candidate)];
    })
  ) as OptionsCalculatorInputs;
}

export function calculateOptionsPlan(inputs: OptionsCalculatorInputs) {
  const quantity = numberValue(inputs.quantity);
  const entryPrice = numberValue(inputs.entryPrice);
  const currentPrice = numberValue(inputs.currentPrice);
  const currentBid = numberValue(inputs.currentBid);
  const currentAsk = numberValue(inputs.currentAsk);
  const highestPrice = numberValue(inputs.highestPrice);
  const trailingAmount = numberValue(inputs.trailingAmount);
  const limitOffset = numberValue(inputs.limitOffset);
  const manualStop = optionalNumber(inputs.manualStop);
  const profitTarget = optionalNumber(inputs.profitTarget);
  const accountSize = numberValue(inputs.accountSize);
  const maxRiskPercent = numberValue(inputs.maxRiskPercent);
  const missing = new Set(
    (Object.keys(requiredLabels) as (keyof OptionsCalculatorInputs)[])
      .filter(field => inputs[field] === '')
  );
  const errors: CalculatorError[] = [...missing].map(field => ({
    field,
    message: `${requiredLabels[field]} is required.`
  }));
  const addError = (field: keyof OptionsCalculatorInputs, message: string) => {
    if (!missing.has(field)) errors.push({ field, message });
  };

  if (!Number.isInteger(quantity) || quantity < 1) addError('quantity', 'Quantity must be a whole number of at least 1 contract.');
  if (entryPrice <= 0) addError('entryPrice', 'Entry price must be greater than $0.');
  if (currentPrice < 0) addError('currentPrice', 'Current option price cannot be negative.');
  if (currentBid < 0) addError('currentBid', 'Current bid cannot be negative.');
  if (currentAsk < 0) addError('currentAsk', 'Current ask cannot be negative.');
  if (!missing.has('currentAsk') && !missing.has('currentBid') && currentAsk < currentBid) addError('currentAsk', 'Current ask must be greater than or equal to the current bid.');
  if (!missing.has('highestPrice') && !missing.has('currentPrice') && highestPrice < currentPrice) addError('highestPrice', 'High-water mark cannot be below the current option price.');
  if (highestPrice <= 0) addError('highestPrice', 'High-water mark must be greater than $0.');
  if (trailingAmount <= 0) addError('trailingAmount', 'Trailing amount must be greater than 0.');
  if (inputs.trailingType === 'PERCENT' && trailingAmount > 100) addError('trailingAmount', 'Percentage trail cannot exceed 100%.');
  if (limitOffset < 0) addError('limitOffset', 'Stop-limit offset cannot be negative.');
  if (manualStop !== null && manualStop < 0) addError('manualStop', 'Manual stop-loss price cannot be negative.');
  if (!missing.has('currentPrice') && manualStop !== null && manualStop > currentPrice) addError('manualStop', 'For a live long position, the manual stop cannot be above the current option price.');
  if (profitTarget !== null && profitTarget <= entryPrice) addError('profitTarget', 'Profit target must be above the entry price for a long option.');
  if (accountSize <= 0) addError('accountSize', 'Account size must be greater than $0.');
  if (maxRiskPercent <= 0 || maxRiskPercent > 100) addError('maxRiskPercent', 'Maximum risk must be greater than 0% and no more than 100%.');

  const trailingAmountDollars = inputs.trailingType === 'PERCENT'
    ? highestPrice * trailingAmount / 100
    : trailingAmount;
  const rawTrailingTrigger = highestPrice - trailingAmountDollars;
  if (!missing.has('highestPrice') && !missing.has('trailingAmount') && rawTrailingTrigger < 0) addError('trailingAmount', 'Trailing amount is larger than the high-water mark.');
  if (!missing.has('highestPrice') && !missing.has('trailingAmount') && !missing.has('limitOffset') && limitOffset > Math.max(0, rawTrailingTrigger)) addError('limitOffset', 'Stop-limit offset cannot exceed the calculated trailing trigger.');

  const contracts = Math.max(0, quantity);
  const totalCost = entryPrice * contracts * OPTIONS_CONTRACT_MULTIPLIER;
  const currentValue = currentPrice * contracts * OPTIONS_CONTRACT_MULTIPLIER;
  const currentPnl = currentValue - totalCost;
  const currentPnlPercent = totalCost > 0 ? currentPnl / totalCost * 100 : 0;
  const plannedLoss = Math.max(0, (entryPrice - (manualStop ?? 0)) * contracts * OPTIONS_CONTRACT_MULTIPLIER);
  const protectedProfit = manualStop === null ? 0 : Math.max(0, (manualStop - entryPrice) * contracts * OPTIONS_CONTRACT_MULTIPLIER);
  const plannedLossPercent = accountSize > 0 ? plannedLoss / accountSize * 100 : 0;
  const allowedRisk = accountSize * maxRiskPercent / 100;
  const trailingTrigger = Math.max(0, rawTrailingTrigger);
  const trailingLimit = Math.max(0, trailingTrigger - limitOffset);
  const stopPnl = (trailingLimit - entryPrice) * contracts * OPTIONS_CONTRACT_MULTIPLIER;
  const targetProfit = profitTarget === null ? null : (profitTarget - entryPrice) * contracts * OPTIONS_CONTRACT_MULTIPLIER;
  const riskReward = targetProfit !== null && plannedLoss > 0 ? targetProfit / plannedLoss : null;
  const spreadDollars = Math.max(0, currentAsk - currentBid);
  const quoteMid = (currentAsk + currentBid) / 2;
  const spreadPercent = quoteMid > 0 ? spreadDollars / quoteMid * 100 : 0;

  return {
    errors,
    quantity,
    entryPrice,
    currentPrice,
    currentBid,
    currentAsk,
    highestPrice,
    trailingAmount,
    limitOffset,
    manualStop,
    profitTarget,
    accountSize,
    maxRiskPercent,
    totalCost,
    currentValue,
    currentPnl,
    currentPnlPercent,
    plannedLoss,
    protectedProfit,
    plannedLossPercent,
    allowedRisk,
    trailingAmountDollars,
    trailingTrigger,
    trailingLimit,
    stopPnl,
    targetProfit,
    riskReward,
    spreadDollars,
    spreadPercent,
    riskWithinBudget: plannedLoss <= allowedRisk,
    planner: TRAILING_PLANNER_PERCENTAGES.map(percent => {
      const amount = highestPrice * percent / 100;
      const trigger = Math.max(0, highestPrice - amount);
      return {
        percent,
        amount,
        trigger,
        pnl: (trigger - entryPrice) * contracts * OPTIONS_CONTRACT_MULTIPLIER
      };
    })
  };
}
