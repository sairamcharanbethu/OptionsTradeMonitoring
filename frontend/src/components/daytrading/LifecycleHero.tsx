import { Link } from 'react-router-dom';
import {
  Activity,
  ChevronDown,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { money, number, dateTime, relativeAge, toneClasses } from './terminalModel';
import LevelRail from './LevelRail';
import PlannedEntryTicket from './PlannedEntryTicket';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'setDismissSignal' |
  'reconcilingBroker' |
  'positions' |
  'strategySignal' |
  'currentSignal' |
  'lifecycle' |
  'side' |
  'directionConfirmed' |
  'setup' |
  'option' |
  'targets' |
  'strategyBlockers' |
  'executionMode' |
  'plannedContracts' |
  'orderQuantity' |
  'plannedLimit' |
  'orderDebit' |
  'snapshotAge' |
  'quoteAge' |
  'freshSnapshot' |
  'marketDataBlocked' |
  'dismissedActionableSetup' |
  'gexAge' |
  'linkedPosition' |
  'executionStatus' |
  'brokerPositionOpen' |
  'executionBlockers' |
  'strategyCanExecute' |
  'canExecute' |
  'executionSubmitting' |
  'executionStarted' |
  'executionSkipped' |
  'brokerReportsFill' |
  'executionNeedsReview' |
  'displayLifecycle' |
  'lifecycleView' |
  'currentTone' |
  'currentStrategyCode' |
  'currentStrategy' |
  'spot' |
  'vwap' |
  'fiveMinuteStructure' |
  'spotVsVwap' |
  'trigger' |
  'invalidation' |
  'exitTargetNumber' |
  'targetOne' |
  'targetTwo' |
  'hasLevelPlan' |
  'optionSelected' |
  'rewardRisk' |
  'brokerName' |
  'brokerOrderId' |
  'brokerSyncAt' |
  'autonomousResult' |
  'autonomousLastAttemptAt' |
  'executionMessage' |
  'heartbeatSummary' |
  'heartbeatLabel' |
  'marketSessionLabel' |
  'reconcileBrokerOrder' |
  'requestExecution'
>;

export default function LifecycleHero(props: Props) {
  const {
    setDismissSignal, reconcilingBroker, positions, strategySignal, currentSignal, lifecycle, side, directionConfirmed, setup, option, targets, strategyBlockers, executionMode, plannedContracts, orderQuantity, plannedLimit, orderDebit, snapshotAge, quoteAge, freshSnapshot, marketDataBlocked, dismissedActionableSetup, gexAge, linkedPosition, executionStatus, brokerPositionOpen, executionBlockers, strategyCanExecute, canExecute, executionSubmitting, executionStarted, executionSkipped, brokerReportsFill, executionNeedsReview, displayLifecycle, lifecycleView, currentTone, currentStrategyCode, currentStrategy, spot, vwap, fiveMinuteStructure, spotVsVwap, trigger, invalidation, exitTargetNumber, targetOne, targetTwo, hasLevelPlan, optionSelected, rewardRisk, brokerName, brokerOrderId, brokerSyncAt, autonomousResult, autonomousLastAttemptAt, executionMessage, heartbeatSummary, heartbeatLabel, marketSessionLabel, reconcileBrokerOrder, requestExecution
  } = props;
  return (
        <section className={`m-2.5 rounded-xl border p-3.5 sm:m-5 sm:p-6 ${toneClasses[currentTone]}`}>
          <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] opacity-70">{lifecycleView.eyebrow}</span>
                <span className="rounded-md border border-current/20 bg-black/15 px-2 py-1 font-mono text-[10px] font-semibold">{displayLifecycle.replace(/_/g, ' ')}</span>
                {displayLifecycle === 'DISMISSED' && lifecycle === 'ACTIVE' && (
                  <span className="text-[10px] font-medium text-zinc-500">Strategy engine ACTIVE</span>
                )}
                {side && (
                  <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${
                    !directionConfirmed
                      ? 'border-amber-500/20 bg-amber-950/15 text-amber-200'
                      : side === 'CALL'
                        ? 'border-emerald-500/25 bg-emerald-950/30 text-emerald-200'
                        : 'border-rose-500/25 bg-rose-950/30 text-rose-200'
                  }`}>
                    {side}{directionConfirmed ? '' : ' bias'}
                  </span>
                )}
                {currentStrategyCode && (
                  <span className="rounded-md border border-current/15 bg-black/10 px-2 py-1 text-[10px] font-medium">
                    {currentStrategy.name}
                  </span>
                )}
                <a href="#setup-history" className="text-[10px] font-medium text-zinc-500 transition-colors hover:text-zinc-300">History ↓</a>
              </div>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.025em] text-zinc-50 sm:text-3xl">{lifecycleView.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">{lifecycleView.description}</p>
              {(executionStarted || brokerPositionOpen) && (
                <div className={`mt-3 grid gap-2 rounded-lg border px-3 py-2.5 text-xs sm:grid-cols-[1fr_auto] sm:items-center ${
                  executionNeedsReview
                    ? 'border-rose-500/25 bg-rose-950/15'
                    : brokerPositionOpen
                      ? 'border-sky-500/20 bg-sky-950/15'
                      : 'border-amber-500/20 bg-amber-950/10'
                }`}>
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Broker execution</div>
                    <div className="font-semibold text-zinc-200">
                      {brokerPositionOpen
                        ? 'Broker position linked'
                        : executionSkipped
                          ? 'Entry evaluation complete'
                        : executionNeedsReview ? 'Broker-reported fill needs reconciliation' : executionSubmitting ? 'Order submission in progress' : 'Broker confirmation pending'}
                    </div>
                    <div className="mt-1 break-words text-zinc-400">
                      {brokerName} · {executionStatus || (executionStarted ? 'SUBMITTED' : linkedPosition?.status || 'UNKNOWN')}
                      {brokerOrderId ? ` · Order ${brokerOrderId}` : ''}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500 sm:text-right">
                    Status updated {dateTime(brokerSyncAt)}
                  </div>
                  {brokerReportsFill && !brokerPositionOpen && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="border-rose-500/30 bg-rose-950/20 text-rose-100 hover:bg-rose-950/35"
                      onClick={reconcileBrokerOrder}
                      disabled={reconcilingBroker}
                    >
                      {reconcilingBroker ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                      Reconcile now
                    </Button>
                  )}
                </div>
              )}
              {currentStrategyCode && (
                <div className="mt-3 max-w-2xl rounded-lg border border-current/10 bg-black/10 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                  <span className="font-semibold">
                    {directionConfirmed
                      ? `${side === 'CALL' ? 'Bullish' : side === 'PUT' ? 'Bearish' : 'Directional'} alignment:`
                      : `Current ${side === 'CALL' ? 'bullish' : side === 'PUT' ? 'bearish' : 'directional'} bias:`}
                  </span>{' '}{currentStrategy.explanation}
                </div>
              )}

              {hasLevelPlan ? (
                <LevelRail
                  potential={!directionConfirmed}
                  levels={[
                    { label: 'Stop', value: setup?.invalidation, tone: directionConfirmed ? 'text-rose-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-rose-400' : 'bg-zinc-500' },
                    { label: 'Spot', value: strategySignal?.spot, tone: 'text-zinc-100', dot: 'bg-zinc-200' },
                    { label: 'Trigger', value: setup?.trigger, tone: directionConfirmed ? 'text-emerald-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-emerald-400' : 'bg-zinc-500' },
                    { label: 'T1', value: targetOne, tone: directionConfirmed ? 'text-sky-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-sky-400' : 'bg-zinc-500' },
                    { label: `T${exitTargetNumber}`, value: targetTwo, tone: directionConfirmed ? 'text-sky-200' : 'text-zinc-300', dot: directionConfirmed ? 'bg-sky-300' : 'bg-zinc-500' }
                  ]}
                />
              ) : (
                <div className="mt-5 rounded-lg border border-zinc-800/80 bg-black/15 px-3 py-3 sm:mt-6 sm:px-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">No level plan yet</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">
                    {strategyBlockers[0] || 'The strategy is waiting for a qualified directional setup.'}
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-800/70 pt-3 font-mono text-[10px] tabular-nums text-zinc-500">
                    <span>5m structure<br /><span className="text-zinc-300">{fiveMinuteStructure}</span></span>
                    <span>VWAP<br /><span className="text-zinc-300">{Number.isFinite(vwap) ? money(vwap) : 'Unavailable'}</span></span>
                    <span>SPY vs VWAP<br /><span className="text-zinc-300">{spotVsVwap}</span></span>
                  </div>
                </div>
              )}

              <div className="mt-4 rounded-lg border border-zinc-800/80 bg-zinc-950/45 p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${
                        displayLifecycle === 'DISMISSED'
                          ? 'bg-zinc-500'
                        : marketDataBlocked
                          ? 'bg-rose-400'
                          : lifecycle === 'ACTIVE' && strategyCanExecute
                            ? 'animate-pulse bg-emerald-400'
                            : freshSnapshot ? 'bg-amber-400' : 'bg-rose-400'
                      }`} />
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Setup heartbeat</span>
                      <span className={`text-[10px] font-semibold ${
                        dismissedActionableSetup || !strategyCanExecute
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                      }`}>{heartbeatLabel}</span>
                    </div>
                    <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-zinc-300">{heartbeatSummary}</p>
                  </div>
                  <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500 sm:text-right">
                    <span>Strategy {relativeAge(snapshotAge)}</span>
                    <span>Option quote {Number.isFinite(quoteAge) ? `${number(quoteAge, 1)}s` : optionSelected ? 'Unavailable' : 'Not selected'}</span>
                    <span>GEX {Number.isFinite(gexAge) ? `${number(gexAge, 1)}s` : '—'}</span>
                    <span>{directionConfirmed ? 'R/R' : 'Plan R/R'} {Number.isFinite(rewardRisk) ? `${number(rewardRisk)}:1` : '—'}</span>
                  </div>
                </div>
                <div className="mt-2 border-t border-zinc-800/70 pt-2 text-[10px] text-zinc-500">{marketSessionLabel}</div>
              </div>

              {!directionConfirmed && side && (
                <details className="group mt-3 rounded-lg border border-zinc-800/70 bg-black/10">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[10px] font-medium text-zinc-500">
                    Compare CALL and PUT watch levels
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="grid gap-2 border-t border-zinc-800/70 p-2 sm:grid-cols-2">
                    {([
                      ['CALL', strategySignal?.call_setup],
                      ['PUT', strategySignal?.put_setup]
                    ] as const).map(([watchSide, watchSetup]) => (
                      <div key={watchSide} className="rounded-md bg-zinc-950/55 p-2.5">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="font-semibold text-zinc-300">{watchSide}</span>
                          <span className={side === watchSide ? 'text-amber-300' : 'text-zinc-600'}>{side === watchSide ? 'Current bias' : 'Alternate'}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] tabular-nums text-zinc-500">
                          <span>Trigger<br /><span className="text-zinc-300">{money(watchSetup?.trigger)}</span></span>
                          <span>Stop<br /><span className="text-zinc-300">{money(watchSetup?.invalidation)}</span></span>
                          <span>T1<br /><span className="text-zinc-300">{money(watchSetup?.targets?.[0])}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {strategyBlockers.length > 0 && lifecycle !== 'ACTIVE' && (
                <div className="mt-5 rounded-lg border border-amber-500/20 bg-black/15 px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">What is blocking entry</div>
                  <div className="mt-2 space-y-1.5">
                    {strategyBlockers.slice(0, 4).map(blocker => (
                      <div key={blocker} className="flex items-start gap-2 text-xs leading-relaxed text-zinc-300">
                        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span>{blocker}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <aside className="rounded-xl border border-zinc-800/90 bg-black/20 p-3.5 sm:p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Next action</div>
              {dismissedActionableSetup && !brokerPositionOpen ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">No action available</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    This setup is cancelled for your account. The engine may continue tracking it, but it cannot submit an order from this card.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    <Clock3 className="h-4 w-4" />
                    Wait for the next qualified setup
                  </div>
                </>
              ) : executionSkipped ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Wait for the next setup</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    No broker order was placed. The current setup cannot be submitted again.
                  </p>
                  {executionMessage && (
                    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                      {executionMessage}
                    </div>
                  )}
                </>
              ) : executionNeedsReview ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Verify the broker order</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Do not retry this entry until Wealthsimple or SnapTrade confirms whether the order exists.
                  </p>
                  <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-950/15 px-3 py-2 text-xs leading-relaxed text-rose-200">
                    {executionMessage || `Broker status: ${executionStatus || 'unknown'}`}
                  </div>
                </>
              ) : brokerPositionOpen ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Monitor the open position</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    The linked position is active. Entry controls remain closed while its exit policy manages risk.
                  </p>
                  <Link
                    to={`/positions/${linkedPosition?.id}`}
                    className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-lg border border-sky-500/20 bg-sky-950/15 text-xs font-semibold text-sky-200 transition-colors hover:bg-sky-950/30"
                  >
                    Open position details →
                  </Link>
                </>
              ) : executionStarted ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">
                    {executionSubmitting ? 'Order submission in progress' : 'Wait for broker confirmation'}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    {executionSubmitting
                      ? 'StrikePilot is sending the order. Do not retry or place a duplicate manual order.'
                      : 'The order was submitted. Do not place a duplicate manual order while reconciliation is pending.'}
                  </p>
                  <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2 text-xs text-amber-200">
                    {brokerName} · {executionStatus || 'SUBMITTED'}
                  </div>
                </>
              ) : lifecycle === 'ACTIVE' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">
                    {executionMode.autonomous ? 'Autonomous entry evaluation' : 'Review the planned order'}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    {executionMode.autonomous
                      ? 'No click is required. The backend submits one contract only while lifecycle, market window, freshness, quote quality, debit and account risk checks remain valid.'
                      : 'Confirmation remains manual. The backend rechecks lifecycle, freshness, quote quality and debit limits.'}
                  </p>
                  <PlannedEntryTicket
                    option={option}
                    side={side}
                    quantity={orderQuantity}
                    plannedLimit={plannedLimit}
                    orderDebit={orderDebit}
                    quoteAge={quoteAge}
                  />
                  {executionMode.autonomous ? (
                    <div className="mt-5 rounded-lg border border-amber-500/25 bg-amber-950/15 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                      <div>
                        Autonomous entry is evaluating the live risk gates — a passing setup submits a REAL-MONEY broker order
                        with no further confirmation. Use “Disarm live” in the header to stop new entries.
                      </div>
                      {autonomousResult && (
                        <div className="mt-1 text-amber-100">
                          Last evaluation: {autonomousResult}
                          {autonomousLastAttemptAt ? ` · ${dateTime(autonomousLastAttemptAt)}` : ''}
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button
                      className="mt-5 h-11 w-full bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500"
                      onClick={requestExecution}
                      disabled={!canExecute}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      Review order
                    </Button>
                  )}
                  {!canExecute && (
                    <div className="mt-3 space-y-1 text-xs leading-relaxed text-amber-300">
                      {executionBlockers.slice(0, 3).map(blocker => <div key={blocker}>• {blocker}</div>)}
                    </div>
                  )}
                  {currentSignal && !executionMode.autonomous && (
                    <button
                      type="button"
                      onClick={() => setDismissSignal(currentSignal)}
                      className="mt-3 w-full text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      Dismiss this setup
                    </button>
                  )}
                </>
              ) : lifecycle === 'ARMED' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Prepare, but stay flat</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    The contract plan is visible for preparation. Entry remains locked until the lifecycle becomes ACTIVE.
                  </p>
                  {plannedContracts > 0 && (
                    <PlannedEntryTicket
                      option={option}
                      side={side}
                      quantity={orderQuantity}
                      plannedLimit={plannedLimit}
                      orderDebit={orderDebit}
                      quoteAge={quoteAge}
                    />
                  )}
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-950/15 px-3 py-2 text-xs text-amber-200">
                    <Clock3 className="h-4 w-4" />
                    Waiting for ACTIVE confirmation
                  </div>
                </>
              ) : lifecycle === 'MANAGE' || lifecycle === 'EXTENDED' ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">Let the lifecycle manage</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Monitor the protected invalidation and target progression. No second entry is allowed.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-950/20 px-3 py-2 text-xs text-sky-200">
                    <Activity className="h-4 w-4" />
                    Exit monitor active
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 text-lg font-semibold text-zinc-50">No order to review</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    Stay flat until the lifecycle opens a fresh ACTIVE entry window.
                  </p>
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                    <Clock3 className="h-4 w-4" />
                    Waiting automatically
                  </div>
                </>
              )}
            </aside>
          </div>
        </section>
  );
}
