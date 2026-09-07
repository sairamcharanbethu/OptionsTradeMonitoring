import {
  Play
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'side' |
  'requestExecution' |
  'lifecycle' |
  'signalDismissed' |
  'executionMode' |
  'canExecute'
>;

export default function ReviewOrderBar(props: Props) {
  const {
    side, requestExecution, lifecycle, signalDismissed, executionMode, canExecute
  } = props;
  if (!(lifecycle === 'ACTIVE' && !signalDismissed && !executionMode.autonomous && canExecute)) return null;
  return (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 rounded-xl border border-zinc-700/90 bg-zinc-950/95 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur md:hidden">
          <Button
            className="h-11 w-full bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500"
            onClick={requestExecution}
          >
            <Play className="mr-2 h-4 w-4" />
            Review {side || ''} order
          </Button>
        </div>
  );
}
