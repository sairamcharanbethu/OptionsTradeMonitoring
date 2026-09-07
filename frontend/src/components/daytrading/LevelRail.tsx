import { money } from './terminalModel';

const LevelRail = ({
  potential,
  levels
}: {
  potential: boolean;
  levels: Array<{ label: string; value: unknown; tone: string; dot: string }>;
}) => (
  <div className="mt-5 rounded-lg border border-zinc-800/80 bg-black/15 px-2 py-3 sm:mt-6 sm:px-4">
    <div className="mb-3 flex items-center justify-between gap-3 px-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        {potential ? 'Potential level plan' : 'Active level plan'}
      </span>
      <span className="hidden text-[10px] text-zinc-500 sm:block">Stop → Spot → Trigger → T1 → T2</span>
    </div>
    <div className="relative grid grid-cols-5 gap-1 before:absolute before:left-[10%] before:right-[10%] before:top-[1.55rem] before:h-px before:bg-zinc-700">
      {levels.map(level => (
        <div key={level.label} className="relative z-10 min-w-0 text-center">
          <div className="truncate text-[10px] font-medium text-zinc-500">{level.label}</div>
          <span className={`mx-auto mt-1.5 block h-2.5 w-2.5 rounded-full border-2 border-[#101216] ${level.dot}`} />
          <div className={`mt-1.5 truncate font-mono text-xs font-semibold tabular-nums sm:text-sm ${level.tone}`} title={money(level.value)}>
            {money(level.value)}
          </div>
        </div>
      ))}
    </div>
  </div>
);


export default LevelRail;
