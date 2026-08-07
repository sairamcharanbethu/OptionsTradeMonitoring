export type VoidableTrade = {
  status?: string | null;
  execution_status?: string | null;
  execution_broker?: string | null;
  expiration_date?: string | Date | null;
  is_simulated?: boolean | null;
};

export type TradeVoidEligibility = {
  allowed: boolean;
  reason: string | null;
};

export function newYorkDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function tradeExpirationKey(expiration: string | Date | null | undefined): string {
  if (expiration instanceof Date) return expiration.toISOString().slice(0, 10);
  return String(expiration || '').slice(0, 10);
}

export function isTradeExpired(trade: Pick<VoidableTrade, 'expiration_date'>, now = new Date()): boolean {
  const expiration = tradeExpirationKey(trade.expiration_date);
  return /^\d{4}-\d{2}-\d{2}$/.test(expiration) && expiration < newYorkDateKey(now);
}

export function getTradeVoidEligibility(trade: VoidableTrade, now = new Date()): TradeVoidEligibility {
  if (String(trade.execution_broker || '') !== 'wealthsimple_snaptrade' || trade.is_simulated === true) {
    return { allowed: false, reason: 'Only live Wealthsimple positions can be voided here' };
  }
  if (String(trade.status || '') !== 'OPEN') {
    return { allowed: false, reason: 'Only an open local position can be voided' };
  }

  if (!isTradeExpired(trade, now)) {
    return { allowed: false, reason: 'The option contract must be expired before it can be voided' };
  }

  const executionStatus = String(trade.execution_status || '');
  if (executionStatus !== 'PENDING_EXIT' && !executionStatus.startsWith('EXIT_')) {
    return { allowed: false, reason: 'The position must have an unresolved exit state before it can be voided' };
  }

  return { allowed: true, reason: null };
}

export function expectedTradeVoidConfirmation(positionId: number | string): string {
  return `VOID ${positionId}`;
}

export function isTradeVoidConfirmationValid(positionId: number | string, confirmation: unknown): boolean {
  return String(confirmation || '').trim() === expectedTradeVoidConfirmation(positionId);
}

export function tradeVoidSignalErrorPattern(positionId: number | string): string {
  return `%Position #${positionId}:%`;
}
