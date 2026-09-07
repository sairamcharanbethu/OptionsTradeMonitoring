import { Link } from 'react-router-dom';
import { type OptionDetailsJSON, type Position } from '@/lib/api';
import { money, humanContractName, levelDistance } from './terminalModel';
import Metric from './Metric';

const PositionSummary = ({
  position,
  option,
  side,
  spot,
  invalidation,
  target
}: {
  position: Position;
  option: OptionDetailsJSON | Record<string, any>;
  side: string | null;
  spot: unknown;
  invalidation: unknown;
  target: unknown;
}) => {
  const entry = Number(position.entry_price || 0);
  const current = Number(position.current_price || entry);
  const spotPrice = Number(spot);
  const premiumMappedToSpot = Number.isFinite(spotPrice)
    && Math.abs(current - spotPrice) < 0.01
    && current > Math.max(entry * 10, 25);
  const openPnl = premiumMappedToSpot ? null : (current - entry) * Number(position.quantity || 0) * 100;
  const exactContract = option.ticker || option.local_symbol || `${position.symbol} ${position.option_type} ${money(position.strike_price)}`;
  const simulated = position.is_simulated === true || position.execution_broker === 'simulated';
  const positionContract = humanContractName({
    ...option,
    strike: position.strike_price || option.strike,
    expiry: position.expiration_date || option.expiry
  }, position.option_type || side);
  const positionBroker = position.execution_broker === 'wealthsimple_snaptrade'
    ? 'Wealthsimple / SnapTrade'
    : position.execution_broker || 'broker unavailable';
  return (
    <section className="rounded-xl border border-sky-500/25 bg-sky-950/10 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-300">
            {simulated ? 'Shadow strategy position' : 'Linked autonomous position'}
          </div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{positionContract}</div>
          <div className="mt-1 select-all break-all font-mono text-[10px] text-zinc-500" title="Contract symbol">{exactContract}</div>
          <div className="mt-1 text-xs text-zinc-500">
            {position.quantity} contract{Number(position.quantity) === 1 ? '' : 's'} · {simulated ? 'simulation only' : positionBroker}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className={`font-mono text-xl font-semibold tabular-nums ${openPnl === null ? 'text-amber-300' : openPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {openPnl === null ? '—' : `${openPnl >= 0 ? '+' : ''}${money(openPnl)}`}
          </div>
          <div className="text-[10px] text-zinc-500">{openPnl === null ? 'awaiting option quote' : 'estimated open P&L'}</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 border-t border-sky-500/15 pt-3 sm:grid-cols-5">
        <Metric label="Entry premium" value={money(position.entry_price)} />
        <Metric label="Current premium" value={premiumMappedToSpot ? 'Unavailable' : money(position.current_price)} />
        <Metric label="SPY now" value={money(spot)} />
        <Metric label="Invalidation" value={money(invalidation)} detail={levelDistance(spot, invalidation)} tone="text-rose-200" />
        <Metric label="Target" value={money(target)} detail={levelDistance(spot, target)} tone="text-sky-200" />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/15 bg-zinc-950/40 px-3 py-2 text-[10px]">
        <span className="text-zinc-500">Broker state <span className="font-mono text-zinc-200">{position.execution_status || position.last_broker_order_status || position.status}</span></span>
        <span className="text-zinc-500">Lifecycle <span className="font-mono text-zinc-200">{position.strategy_lifecycle_status || 'MANAGE'}</span></span>
        <Link to={`/positions/${position.id}`} className="font-semibold text-sky-300 transition-colors hover:text-sky-200">Open details →</Link>
      </div>
      {premiumMappedToSpot && (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          The last stored option premium matched SPY spot and was rejected as invalid. Waiting for an exact IBKR contract quote.
        </div>
      )}
      {position.execution_error && (
        <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
          {position.execution_error}
        </div>
      )}
    </section>
  );
};


export default PositionSummary;
