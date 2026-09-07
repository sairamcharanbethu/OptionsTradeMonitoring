

const Metric = ({
  label,
  value,
  detail,
  tooltip,
  tone = 'text-zinc-100'
}: {
  label: string;
  value: string;
  detail?: string;
  tooltip?: string;
  tone?: string;
}) => (
  <div className="min-w-0 py-2" title={tooltip}>
    <div className="text-2xs font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</div>
    <div className={`mt-1 truncate font-mono text-sm font-semibold tabular-nums ${tone}`} title={value}>{value}</div>
    {detail && <div className="mt-0.5 truncate text-2xs text-zinc-500" title={detail}>{detail}</div>}
  </div>
);


export default Metric;
