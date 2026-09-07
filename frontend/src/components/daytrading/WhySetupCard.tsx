import {
  Check
} from 'lucide-react';
import { money, number } from './terminalModel';
import Metric from './Metric';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'setup' |
  'confirmations' |
  'primaryGex' |
  'gexAge'
>;

export default function WhySetupCard(props: Props) {
  const {
    setup, confirmations, primaryGex, gexAge
  } = props;
  return (
        <article className="rounded-xl border border-zinc-800 bg-[#101216] p-4 sm:p-5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Why this setup</div>
          <h3 className="mt-1 text-base font-semibold text-zinc-100">Confirmations and GEX context</h3>
          <div className="mt-4 space-y-2">
            {confirmations.length > 0 ? confirmations.slice(0, 5).map((confirmation: any, index: number) => {
              const label = typeof confirmation === 'string'
                ? confirmation
                : confirmation.label || confirmation.name || confirmation.reason || JSON.stringify(confirmation);
              return (
                <div key={`${label}-${index}`} className="flex items-start gap-2 rounded-lg bg-zinc-950/55 px-3 py-2 text-xs text-zinc-300">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="leading-relaxed">{label}</span>
                </div>
              );
            }) : (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center text-xs text-zinc-500">
                Confirmations will appear when a setup is armed.
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-1 border-t border-zinc-800 pt-3 sm:grid-cols-3 sm:gap-2">
            <Metric label="GEX regime" value={String(primaryGex.regime || primaryGex.gamma_regime || '—')} />
            <Metric label="Gamma flip" value={money(primaryGex.flip || primaryGex.gamma_flip)} />
            <Metric label="Provider age" value={Number.isFinite(gexAge) ? `${number(gexAge, 1)}s` : '—'} />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Fresh authoritative GEX is an entry gate. Regime and gamma levels are context unless a confirmation or blocker names them explicitly.
          </p>
        </article>
  );
}
