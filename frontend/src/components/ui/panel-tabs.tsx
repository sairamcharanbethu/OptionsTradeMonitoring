import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Secondary navigation inside a page, for content that matters but should not
 * cost the operator a scroll during a live entry window.
 *
 * The cockpit's decision surface stays pinned above this; everything that is
 * evidence rather than decision lives behind one of these tabs. Selection is
 * remembered per key so a refresh mid-session does not lose your place.
 */

export type PanelTab = {
  id: string;
  label: string;
  /** Rendered after the label — a count, or a severity dot. */
  badge?: React.ReactNode;
};

export function usePanelTab(storageKey: string, tabs: PanelTab[], fallback?: string) {
  const initial = () => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && tabs.some((t) => t.id === saved)) return saved;
    } catch {
      /* private mode, blocked storage — fall through to the default */
    }
    return fallback || tabs[0]?.id;
  };
  const [active, setActive] = React.useState<string>(initial);

  const select = React.useCallback(
    (id: string) => {
      setActive(id);
      try {
        localStorage.setItem(storageKey, id);
      } catch {
        /* not worth failing a tab change over */
      }
    },
    [storageKey]
  );

  // A tab can disappear (admin-only, or an empty section). Don't strand the user.
  React.useEffect(() => {
    if (!tabs.some((t) => t.id === active) && tabs.length) select(tabs[0].id);
  }, [tabs, active, select]);

  return [active, select] as const;
}

export function PanelTabs({
  tabs,
  active,
  onSelect,
  className,
  'aria-label': ariaLabel = 'Panel sections',
}: {
  tabs: PanelTab[];
  active: string;
  onSelect: (id: string) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (event: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    let next = i;
    if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    onSelect(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'flex w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1',
        className
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => { refs.current[tab.id] = el; }}
            role="tab"
            id={`paneltab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'motion-press flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              selected
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            {tab.label}
            {tab.badge != null && tab.badge}
          </button>
        );
      })}
    </div>
  );
}

export function PanelBody({
  id,
  active,
  children,
  className,
}: {
  id: string;
  active: string;
  children: React.ReactNode;
  className?: string;
}) {
  if (id !== active) return null;
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`paneltab-${id}`}
      tabIndex={0}
      className={cn('motion-enter space-y-3 focus-visible:outline-none sm:space-y-4', className)}
    >
      {children}
    </div>
  );
}

/** A small count that rides on a tab label. */
export function TabCount({ n, tone = 'muted' }: { n: number; tone?: 'muted' | 'warn' | 'critical' }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        'num rounded-full px-1.5 text-2xs font-semibold',
        tone === 'critical'
          ? 'bg-sev-critical-soft text-sev-critical'
          : tone === 'warn'
            ? 'bg-sev-warn-soft text-sev-warn'
            : 'bg-foreground/10 text-muted-foreground'
      )}
    >
      {n}
    </span>
  );
}
