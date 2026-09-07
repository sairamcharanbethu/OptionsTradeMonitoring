import {
  CircleAlert,
  CircleCheck
} from 'lucide-react';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'actionMessage'
>;

export default function ActionMessageBanner(props: Props) {
  const {
    actionMessage
  } = props;
  if (!(actionMessage)) return null;
  return (
        <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
          actionMessage.tone === 'success'
            ? 'border-emerald-500/25 bg-emerald-950/15 text-emerald-200'
            : 'border-rose-500/25 bg-rose-950/15 text-rose-200'
        }`}>
          {actionMessage.tone === 'success'
            ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
            : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{actionMessage.text}</span>
        </div>
  );
}
