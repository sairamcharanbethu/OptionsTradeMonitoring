import {
  CircleAlert,
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
import { isExpiredOption, money } from './terminalModel';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'actionMessage' |
  'paperClosePosition' |
  'setPaperClosePosition' |
  'paperClosing' |
  'paperForceCloseAvailable' |
  'setPaperForceCloseAvailable' |
  'confirmPaperClose'
>;

export default function PaperCloseDialog(props: Props) {
  const {
    actionMessage, paperClosePosition, setPaperClosePosition, paperClosing, paperForceCloseAvailable, setPaperForceCloseAvailable, confirmPaperClose
  } = props;
  return (
      <Dialog open={!!paperClosePosition} onOpenChange={open => {
        if (!open && !paperClosing) {
          setPaperClosePosition(null);
          setPaperForceCloseAvailable(false);
        }
      }}>
        <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-md border-zinc-800 bg-[#101216] text-zinc-100 sm:w-full">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Close this paper position?</DialogTitle>
            <DialogDescription className="text-zinc-500">
              {paperClosePosition && isExpiredOption(paperClosePosition.expiration_date)
                ? 'This expired contract cannot provide a fresh executable IBKR bid. Close it explicitly at the last recorded paper mark.'
                : 'The complete paper quantity will be sold at a fresh IBKR bid and recorded in the system paper ledger.'}
            </DialogDescription>
          </DialogHeader>
          {paperClosePosition && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                Paper account only. No Wealthsimple order will be created, changed or cancelled. The first close attempt requires an IBKR bid no older than 15 seconds.
              </div>
              {paperForceCloseAvailable && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-950/15 px-3 py-2.5 text-xs leading-relaxed text-rose-200">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {isExpiredOption(paperClosePosition.expiration_date)
                    ? 'This contract has expired. Force close records the exit at the latest Redis paper mark, or the stored paper mark when Redis has none. This is ledger recovery, not an executable market price.'
                    : 'Fresh IBKR pricing is unavailable. Force close records the exit at the latest Redis paper mark, or the stored paper mark when Redis has none. This price may not be executable in the market.'}
                </div>
              )}
              {actionMessage?.tone === 'error' && (
                <div className="rounded-lg border border-rose-500/25 bg-rose-950/15 px-3 py-2.5 text-xs leading-relaxed text-rose-200">
                  {actionMessage.text}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Contract</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">
                    {paperClosePosition.symbol} {paperClosePosition.option_type} {money(paperClosePosition.strike_price)}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Quantity</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">{paperClosePosition.quantity}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Entry</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">{money(paperClosePosition.entry_price)}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Latest paper mark</div>
                  <div className="mt-1 font-mono font-semibold text-zinc-100">{money(paperClosePosition.current_price)}</div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => {
              setPaperClosePosition(null);
              setPaperForceCloseAvailable(false);
            }} disabled={paperClosing} className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
              Keep position
            </Button>
            {paperForceCloseAvailable && (
              <Button onClick={() => confirmPaperClose(true)} disabled={paperClosing} className="bg-rose-700 font-semibold text-white hover:bg-rose-600">
                {paperClosing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Force close at paper mark
              </Button>
            )}
            <Button onClick={() => confirmPaperClose(false)} disabled={paperClosing} className="bg-rose-500 font-semibold text-white hover:bg-rose-400">
              {paperClosing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {paperForceCloseAvailable ? 'Retry fresh bid' : 'Close paper position'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
