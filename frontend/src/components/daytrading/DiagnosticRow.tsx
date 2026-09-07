

const DiagnosticRow = ({ label, status, age, detail, next }: { label: string; status: string; age?: string; detail: string; next: string }) => {
  const normalized = status.toUpperCase();
  const healthy = ['UP', 'OK', 'CONNECTED', 'LIVE'].includes(normalized);
  const informational = ['IDLE', 'MARKET_CLOSED', 'N/A'].includes(normalized);
  return (
    <div className="border-b border-zinc-800/70 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        <span className={`font-mono text-2xs font-semibold ${healthy ? 'text-emerald-300' : informational ? 'text-zinc-400' : 'text-amber-300'}`}>{normalized}</span>
      </div>
      <div className="mt-1 flex items-start justify-between gap-3 text-2xs leading-relaxed text-zinc-600">
        <span>{detail}</span>
        {age && <span className="shrink-0 font-mono">{age}</span>}
      </div>
      {!healthy && !informational && <div className="mt-1 text-2xs leading-relaxed text-amber-300/80">Next: {next}</div>}
    </div>
  );
};


export default DiagnosticRow;
