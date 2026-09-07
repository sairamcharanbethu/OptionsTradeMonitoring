import { money } from './terminalModel';
import CompactRiskMetric from './CompactRiskMetric';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'setup' |
  'plannedContracts' |
  'orderQuantity' |
  'orderDebit' |
  'strategyDebitLimit' |
  'invalidation' |
  'entryReviewAvailable'
>;

export default function EntryReviewBanner(props: Props) {
  const {
    setup, plannedContracts, orderQuantity, orderDebit, strategyDebitLimit, invalidation, entryReviewAvailable
  } = props;
  if (!(entryReviewAvailable)) return null;
  return (
      <section className="rounded-lg border border-zinc-800 bg-[#101216] px-2.5 py-2 sm:px-3">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="shrink-0 px-1 text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Hard risk</div>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:divide-zinc-800">
            <CompactRiskMetric label="Premium risk" value={orderDebit > 0 ? money(orderDebit) : '—'} tone="text-amber-200" />
            <CompactRiskMetric label="Debit ceiling" value={strategyDebitLimit > 0 ? money(strategyDebitLimit) : '—'} />
            <CompactRiskMetric label="Quantity" value={`${orderQuantity} · plan ${plannedContracts || '—'}`} />
            <CompactRiskMetric label="Invalidation" value={money(setup?.invalidation)} tone="text-rose-200" />
          </div>
        </div>
      </section>
  );
}
