

const CompactRiskMetric = ({ label, value, tone = 'text-zinc-100' }: { label: string; value: string; tone?: string }) => (
  <div className="min-w-0 rounded-md bg-zinc-950/45 px-2 py-1.5 sm:bg-transparent sm:px-2">
    <div className="truncate text-[9px] font-medium uppercase tracking-[0.1em] text-zinc-600">{label}</div>
    <div className={`mt-0.5 truncate font-mono text-xs font-semibold tabular-nums ${tone}`} title={value}>{value}</div>
  </div>
);


export default CompactRiskMetric;
