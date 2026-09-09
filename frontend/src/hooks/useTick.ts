import { useEffect, useRef, useState } from 'react';

export type TickDirection = 'up' | 'down' | null;

export type Tick = {
  direction: TickDirection;
  /** Increments per flash. Use as a React key so consecutive flashes in the
   *  same direction restart the animation instead of merging into one. */
  nonce: number;
};

/**
 * Reports which way a number just moved, so a value can flash its direction.
 *
 * Two deliberate properties:
 *
 * 1. It never interpolates. The caller renders the true value throughout; this
 *    only reports direction. A trading readout must never display a number the
 *    system did not hold, which rules out count-up animations on prices, P&L
 *    and fills.
 *
 * 2. It coalesces. Option quotes arrive around fifty a second; restarting a
 *    420ms flash that often is a strobe, not information. At most one flash
 *    runs per `holdMs`, and when it ends the value is compared against where
 *    it stood when the flash began — so what you see is the true net direction
 *    over that window, and a fast tape pulses at a readable cadence.
 */
export function useTick(value: number | null | undefined, holdMs = 420): Tick {
  const [tick, setTick] = useState<Tick>({ direction: null, nonce: 0 });
  const settled = useRef<number | null>(null);
  const latest = useRef<number | null>(null);
  const flashing = useRef(false);
  const timer = useRef<number | null>(null);

  const numeric = Number.isFinite(Number(value)) ? Number(value) : null;

  useEffect(() => {
    latest.current = numeric;
    if (numeric === null) return;
    if (settled.current === null) {
      settled.current = numeric;
      return;
    }
    if (flashing.current || numeric === settled.current) return;

    const start = (from: number) => {
      const to = latest.current;
      if (to === null || to === from) {
        flashing.current = false;
        settled.current = from;
        return;
      }
      flashing.current = true;
      settled.current = from;
      setTick((current) => ({ direction: to > from ? 'up' : 'down', nonce: current.nonce + 1 }));

      timer.current = window.setTimeout(() => {
        const base = latest.current;
        flashing.current = false;
        setTick((current) => ({ direction: null, nonce: current.nonce }));
        // Anything that moved during the flash gets folded into the next one.
        if (base !== null && base !== to) start(to);
        else settled.current = to;
      }, holdMs);
    };

    start(settled.current);
  }, [numeric, holdMs]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return tick;
}
