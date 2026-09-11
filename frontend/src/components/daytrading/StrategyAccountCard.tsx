import {
  ChevronDown,
  Loader2
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isExpiredOption, money, number, dateTime } from './terminalModel';
import Metric from './Metric';
import PaperActivityPanel from './PaperActivityPanel';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'setActionMessage' |
  'paperUpdating' |
  'setPaperClosePosition' |
  'paperClosing' |
  'setPaperForceCloseAvailable' |
  'paperExpanded' |
  'setPaperExpanded' |
  'paperActivityTab' |
  'paperActivityFilter' |
  'setPaperActivityFilter' |
  'paperActivitySearch' |
  'setPaperActivitySearch' |
  'strategyState' |
  'positions' |
  'paperAccount' |
  'lifecycle' |
  'setup' |
  'option' |
  'executionStatus' |
  'togglePaperAutomation' |
  'diagnostics' |
  'paperUnrealizedPnl' |
  'paperAvailableCash' |
  'filteredPaperOrders' |
  'filteredPaperJournal' |
  'filteredPaperPositions' |
  'selectPaperActivityTab'
>;

export default function StrategyAccountCard(props: Props) {
  const {
    setActionMessage, paperUpdating, setPaperClosePosition, paperClosing, setPaperForceCloseAvailable, paperExpanded, setPaperExpanded, paperActivityTab, paperActivityFilter, setPaperActivityFilter, paperActivitySearch, setPaperActivitySearch, strategyState, positions, paperAccount, lifecycle, setup, option, executionStatus, togglePaperAutomation, diagnostics, paperUnrealizedPnl, paperAvailableCash, filteredPaperOrders, filteredPaperJournal, filteredPaperPositions, selectPaperActivityTab
  } = props;
  if (!(paperAccount)) return null;
  return (
        <section className="overflow-hidden rounded-xl border border-zinc-800 bg-[#101216]">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5 sm:pb-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Day Trading paper controls</span>
                <Badge variant="outline" className={`text-2xs ${
                  paperAccount.strategyAutomationStatus === 'ACTIVE'
                    ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-950/20 text-amber-300'
                }`}>
                  {paperAccount.strategyAutomationStatus}
                </Badge>
                <Badge variant="outline" className="border-zinc-700 bg-zinc-950 text-2xs text-zinc-400">Shared $100k ledger · Paper only</Badge>
              </div>
              <h3 className="mt-1 text-lg font-semibold text-zinc-50">Autonomous strategy account</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-400">
                Trade-first simulation workspace for positions, orders, decisions, and lifecycle evidence. It never enables, disables, or changes Wealthsimple orders.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:bg-zinc-900 sm:hidden"
                onClick={() => setPaperExpanded(value => !value)}
                aria-expanded={paperExpanded}
              >
                {paperExpanded ? 'Hide paper details' : 'Show paper details'}
                <ChevronDown className={`ml-1.5 h-3.5 w-3.5 transition-transform ${paperExpanded ? 'rotate-180' : ''}`} />
              </Button>
              {paperAccount.canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 flex-1 border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:bg-zinc-900 sm:flex-none"
                  onClick={togglePaperAutomation}
                  disabled={paperUpdating}
                >
                  {paperUpdating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {paperAccount.strategyAutomationStatus === 'ACTIVE' ? 'Pause paper entries' : 'Resume paper entries'}
                </Button>
              )}
            </div>
          </div>

          <div className={`${paperExpanded ? 'block' : 'hidden'} border-t border-zinc-800 px-4 pb-4 sm:block sm:px-5 sm:pb-5`}>
          <div className="grid grid-cols-2 gap-x-4 border-b border-zinc-800 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Equity" value={money(paperAccount.account.equity)} detail={`started ${money(paperAccount.account.initial_equity)}`} />
            <Metric label="Available cash" value={money(paperAvailableCash)} detail={`${money(paperAccount.account.cash_balance)} ledger cash`} />
            <Metric label="Reserved cash" value={money(paperAccount.account.reserved_cash)} detail="pending entry orders" />
            <Metric
              label="Today account P&L"
              value={`${paperAccount.session.pnl >= 0 ? '+' : ''}${money(paperAccount.session.pnl)}`}
              detail={`${number(paperAccount.session.pnlPct)}%`}
              tone={paperAccount.session.pnl >= 0 ? 'text-pnl-up' : 'text-pnl-down'}
            />
            <Metric label="Unrealized P&L" value={`${paperUnrealizedPnl >= 0 ? '+' : ''}${money(paperUnrealizedPnl)}`} detail={`${paperAccount.openPositions.length} open positions`} tone={paperUnrealizedPnl >= 0 ? 'text-pnl-up' : 'text-pnl-down'} />
            <Metric label="Paper entries today" value={`${paperAccount.session.entries} · unlimited`} detail={paperAccount.health.lastProcessedAt ? `checked ${dateTime(paperAccount.health.lastProcessedAt)}` : 'waiting for snapshot'} />
          </div>

          <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
              Automation policy and performance comparison
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-zinc-400">
                <span>AI today <span className="font-mono text-zinc-200">{paperAccount.aiUsage.dailyCalls}/{paperAccount.aiUsage.dailyCallLimit}</span></span>
                {paperAccount.aiUsage.dailyAttempts > paperAccount.aiUsage.dailyCalls && (
                  <span className="text-amber-400">
                    Failed reviews <span className="font-mono">{paperAccount.aiUsage.dailyAttempts - paperAccount.aiUsage.dailyCalls}</span>
                    <span className="text-zinc-500"> (attempts {paperAccount.aiUsage.dailyAttempts}/{paperAccount.aiUsage.dailyAttemptLimit})</span>
                  </span>
                )}
                <span>Tokens today <span className="font-mono text-zinc-200">{paperAccount.aiUsage.dailyTokens.toLocaleString()}</span></span>
                <span>Tokens this month <span className="font-mono text-zinc-200">{paperAccount.aiUsage.monthlyTokens.toLocaleString()}</span></span>
                <span>Exit policy <span className="font-mono text-zinc-200">{paperAccount.limits.policyVersion} · {paperAccount.limits.trailingStopPct}%</span></span>
                <span className="text-zinc-500">Clear setups use rules; AI is reserved for ambiguity.</span>
              </div>

              <div className="mt-3 grid grid-cols-3 divide-x divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/35 py-2 text-center">
                <Metric
                  label="Managed realized P&L"
                  value={money(paperAccount.baseline.managedRealizedPnl)}
                  detail="AI/rules exits"
                  tooltip="Realized paper P&L produced by the configured strategy sizing and exit policy."
                  tone={paperAccount.baseline.managedRealizedPnl >= 0 ? 'text-pnl-up' : 'text-pnl-down'}
                />
                <Metric
                  label="1-contract baseline"
                  value={money(paperAccount.baseline.realizedPnl)}
                  detail={`${paperAccount.baseline.closedTrades} closed`}
                  tooltip="Comparison result if each recorded paper setup used one contract."
                  tone={paperAccount.baseline.realizedPnl >= 0 ? 'text-pnl-up' : 'text-pnl-down'}
                />
                <Metric
                  label="Sizing value"
                  value={`${paperAccount.baseline.valueAdded >= 0 ? '+' : ''}${money(paperAccount.baseline.valueAdded)}`}
                  detail="managed − baseline"
                  tooltip="Difference between managed paper P&L and the one-contract comparison baseline."
                  tone={paperAccount.baseline.valueAdded >= 0 ? 'text-pnl-up' : 'text-pnl-down'}
                />
              </div>
            </div>
          </details>

          {paperAccount.openPositions.length > 0 ? (
            <div className="mt-4 space-y-2">
              {paperAccount.openPositions.map(position => {
                const unrealizedPnl = (Number(position.current_price) - Number(position.entry_price)) * Number(position.quantity) * 100;
                return (
                  <div key={position.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/35 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="break-all font-mono text-sm font-semibold text-zinc-100">
                        {position.symbol} {position.option_type} {money(position.strike_price)}
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {position.quantity} contract{Number(position.quantity) === 1 ? '' : 's'} · {position.risk_tier || 'bounded'} risk · {String(position.exit_profile || 'balanced T2').replace(/_/g, ' ').toLowerCase()}
                      </div>
                      <div className="mt-1 text-2xs text-zinc-500">
                        Structural SL → TP1 protection/trim → TP2 · {Number(position.decision_trailing_stop_pct || paperAccount.limits.trailingStopPct)}% premium trail · {position.policy_version || paperAccount.limits.policyVersion}
                      </div>
                      <div className="mt-1 select-all truncate font-mono text-2xs text-zinc-600" title={position.strategy_setup_id || undefined}>
                        Trade #{position.id}{position.strategy_setup_id ? ` · ${position.strategy_setup_id}` : ' · no setup id'}
                      </div>
                    </div>
                    <div className="flex flex-col items-start font-mono text-xs sm:items-end sm:text-right">
                      <div className="text-zinc-300">
                        {money(position.entry_price)} → {money(position.current_price)}
                      </div>
                      <div className={`mt-1 font-semibold ${unrealizedPnl >= 0 ? 'text-pnl-up' : 'text-pnl-down'}`}>
                        Unrealized {unrealizedPnl >= 0 ? '+' : ''}{money(unrealizedPnl)}
                      </div>
                      {paperAccount.canManage && position.paper_strategy !== 'WALL_REACTION' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2 h-8 border-rose-500/25 bg-rose-950/15 px-2.5 text-2xs font-semibold text-rose-200 hover:bg-rose-950/35 hover:text-rose-100"
                          onClick={() => {
                            setActionMessage(null);
                            setPaperForceCloseAvailable(isExpiredOption(position.expiration_date));
                            setPaperClosePosition(position);
                          }}
                          disabled={paperClosing}
                        >
                          Close paper position
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className={`text-right font-mono text-xs font-semibold ${paperUnrealizedPnl >= 0 ? 'text-pnl-up' : 'text-pnl-down'}`}>
                Total unrealized {paperUnrealizedPnl >= 0 ? '+' : ''}{money(paperUnrealizedPnl)}
              </div>
            </div>
          ) : paperAccount.recentDecisions[0] ? (
            <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-xs leading-relaxed text-zinc-300">
              <span className="font-semibold text-zinc-200">Latest decision:</span>{' '}
              {paperAccount.recentDecisions[0].decision} · {paperAccount.recentDecisions[0].source} · {paperAccount.recentDecisions[0].rationale || 'No rationale recorded'}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
              No paper decision yet. The account will evaluate the next fresh ACTIVE setup automatically.
            </div>
          )}

          <PaperActivityPanel
            paperActivityTab={paperActivityTab}
            paperActivityFilter={paperActivityFilter}
            setPaperActivityFilter={setPaperActivityFilter}
            paperActivitySearch={paperActivitySearch}
            setPaperActivitySearch={setPaperActivitySearch}
            strategyState={strategyState}
            paperAccount={paperAccount}
            lifecycle={lifecycle}
            setup={setup}
            option={option}
            executionStatus={executionStatus}
            diagnostics={diagnostics}
            filteredPaperOrders={filteredPaperOrders}
            filteredPaperJournal={filteredPaperJournal}
            filteredPaperPositions={filteredPaperPositions}
            selectPaperActivityTab={selectPaperActivityTab}
          />

          {paperAccount.monthlyReports.length > 0 && (
            <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/30">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-zinc-400">
                Monthly paper performance
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="divide-y divide-zinc-800 border-t border-zinc-800 px-3">
                {paperAccount.monthlyReports.slice(0, 6).map(item => (
                  <div key={item.month} className="grid grid-cols-4 gap-2 py-2.5 font-mono text-2xs text-zinc-400">
                    <span className="text-zinc-200">{item.month}</span>
                    <span>{money(item.report.closingEquity)}</span>
                    <span className={Number(item.report.returnPct) >= 0 ? 'text-pnl-up' : 'text-pnl-down'}>{number(item.report.returnPct)}%</span>
                    <span>{item.report.closedTrades || 0} trades</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          </div>
        </section>
  );
}
