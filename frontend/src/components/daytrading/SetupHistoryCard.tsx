import {
  ChevronDown,
  RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import HistorySetupCard from './HistorySetupCard';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'historyExpanded' |
  'setHistoryExpanded' |
  'strategyHistory' |
  'historyLoading' |
  'historyError' |
  'refetchHistory' |
  'lifecycle' |
  'setup'
>;

export default function SetupHistoryCard(props: Props) {
  const {
    historyExpanded, setHistoryExpanded, strategyHistory, historyLoading, historyError, refetchHistory, lifecycle, setup
  } = props;
  return (
        <section id="setup-history" className="min-w-0 scroll-mt-4 rounded-xl border border-zinc-800 bg-[#101216]">
          <div className="hidden p-5 sm:block">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Setup history</div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">Plans, execution and outcome</h3>
          </div>
          <button
            type="button"
            className="flex w-full cursor-pointer items-start justify-between gap-3 p-4 text-left sm:hidden"
            onClick={() => setHistoryExpanded(value => !value)}
            aria-expanded={historyExpanded}
            aria-controls="setup-history-content"
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Setup history</div>
              <h3 className="mt-1 text-base font-semibold text-zinc-100">Plans, execution and outcome</h3>
              <p className="mt-1 text-xs text-zinc-500">Collapsed on mobile · expand for complete lifecycle records.</p>
            </div>
            <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-zinc-500 transition-transform ${historyExpanded ? 'rotate-180' : ''}`} />
          </button>
          <div id="setup-history-content" className={`${historyExpanded ? 'block' : 'hidden'} border-t border-zinc-800 px-4 pb-4 sm:block sm:border-t-0 sm:px-5 sm:pb-5`}>
            <div className="flex justify-end pt-2 sm:pt-0">
              <Button variant="ghost" size="sm" className="h-8 justify-start px-2 text-[10px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" onClick={() => refetchHistory()}>
              <RefreshCw className="mr-1.5 h-3 w-3" /> Refresh history
              </Button>
            </div>
          <div className="mt-2 space-y-2">
            {historyLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map(item => <div key={item} className="h-[4.5rem] animate-pulse rounded-lg bg-zinc-900/70" />)}
              </div>
            ) : historyError ? (
              <div className="rounded-lg border border-rose-500/20 bg-rose-950/10 px-3 py-3 text-xs text-rose-200">
                Strategy history could not be loaded. Refresh after checking Postgres health.
              </div>
            ) : strategyHistory.length > 0 ? (
              strategyHistory.map(setupHistory => <HistorySetupCard key={setupHistory.setup_id} setup={setupHistory} />)
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-8 text-center text-xs text-zinc-500">
                No strategy setups have been recorded yet.
              </div>
            )}
          </div>
          </div>
        </section>
  );
}
