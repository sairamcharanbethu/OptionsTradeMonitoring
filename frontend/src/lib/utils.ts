import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { Position } from "./api"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('T')[0].split('-').map(Number);
  // Months in JS Date are 0-indexed
  return new Date(year, month - 1, day);
}

export const getPnL = (pos: Position) => {
  if (pos.current_price == null) return 0;
  return (Number(pos.current_price) - Number(pos.entry_price)) * pos.quantity * 100; // Assuming standard options contract size 100
};

export const getRoi = (pos: Position) => {
  const cost = Number(pos.entry_price) * 100 * Number(pos.quantity);
  if (cost === 0 || !pos.entry_price || !pos.quantity) return 0;

  // For closed positions, use realized_pnl; for open positions, calculate from current price
  if (pos.status === 'CLOSED' && pos.realized_pnl !== undefined) {
    return (Number(pos.realized_pnl) / cost) * 100;
  }

  // For open positions, calculate unrealized ROI
  if (pos.current_price == null) return 0;
  const unrealizedPnl = (Number(pos.current_price) - Number(pos.entry_price)) * Number(pos.quantity) * 100;
  return (unrealizedPnl / cost) * 100;
};

export const getDte = (expirationDate: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = parseLocalDate(expirationDate);
  exp.setHours(0, 0, 0, 0);
  const diffTime = exp.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};
