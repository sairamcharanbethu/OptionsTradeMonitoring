import {
  ChevronDown
} from 'lucide-react';
import { type StrategyHistorySetup } from '@/lib/api';
import { money, time, dateTime, duration, contractName, strategyDisplay } from './terminalModel';

const HistorySetupCard = ({ setup }: { setup: StrategyHistorySetup }) => {
  const option = setup.option_details || {};
  const strategy = strategyDisplay(setup.strategy_name);
  const terminalEvent = [...setup.lifecycle_events].reverse().find(event => event.closeReason || ['COMPLETED', 'INVALIDATED', 'FAILED', 'TRACKING_ABORTED'].includes(event.status));
  const finalEvent = setup.lifecycle_events[setup.lifecycle_events.length - 1];
  const plannedQuantity = Number(option.planned_contracts || setup.contracts_requested || 0);
  const plannedPrice = Number(option.planned_limit_price || option.mark || 0);
  const plannedDebit = Number(option.planned_total_debit || (plannedQuantity > 0 && plannedPrice > 0 ? plannedQuantity * plannedPrice * 100 : 0));
  const outcome = setup.position_status === 'CLOSED'
    ? setup.realized_pnl == null ? 'Closed' : setup.realized_pnl >= 0 ? 'Closed · profit' : 'Closed · loss'
    : setup.execution_status
      ? setup.execution_status
      : setup.lifecycle_status;
  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950/45">
      <summary className="grid cursor-pointer list-none gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${setup.side === 'CALL' ? 'bg-emerald-950/50 text-emerald-300' : 'bg-rose-950/50 text-rose-300'}`}>{setup.side}</span>
            <span className="truncate text-xs font-semibold text-zinc-200">{strategy.name}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={contractName(option, setup.side)}>{contractName(option, setup.side)}</div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-[10px]">
          <div><div className="text-zinc-600">Trigger</div><div className="mt-0.5 font-mono text-zinc-300">{money(setup.entry_trigger)}</div></div>
          <div><div className="text-zinc-600">Stop</div><div className="mt-0.5 font-mono text-rose-300">{money(setup.invalidation)}</div></div>
          <div><div className="text-zinc-600">Target</div><div className="mt-0.5 font-mono text-sky-300">{money(setup.target)}</div></div>
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <div className="text-right">
            <div className="text-[10px] font-semibold text-zinc-300">{outcome}</div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-600">{dateTime(setup.created_at)}</div>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-open:rotate-180" />
        </div>
      </summary>
      <div className="border-t border-zinc-800 px-3 py-3">
        <div className="mb-3 rounded-md border border-zinc-800 bg-black/15 px-2.5 py-2 text-[10px] leading-relaxed text-zinc-400">
          <span className="font-semibold text-zinc-300">Why it appeared:</span> {strategy.explanation}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md bg-black/20 p-2.5 text-[10px] text-zinc-500">
            <div>Plan</div>
            <div className="mt-1 font-mono text-xs text-zinc-200">{plannedQuantity || '—'} × {money(plannedPrice)}</div>
            <div className="mt-1">Debit {plannedDebit > 0 ? money(plannedDebit) : '—'}</div>
          </div>
          <div className="rounded-md bg-black/20 p-2.5 text-[10px] text-zinc-500">
            <div>Execution</div>
            <div className="mt-1 font-mono text-xs text-zinc-200">{setup.execution_status || setup.user_execution_status || 'Not submitted'}</div>
            <div className="mt-1">{setup.execution_broker || 'No broker order'}</div>
          </div>
          <div className="rounded-md bg-black/20 p-2.5 text-[10px] text-zinc-500">
            <div>Result</div>
            <div className={`mt-1 font-mono text-xs ${setup.realized_pnl == null ? 'text-zinc-200' : setup.realized_pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {setup.realized_pnl == null ? setup.position_status || 'No position' : `${setup.realized_pnl >= 0 ? '+' : ''}${money(setup.realized_pnl)}`}
            </div>
            <div className="mt-1">{terminalEvent?.closeReason?.replace(/_/g, ' ') || 'No close reason recorded'} · {duration(setup.created_at, finalEvent?.createdAt || setup.position_updated_at)}</div>
          </div>
        </div>
        <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Lifecycle timeline</div>
        <div className="mt-2 space-y-0">
          {setup.lifecycle_events.length > 0 ? setup.lifecycle_events.map((event, index) => (
            <div key={event.id} className="grid grid-cols-[0.8rem_4.5rem_1fr] gap-2 text-[10px]">
              <div className="relative flex justify-center">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-sky-400" />
                {index < setup.lifecycle_events.length - 1 && <span className="absolute bottom-0 top-2 w-px bg-zinc-800" />}
              </div>
              <div className="pb-2 font-mono text-zinc-600">{time(event.createdAt)}</div>
              <div className="pb-2 text-zinc-300">
                <span className="font-semibold">{event.state || event.status}</span>
                {event.targetsHit > 0 ? ` · target ${event.targetsHit} hit` : ''}
                {event.closeReason ? ` · ${event.closeReason.replace(/_/g, ' ')}` : ''}
                {!event.closeReason && event.blockers?.[0] ? <div className="mt-0.5 text-zinc-600">{event.blockers[0]}</div> : null}
              </div>
            </div>
          )) : <div className="text-xs text-zinc-600">No lifecycle events were recorded for this setup.</div>}
        </div>
        {setup.execution_error && <div className="mt-2 rounded-md border border-rose-500/20 bg-rose-950/15 px-2.5 py-2 text-xs text-rose-200">{setup.execution_error}</div>}
      </div>
    </details>
  );
};


export default HistorySetupCard;
