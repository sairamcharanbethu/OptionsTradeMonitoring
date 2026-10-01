/**
 * OCC/OSI option ticker helpers shared by execution, exits and reconciliation.
 * Format: SPY251010C00640000 (root, YYMMDD, C/P, strike * 1000 zero-padded).
 */
export function constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT' | string, expiration: string | Date): string {
  let dateStr = '';
  if (expiration instanceof Date) {
    const year = expiration.getFullYear();
    const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
    const day = expiration.getDate().toString().padStart(2, '0');
    dateStr = `${year}-${month}-${day}`;
  } else {
    dateStr = String(expiration || '').split('T')[0];
  }
  const [year, month, day] = dateStr.split('-');
  if (!year || !month || !day) return '';
  const yy = year.slice(-2);
  const right = String(type || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  const strikeStr = Math.round(Number(strike) * 1000).toString().padStart(8, '0');
  return `${String(symbol || '').toUpperCase()}${yy}${month}${day}${right}${strikeStr}`;
}

/** Whitespace-free, upper-cased form used for equality checks against broker tickers. */
export function canonicalOccTicker(value: any): string {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

/** Parse an OCC ticker back into its parts; null when it does not match the format. */
export function parseOSITicker(ticker: string): { symbol: string; expiration: string; optionType: 'CALL' | 'PUT'; strike: number } | null {
  const match = canonicalOccTicker(ticker).match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  const [, symbol, yy, mm, dd, right, strikeRaw] = match;
  return {
    symbol,
    expiration: `20${yy}-${mm}-${dd}`,
    optionType: right === 'P' ? 'PUT' : 'CALL',
    strike: Number(strikeRaw) / 1000
  };
}
