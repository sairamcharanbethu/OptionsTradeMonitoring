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

  // Safety controls are the most consequential thing on the screen, so they get
  // the most contrast — not the least. The old amber-600-on-white was 3.2:1,
  // and disabled:opacity-40 dropped "Flatten all" to roughly 1.5:1, i.e. you
  // could not read the kill switch you were being denied.
  const toneClass = tone === 'danger'
    ? 'border-act-danger/60 text-act-danger hover:bg-act-danger/12'
    : tone === 'warn'
      ? 'border-transparent bg-act-warn text-act-warn-fg hover:bg-act-warn/90'
      : tone === 'good'
        ? 'border-act-primary/60 text-act-primary hover:bg-act-primary/12'
        : 'border-border text-foreground hover:bg-accent';
  const fillClass = tone === 'danger'
    ? 'bg-act-danger/30'
    : tone === 'warn'
      ? 'bg-black/20'
      : tone === 'good'
        ? 'bg-act-primary/30'
        : 'bg-primary/20';

  const isOff = Boolean(disabled) && !busy;

  return (
    <button
      type="button"
      className={cn(
        'relative isolate flex h-10 min-w-[7.5rem] select-none items-center justify-center gap-1.5 overflow-hidden rounded-md border px-3 text-xs font-semibold tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Unavailable, but still legible: you need to read why an action is
        // off, especially when it is the one that closes your positions.
        isOff
          ? 'cursor-not-allowed border-act-disabled-line bg-act-disabled-bg text-act-disabled-fg'
          : toneClass
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
      {count != null && <span className={cn('num rounded-full px-1.5 text-2xs', isOff ? 'bg-foreground/[0.06]' : 'bg-foreground/10')}>{count}</span>}
    </button>
  );
}

