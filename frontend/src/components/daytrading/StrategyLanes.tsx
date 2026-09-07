import { optionSide, strategyDisplay } from './terminalModel';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'strategyLanes' |
  'setup'
>;

export default function StrategyLanes(props: Props) {
  const {
    strategyLanes, setup
  } = props;
  if (!(strategyLanes.length > 1)) return null;
  return (
          <section className="mx-2.5 mt-2.5 grid gap-2 sm:mx-5 sm:mt-4 sm:grid-cols-3" aria-label="Independent strategy lanes">
            {strategyLanes.map(({ lane, setupId, signal: laneSignal }) => {
              const laneState = String(laneSignal?.state || 'WAIT').toUpperCase();
              const laneSide = optionSide(laneSignal);
              const laneBlocker = Array.isArray(laneSignal?.blockers) ? laneSignal.blockers[0] : null;
              const laneName = strategyDisplay(laneSignal?.strategy).name;
              const active = ['ACTIVE', 'MANAGE', 'EXTENDED'].includes(laneState);
              return (
                <div key={lane} className={`rounded-lg border px-3 py-2.5 ${active ? 'border-emerald-500/30 bg-emerald-950/15' : 'border-zinc-800 bg-zinc-950/55'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-semibold text-zinc-200">{laneName}</span>
                    <span className={`font-mono text-[9px] ${active ? 'text-emerald-300' : laneState === 'WATCH' ? 'text-amber-300' : 'text-zinc-500'}`}>{laneState}</span>
                  </div>
                  <div className="mt-1 truncate text-[10px] text-zinc-500">
                    {laneSide ? `${laneSide} · ` : ''}{laneBlocker || (setupId ? 'Independent setup tracked' : 'Waiting for its own entry event')}
                  </div>
                </div>
              );
            })}
          </section>
  );
}
