import { Link } from 'react-router-dom';
import {
  ChevronDown
} from 'lucide-react';
import DiagnosticRow from './DiagnosticRow';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'services' |
  'healthError' |
  'diagnosticsExpanded' |
  'setDiagnosticsExpanded' |
  'diagnostics'
>;

export default function ServicesCard(props: Props) {
  const {
    services, healthError, diagnosticsExpanded, setDiagnosticsExpanded, diagnostics
  } = props;
  return (
        <section className="rounded-xl border border-zinc-800 bg-[#101216]">
          <div className="hidden p-5 sm:block">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Live diagnostics</div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">Entry-critical services</h3>
          </div>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between gap-3 p-4 text-left sm:hidden"
            onClick={() => setDiagnosticsExpanded(value => !value)}
            aria-expanded={diagnosticsExpanded}
            aria-controls="live-diagnostics-content"
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Live diagnostics</div>
              <h3 className="mt-1 text-base font-semibold text-zinc-100">Entry-critical services</h3>
              <p className="mt-1 text-xs text-zinc-500">Collapsed on mobile · provider-timestamp ages</p>
            </div>
            <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${diagnosticsExpanded ? 'rotate-180' : ''}`} />
          </button>
          <div id="live-diagnostics-content" className={`${diagnosticsExpanded ? 'block' : 'hidden'} border-t border-zinc-800 px-4 pb-4 sm:block sm:border-t-0 sm:px-5 sm:pb-5`}>
            <div className="mt-3 flex justify-end">
              <Link to="/system-health" className="text-[10px] font-semibold text-sky-300 hover:text-sky-200">Full health →</Link>
            </div>
            <div className="mt-1">
              {diagnostics.map(item => <DiagnosticRow key={item.label} {...item} />)}
            </div>
            {healthError && (
              <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-950/10 px-3 py-2 text-xs text-rose-200">
                Health refresh failed: {healthError}
              </div>
            )}
          </div>
        </section>
  );
}
