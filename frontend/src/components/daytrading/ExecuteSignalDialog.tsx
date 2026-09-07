import {
  CircleAlert,
  Loader2,
  Play,
  ShieldCheck
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
import { money, number, humanContractName } from './terminalModel';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'executeSignal' |
  'setExecuteSignal' |
  'executing' |
  'lifecycle' |
  'side' |
  'setup' |
  'option' |
  'targets' |
  'executionMode' |
  'orderQuantity' |
  'plannedLimit' |
  'orderDebit' |
  'snapshotAge' |
  'quoteAge' |
  'gexAge' |
  'invalidation' |
  'spreadPct' |
  'approvalSecondsRemaining' |
  'canConfirmExecution' |
  'approvalBlocker' |
  'marketSessionLabel' |
  'confirmExecution'
>;

export default function ExecuteSignalDialog(props: Props) {
  const {
    executeSignal, setExecuteSignal, executing, lifecycle, side, setup, option, targets, executionMode, orderQuantity, plannedLimit, orderDebit, snapshotAge, quoteAge, gexAge, invalidation, spreadPct, approvalSecondsRemaining, canConfirmExecution, approvalBlocker, marketSessionLabel, confirmExecution
  } = props;
  return (
      <Dialog open={!!executeSignal} onOpenChange={open => !open && !executing && setExecuteSignal(null)}>
        <DialogContent className="max-h-[92dvh] w-[calc(100%_-_1.5rem)] max-w-lg overflow-y-auto border-zinc-800 bg-[#101216] text-zinc-100 sm:w-full">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-[-0.02em]">Confirm {executionMode.live ? 'live' : 'simulated'} order</DialogTitle>
            <DialogDescription className="text-zinc-500">
              This is the final manual approval. Market data, lifecycle and risk limits are checked again before submission.
            </DialogDescription>
          </DialogHeader>

          {executeSignal && (
            <div className="space-y-3">
              {executionMode.live && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-200">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  This sends a real order to the selected Wealthsimple account.
                </div>
              )}
              <div className={`rounded-lg border px-3 py-2.5 ${canConfirmExecution ? 'border-emerald-500/20 bg-emerald-950/10' : 'border-rose-500/25 bg-rose-950/10'}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-xs font-semibold ${canConfirmExecution ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {canConfirmExecution ? `Approval data expires in ${approvalSecondsRemaining}s` : 'Order review expired'}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">{marketSessionLabel}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] tabular-nums text-zinc-500">
                  <span>Strategy<br /><span className="text-zinc-300">{number(snapshotAge, 1)}s</span></span>
                  <span>Quote<br /><span className="text-zinc-300">{number(quoteAge, 1)}s · {Number.isFinite(spreadPct) ? `${number(spreadPct)}%` : '—'}</span></span>
                  <span>GEX<br /><span className="text-zinc-300">{number(gexAge, 1)}s</span></span>
                </div>
                {!canConfirmExecution && <div className="mt-2 text-xs leading-relaxed text-rose-200">{approvalBlocker}</div>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Contract</div>
                  <div className="mt-1 text-xs font-semibold text-zinc-100">{humanContractName(option, side)}</div>
                  <div className="mt-1 break-all font-mono text-[9px] text-zinc-600">{option.ticker || option.local_symbol || `SPY ${side}`}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Quantity</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{orderQuantity}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Protected limit ceiling</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{money(plannedLimit)}</div>
                </div>
                <div className="rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Latest estimated debit</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">{money(orderDebit)}</div>
                </div>
                <div className="col-span-2 rounded-lg bg-zinc-950/65 p-3">
                  <div className="text-[10px] text-zinc-500">Strategy protection</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-zinc-100">
                    stop {money(setup?.invalidation || executeSignal.stop_loss)} · target {money(executeSignal.target_price || targets[1] || targets[0])}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Limit order only · quantity and debit remain server-enforced
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setExecuteSignal(null)}
              disabled={executing}
              className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            >
              Back
            </Button>
            <Button
              onClick={confirmExecution}
              disabled={executing || !canConfirmExecution}
              className={executionMode.live
                ? 'bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400'
                : 'bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400'}
            >
              {executing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {!canConfirmExecution ? 'Refresh setup to continue' : executionMode.live ? 'Send live order' : 'Create simulation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
