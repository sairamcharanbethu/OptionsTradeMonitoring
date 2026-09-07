import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The three colour roles, as components.
 *
 * Colour alone cannot separate "you are losing money" from "a service is
 * broken" — both want to be red, and on a trading screen guessing wrong is
 * expensive. So each role gets its own *shape*, and colour only reinforces it:
 *
 *   <Num>          money and metrics. Bare tabular numerals, no chrome.
 *   <StatusChip>   system severity. Tinted chip, border, uppercase.
 *   buttons        things you press. 40px, icon, filled or outlined.
 *
 * If you find yourself reaching for text-emerald-500 or text-red-400 directly,
 * one of these is what you actually wanted.
 */

/* -------------------------------------------------------------------------- */
/*  Money                                                                      */
/* -------------------------------------------------------------------------- */

export type NumTone = 'up' | 'down' | 'flat' | 'auto' | 'plain';

const NUM_TONE: Record<Exclude<NumTone, 'auto'>, string> = {
  up: 'text-pnl-up',
  down: 'text-pnl-down',
  flat: 'text-pnl-flat',
  plain: 'text-foreground',
};

export type NumSize = 'sm' | 'md' | 'lg' | 'xl' | 'hero';

const NUM_SIZE: Record<NumSize, string> = {
  sm: 'text-2xs',
  md: 'text-xs',
  lg: 'text-base font-semibold',
  xl: 'text-xl font-semibold',
  hero: 'text-3xl font-semibold',
};

/**
 * A number that sits in a column. Tabular figures, slashed zero, so digits
 * never shift as prices tick. Pass `value` to colour it by sign automatically.
 */
export function Num({
  children,
  tone = 'plain',
  size = 'md',
  value,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: NumTone;
  size?: NumSize;
  /** When tone is "auto", the sign of this decides up / down / flat. */
  value?: number | null;
}) {
  const resolved: Exclude<NumTone, 'auto'> =
    tone !== 'auto'
      ? tone
      : value == null || value === 0
        ? 'flat'
        : value > 0
          ? 'up'
          : 'down';

  return (
    <span className={cn('num', NUM_SIZE[size], NUM_TONE[resolved], className)} {...props}>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Severity                                                                   */
/* -------------------------------------------------------------------------- */

export type Severity = 'ok' | 'info' | 'warn' | 'critical' | 'muted';

const SEV: Record<Severity, { chip: string; dot: string }> = {
  // A healthy system is deliberately quiet. Only the dot is green; shouting
  // "UP" in green next to a green profit figure is what caused the confusion.
  ok: { chip: 'border-border bg-sev-ok-soft text-sev-ok', dot: 'bg-sev-ok-dot' },
  info: { chip: 'border-sev-info/30 bg-sev-info-soft text-sev-info', dot: 'bg-sev-info' },
  warn: { chip: 'border-sev-warn/35 bg-sev-warn-soft text-sev-warn', dot: 'bg-sev-warn' },
  critical: { chip: 'border-sev-critical/35 bg-sev-critical-soft text-sev-critical', dot: 'bg-sev-critical' },
  muted: { chip: 'border-border bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
};

/** Maps the status strings the backend already emits onto a severity. */
export function severityOf(status: string | null | undefined): Severity {
  const s = String(status || '').toUpperCase();
  if (!s) return 'muted';
  if (['DOWN', 'ERROR', 'CRITICAL', 'FAILED', 'HALTED', 'UNREACHABLE', 'DISCONNECTED', 'OFFLINE'].includes(s)) return 'critical';
  if (['DEGRADED', 'WARN', 'WARNING', 'STALE', 'DISARMED', 'BLOCKED', 'PAUSED', 'IDLE', 'STOPPED', 'UNAVAILABLE', 'MARKET_CLOSED'].includes(s)) return 'warn';
  if (['UP', 'OK', 'HEALTHY', 'LIVE', 'RUNNING', 'CONNECTED', 'ACTIVE', 'ARMED'].includes(s)) return 'ok';
  return 'info';
}

/**
 * System state. Always reads as a chip so it can never be mistaken for a
 * P&L figure or for something you can press.
 */
export function StatusChip({
  children,
  severity = 'muted',
  dot = true,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { severity?: Severity; dot?: boolean }) {
  const tone = SEV[severity];
  return (
    <span className={cn('status-chip', tone.chip, className)} {...props}>
      {dot && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** The small caps caption above a value. Sans, never mono, never a number. */
export function FieldLabel({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn('label-micro', className)} {...props}>
      {children}
    </span>
  );
}

/** The label-over-value pairing used by every KPI tile in the app. */
export function Field({
  label,
  children,
  className,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <FieldLabel>{label}</FieldLabel>
      <div className="min-w-0 truncate">{children}</div>
      {hint != null && <div className="text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
