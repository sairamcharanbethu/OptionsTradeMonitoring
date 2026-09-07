import {
  ChevronDown,
  Loader2,
  RefreshCw,
  ShieldCheck
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { money, number, time, relativeAge } from './terminalModel';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'riskAssessment' |
  'riskLoading' |
  'riskError' |
  'aiReviewExpanded' |
  'setAiReviewExpanded' |
  'settings' |
  'currentSignal' |
  'setup' |
  'snapshotAge' |
  'quoteAge' |
  'gexAge' |
  'entryReviewAvailable' |
  'staleReviewReason' |
  'reviewDataFresh' |
  'runAdHocRiskReview'
>;

export default function AiReviewCard(props: Props) {
  const {
    riskAssessment, riskLoading, riskError, aiReviewExpanded, setAiReviewExpanded, settings, currentSignal, setup, snapshotAge, quoteAge, gexAge, entryReviewAvailable, staleReviewReason, reviewDataFresh, runAdHocRiskReview
  } = props;
  return (
      <section className="rounded-xl border border-zinc-800 bg-[#101216] p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-sky-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Optional AI review
            </div>
            <h3 className="mt-1 text-base font-semibold text-zinc-100">
              {entryReviewAvailable ? 'Explain this setup in plain language' : 'Explain the current directional bias'}
            </h3>
            <p className="mt-1 text-xs text-zinc-500">Runs only when requested. Hard strategy limits remain authoritative.</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {riskAssessment && (
              <Badge variant="outline" className={`font-mono text-2xs ${
                riskAssessment.verdict === 'ALIGNED'
                  ? 'border-emerald-500/30 bg-emerald-950/25 text-emerald-300'
                  : riskAssessment.verdict === 'CONFLICTED'
                    ? 'border-rose-500/30 bg-rose-950/25 text-rose-300'
                    : 'border-amber-500/30 bg-amber-950/25 text-amber-300'
              }`}>
                {riskAssessment.verdict.replace('_', ' ')}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-10 flex-1 border-sky-500/25 bg-sky-950/15 text-xs text-sky-200 hover:bg-sky-950/30 active:translate-y-px sm:h-8 sm:flex-none sm:text-2xs"
              onClick={runAdHocRiskReview}
              disabled={!currentSignal || riskLoading || settings.day_trading_ai_enabled === 'false' || !reviewDataFresh}
              title={staleReviewReason || 'Review the current setup using all available strategy and GEX evidence'}
            >
              {riskLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              {entryReviewAvailable ? 'Review setup with AI' : 'Review bias with AI'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 px-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 sm:h-8"
              onClick={() => setAiReviewExpanded(value => !value)}
              aria-expanded={aiReviewExpanded}
              title={aiReviewExpanded ? 'Hide AI review details' : 'Show AI review details'}
            >
              <span className="sr-only">{aiReviewExpanded ? 'Hide AI review details' : 'Show AI review details'}</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${aiReviewExpanded ? 'rotate-180' : ''}`} />
            </Button>
          </div>
        </div>

        <div className={aiReviewExpanded ? 'block' : 'hidden'}>
        {(!Number.isFinite(quoteAge) || quoteAge > 15) && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-3 text-xs text-amber-200">
            Option quote is stale or missing. AI can explain the directional setup, but its verdict remains WAIT and execution stays blocked.
          </div>
        )}

        {settings.day_trading_ai_enabled === 'false' ? (
          <div className="mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            AI risk management is disabled in Day Trading settings.
          </div>
        ) : staleReviewReason ? (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-3 text-xs text-amber-200">
            AI review is paused: {staleReviewReason}. Wait for fresh strategy data.
          </div>
        ) : riskLoading ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reviewing this setup and its protected risk plan…
          </div>
        ) : riskAssessment ? (
          <>
            <p className="mt-4 text-sm font-medium leading-relaxed text-zinc-200">{riskAssessment.summary}</p>
            <div className="mt-4 divide-y divide-zinc-800 rounded-lg bg-zinc-950/55 px-3">
              {[
                ['Setup', riskAssessment.likelyPath, 'text-sky-300'],
                ['GEX', riskAssessment.gexRead, 'text-sky-300'],
                ['If it works', riskAssessment.ifRight, 'text-emerald-300'],
                ['Failure', riskAssessment.ifWrong, 'text-rose-300']
              ].map(([label, statement, tone]) => (
                <div key={label} className="grid gap-1 py-2.5 sm:grid-cols-[5rem_1fr] sm:gap-3">
                  <div className={`text-2xs font-semibold uppercase tracking-[0.12em] ${tone}`}>{label}</div>
                  <div className="text-xs leading-relaxed text-zinc-300">{statement}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-sky-500/15 bg-sky-950/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs leading-relaxed text-zinc-300"><span className="font-semibold text-sky-200">Safest action:</span> {riskAssessment.action}</div>
              <div className="shrink-0 font-mono text-xs text-zinc-400">
                Max planned debit {riskAssessment.maxPlannedLoss != null ? money(riskAssessment.maxPlannedLoss) : '—'}
              </div>
            </div>
            <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/35">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
                Evidence and risk flags
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="grid gap-3 border-t border-zinc-800 p-3 sm:grid-cols-2">
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-emerald-300">Supporting data</div>
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {riskAssessment.supportingFactors.length > 0
                      ? riskAssessment.supportingFactors.map((item, index) => <div key={`${item}-${index}`}>• {item}</div>)
                      : <div>No additional supporting evidence identified.</div>}
                  </div>
                </div>
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-rose-300">Risk flags</div>
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {riskAssessment.riskFlags.length > 0
                      ? riskAssessment.riskFlags.map((item, index) => <div key={`${item}-${index}`}>• {item}</div>)
                      : <div>No additional risk flags identified.</div>}
                  </div>
                </div>
              </div>
            </details>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs leading-relaxed text-zinc-600">
              <span>Reviewed {time(riskAssessment.generatedAt)}</span>
              <span>Strategy {relativeAge(snapshotAge)}</span>
              <span>GEX {Number.isFinite(gexAge) ? `${number(gexAge, 1)}s old` : 'age unavailable'}</span>
              <span>AI is advisory only.</span>
            </div>
          </>
        ) : (
          <div className={`mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-xs ${riskError ? 'border-rose-500/25 text-rose-200' : 'border-zinc-800 text-zinc-500'}`}>
            {riskError || (currentSignal ? 'No AI review has been requested for this setup.' : 'A persisted strategy setup is required for AI review.')}
          </div>
        )}
        </div>
      </section>
  );
}
