import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The title / subtitle / actions row every page opens with.
 *
 * Every route had rolled its own — different heading sizes, different gaps,
 * and Goals had no header at all, so you could not tell from the top of the
 * screen where you were. One component, so a new page cannot forget.
 */
export function PageHeader({
  title,
  description,
  badge,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  /** A short qualifier next to the title — scope, mode, data source. */
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description && (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
