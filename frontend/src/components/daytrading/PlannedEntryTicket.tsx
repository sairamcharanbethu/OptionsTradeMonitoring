import { type OptionDetailsJSON } from '@/lib/api';
import { money, number, contractName, humanContractName, optionSpreadPct } from './terminalModel';

const PlannedEntryTicket = ({
  option,
  side,
  quantity,
  plannedLimit,
  orderDebit,
  quoteAge
}: {
  option: OptionDetailsJSON | Record<string, any>;
  side: string | null;
  quantity: number;
  plannedLimit: number;
  orderDebit: number;
  quoteAge: number;
}) => {
  const quoteFresh = Number.isFinite(quoteAge) && quoteAge >= 0 && quoteAge <= 15;
  const spreadPct = optionSpreadPct(option);
  return (
    <div className="mt-4 rounded-lg border border-zinc-700/80 bg-zinc-950/55 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Planned entry ticket</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{humanContractName(option, side)}</div>
          <div className="mt-1 select-all break-all font-mono text-[10px] text-zinc-500" title="Contract symbol">{contractName(option, side)}</div>
        </div>
        <span className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold ${
          quoteFresh
            ? 'border-emerald-500/25 bg-emerald-950/30 text-emerald-300'
            : 'border-rose-500/25 bg-rose-950/30 text-rose-300'
        }`}>
          {quoteFresh ? `${number(quoteAge, 1)}s fresh` : 'Quote stale'}
        </span>
      </div>
      <div className="mt-3 border-t border-zinc-800 pt-2">
        <div className="font-mono text-xs font-semibold tabular-nums text-zinc-200">
          {quantity} contract{quantity === 1 ? '' : 's'} · {money(plannedLimit)} limit · {orderDebit > 0 ? money(orderDebit) : '—'} max debit
        </div>
        <div className="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
          {money(option.bid)} bid / {money(option.ask)} ask · {Number.isFinite(spreadPct) ? `${number(spreadPct)}% spread` : 'spread unavailable'}
        </div>
      </div>
      <div className="mt-2 text-[10px] text-zinc-600">Protected limit order only</div>
    </div>
  );
};


export default PlannedEntryTicket;
