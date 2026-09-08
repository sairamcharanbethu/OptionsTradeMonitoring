import { cn } from '@/lib/utils';
import { money, num } from './format';

export interface LadderMark {
  price: number;
  label: string;
  /** Tailwind background class for the tick. */
  cls: string;
}

/**
 * Horizontal price ladder shared by the setup card (stop → trigger → targets)
 * and the positions strip (stop → T1 → T2). Laid out so the profit direction
 * always runs left→right: put setups are mirrored. `spot` is the live marker.
 */
export default function PriceLadder({ side, marks, spot, footer, compact = false, ariaLabel }: {
  side: 'CALL' | 'PUT';
  marks: LadderMark[];
  spot: number | null;
  footer?: React.ReactNode;
  compact?: boolean;
  ariaLabel?: string;
}) {
  const levels = marks.map((m) => m.price).filter((v) => Number.isFinite(v));
  if (levels.length === 0) return null;
  const lo = Math.min(...levels, spot ?? Infinity);
  const hi = Math.max(...levels, spot ?? -Infinity);
  const pad = Math.max((hi - lo) * 0.08, 0.05);
  const min = lo - pad; const max = hi + pad; const span = Math.max(max - min, 0.01);
  const x = (price: number) => `${(((side === 'CALL' ? price - min : max - price) / span) * 100).toFixed(2)}%`;
  const label = ariaLabel || `Price ladder: ${marks.map((m) => `${m.label} ${money(m.price)}`).join(', ')}${spot != null ? `, spot ${money(spot)}` : ''}`;
  return (
    <div>
      <div className={cn('relative', compact ? 'mt-1 pb-10 pt-4' : 'mt-2 pb-11 pt-5')}>
      <div className={cn('relative rounded-full bg-gradient-to-r from-rose-500/30 via-zinc-700 to-emerald-500/30', compact ? 'h-1.5' : 'h-2')} role="img" aria-label={label}>
        {marks.map((m) => (
          <div key={`${m.label}-${m.price}`} className={cn('absolute flex -translate-x-1/2 flex-col items-center', compact ? '-top-3.5' : '-top-4')} style={{ left: x(m.price) }}>
            <span className="text-2xs font-semibold text-zinc-400">{m.label}</span>
            <span className={cn('mt-0.5 w-0.5 rounded', compact ? 'h-3' : 'h-3.5', m.cls)} />
            <span className={cn('font-mono text-2xs text-zinc-400', compact ? 'mt-3' : 'mt-4')}>{num(m.price)}</span>
          </div>
        ))}
        {spot != null && Number.isFinite(spot) && (
          <div className={cn('absolute -translate-x-1/2', compact ? '-top-1' : '-top-1.5')} style={{ left: x(spot) }} title={`Spot ${money(spot)}`}>
            <div className={cn('rounded-full border-2 border-zinc-50 bg-zinc-950 shadow-[0_0_10px_rgba(255,255,255,0.6)]', compact ? 'h-3.5 w-3.5' : 'h-5 w-5')} />
          </div>
        )}
      </div>
      </div>
      {footer && <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-zinc-400">{footer}</div>}
    </div>
  );
}
