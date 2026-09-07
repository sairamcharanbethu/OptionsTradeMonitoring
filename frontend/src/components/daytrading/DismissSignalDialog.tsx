import {
  Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'dismissSignal' |
  'setDismissSignal' |
  'dismissing' |
  'setup' |
  'dismissStillCurrent' |
  'cancelSetup'
>;

export default function DismissSignalDialog(props: Props) {
  const {
    dismissSignal, setDismissSignal, dismissing, setup, dismissStillCurrent, cancelSetup
  } = props;
  return (
      <Dialog open={!!dismissSignal} onOpenChange={open => !open && !dismissing && setDismissSignal(null)}>
        <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-md border-zinc-800 bg-[#101216] text-zinc-100 sm:w-full">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Dismiss this setup?</DialogTitle>
            <DialogDescription className="text-zinc-500">
              This closes the current setup for your account. You will need to wait for a newly qualified setup before placing an entry.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2.5 text-xs text-amber-200">
            {dismissStillCurrent
              ? 'No broker order will be sent or cancelled. Any existing position remains managed separately.'
              : 'The strategy published a different setup while this confirmation was open. Close this dialog and review the new setup.'}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDismissSignal(null)} disabled={dismissing} className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
              Keep setup
            </Button>
            <Button onClick={cancelSetup} disabled={dismissing || !dismissStillCurrent} className="bg-zinc-200 font-semibold text-zinc-950 hover:bg-white">
              {dismissing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Dismiss setup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
