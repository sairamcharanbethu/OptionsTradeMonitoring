import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export const HOLD_MS = 800;

/**
 * Press-and-hold confirmation for destructive operator actions. Holding for
 * HOLD_MS fires onConfirm once; releasing or leaving early cancels. Shared by
 * the ActionBar and the Day Trading setup card so both behave identically.
 */
export default function HoldToConfirmButton({
  label, hint, icon, tone = 'neutral', disabled, busy, onConfirm, shortcut, count
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  tone?: 'neutral' | 'danger' | 'warn' | 'good';
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  shortcut?: string;
  count?: number | null;
}) {
  const [progress, setProgress] = useState(0);
  const startedAt = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    startedAt.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = null;
    setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (startedAt.current === null) return;
    const elapsed = performance.now() - startedAt.current;
    const next = Math.min(1, elapsed / HOLD_MS);
    setProgress(next);
    if (next >= 1) {
      if (!fired.current) {
        fired.current = true;
        onConfirm();
      }
      cancel();
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }, [cancel, onConfirm]);

  const start = (event: React.PointerEvent) => {
    if (disabled || busy) return;
    event.preventDefault();
    fired.current = false;
    startedAt.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancel(), [cancel]);

  const toneClass = tone === 'danger'
    ? 'border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-500/10'
    : tone === 'warn'
      ? 'border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10'
      : tone === 'good'
        ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10'
        : 'border-border text-foreground hover:bg-accent';
  const fillClass = tone === 'danger' ? 'bg-red-500/25' : tone === 'warn' ? 'bg-amber-500/25' : tone === 'good' ? 'bg-emerald-500/25' : 'bg-primary/20';

  return (
    <button
      type="button"
      className={cn(
        'relative isolate flex h-10 min-w-[7.5rem] select-none items-center justify-center gap-1.5 overflow-hidden rounded-lg border px-3 text-xs font-semibold tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
        toneClass
      )}
      disabled={disabled || busy}
      title={`${hint}${shortcut ? ` (${shortcut})` : ''} — press and hold`}
      aria-label={`${label}. ${hint}. Press and hold to confirm${shortcut ? `, or use ${shortcut}` : ''}`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className={cn('pointer-events-none absolute inset-y-0 left-0 -z-10 transition-none', fillClass)} style={{ width: `${progress * 100}%` }} aria-hidden="true" />
      {icon}
      <span>{busy ? 'Working…' : label}</span>
      {count != null && <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums">{count}</span>}
    </button>
  );
}

