import {
  ChevronDown,
  Search
} from 'lucide-react';
import { type Position } from '@/lib/api';
import { PaperActivityTab, PAPER_ACTIVITY_FILTERS, paperRecordLinksToPosition, paperOrderNeedsAttention, paperOrderCashEffect, paperEventCategory, money, number, time, dateTime, duration, humanContractName } from './terminalModel';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'paperActivityTab' |
  'paperActivityFilter' |
  'setPaperActivityFilter' |
  'paperActivitySearch' |
  'setPaperActivitySearch' |
  'strategyState' |
  'paperAccount' |
  'lifecycle' |
  'setup' |
  'option' |
  'executionStatus' |
  'diagnostics' |
  'filteredPaperOrders' |
  'filteredPaperJournal' |
  'filteredPaperPositions' |
  'selectPaperActivityTab'
>;

export default function PaperActivityPanel(props: Props) {
  const {
    paperActivityTab, paperActivityFilter, setPaperActivityFilter, paperActivitySearch, setPaperActivitySearch, strategyState, paperAccount, lifecycle, setup, option, executionStatus, diagnostics, filteredPaperOrders, filteredPaperJournal, filteredPaperPositions, selectPaperActivityTab
  } = props;
  if (!paperAccount) return null;
  return (
          <section className="mt-4 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/30" aria-labelledby="paper-activity-title">
            <div className="border-b border-zinc-800 px-3 py-3 sm:px-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h4 id="paper-activity-title" className="text-sm font-semibold text-zinc-200">Paper activity</h4>
                  <p className="mt-0.5 text-[10px] leading-4 text-zinc-500">Start with a trade, then inspect its linked orders and system events.</p>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-[#0d0f12] p-1" role="tablist" aria-label="Paper activity views">
                  {([
                    ['trades', 'Trade history', paperAccount.recentPositions.length],
                    ['orders', 'Paper orders', paperAccount.recentOrders.length],
                    ['events', 'System events', paperAccount.journal.length]
                  ] as Array<[PaperActivityTab, string, number]>).map(([tab, label, count]) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      id={`paper-tab-${tab}`}
                      aria-controls={`paper-panel-${tab}`}
                      aria-selected={paperActivityTab === tab}
                      className={`min-h-9 rounded-md px-2 text-[10px] font-semibold transition-colors sm:px-3 ${
                        paperActivityTab === tab
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                      }`}
                      onClick={() => selectPaperActivityTab(tab)}
                    >
                      <span className="block sm:inline">{label}</span>
                      <span className="ml-1 font-mono text-[9px] opacity-60">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                  <span className="sr-only">Search paper activity</span>
                  <input
                    value={paperActivitySearch}
                    onChange={event => setPaperActivitySearch(event.target.value)}
                    placeholder="Search contract, trade, setup, or message"
                    className="h-10 w-full rounded-lg border border-zinc-800 bg-[#0d0f12] pl-9 pr-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/15"
                  />
                </label>
                <label>
                  <span className="sr-only">Filter paper activity</span>
                  <select
                    value={paperActivityFilter}
                    onChange={event => setPaperActivityFilter(event.target.value)}
                    className="h-10 w-full rounded-lg border border-zinc-800 bg-[#0d0f12] px-3 text-xs text-zinc-300 outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/15"
                  >
                    {PAPER_ACTIVITY_FILTERS[paperActivityTab].map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

          <section id="paper-panel-orders" className={paperActivityTab === 'orders' ? 'block' : 'hidden'} role="tabpanel" aria-labelledby="paper-tab-orders">
            <div className="flex w-full items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2.5 text-left sm:px-4">
              <div>
                <div className="text-xs font-semibold text-zinc-300">Paper orders</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Entry, trim, and exit instructions with their simulated cash effect</div>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">{filteredPaperOrders.length} shown</span>
            </div>
            <div>
              {filteredPaperOrders.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-zinc-500">No paper orders match the current search and filter.</div>
              ) : (
                <>
                  <div className="divide-y divide-zinc-800 sm:hidden">
                    {filteredPaperOrders.map(order => {
                      const fillPrice = Number(order.fill_price);
                      const limitPrice = Number(order.limit_price);
                      const quantity = Number(order.quantity || 0);
                      const status = String(order.status || 'UNKNOWN').toUpperCase();
                      const cashEffect = paperOrderCashEffect(order);
                      return (
                        <article key={order.id} className="px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-zinc-200">
                                {humanContractName({ strike: order.strike, expiry: order.expiration }, order.option_type)}
                              </div>
                              <div className="mt-1 text-[10px] text-zinc-500">
                                {order.intent.replace(/_/g, ' ')} · {order.action.replace(/_/g, ' ')} · {quantity} contract{quantity === 1 ? '' : 's'}
                              </div>
                              <div className="mt-1 font-mono text-[9px] text-zinc-600">
                                {order.position_id ? `Trade #${order.position_id}` : 'Unlinked trade'}{order.setup_id ? ` · ${order.setup_id}` : ''}
                              </div>
                            </div>
                            <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                              status === 'FILLED'
                                ? 'border-emerald-500/25 bg-emerald-950/20 text-emerald-300'
                                : status === 'PENDING'
                                  ? 'border-amber-500/25 bg-amber-950/20 text-amber-300'
                                : paperOrderNeedsAttention(order)
                                  ? 'border-rose-500/25 bg-rose-950/20 text-rose-300'
                                  : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                            }`}>{status}</span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] text-zinc-400">
                            <div><span className="block text-zinc-600">Limit</span>{Number.isFinite(limitPrice) && limitPrice > 0 ? money(limitPrice) : '—'}</div>
                            <div><span className="block text-zinc-600">Fill</span>{Number.isFinite(fillPrice) && fillPrice > 0 ? money(fillPrice) : '—'}</div>
                            <div><span className="block text-zinc-600">{cashEffect.label}</span>{cashEffect.amount > 0 ? money(cashEffect.amount) : '—'}</div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-zinc-600">
                            <span>{dateTime(order.filled_at || order.updated_at || order.created_at)}</span>
                            <span className="select-all truncate font-mono" title={order.osi_ticker}>{order.osi_ticker}</span>
                          </div>
                          {order.failure_reason && <div className="mt-2 text-[10px] leading-relaxed text-rose-300">{order.failure_reason}</div>}
                        </article>
                      );
                    })}
                  </div>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full min-w-[940px] text-xs">
                      <thead className="bg-zinc-900/45 text-[10px] uppercase tracking-[0.08em] text-zinc-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Time</th>
                          <th className="px-3 py-2 text-left">Intent</th>
                          <th className="px-3 py-2 text-left">Contract</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Limit</th>
                          <th className="px-3 py-2 text-right">Fill</th>
                          <th className="px-3 py-2 text-right">Cash effect</th>
                          <th className="px-3 py-2 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800">
                        {filteredPaperOrders.slice(0, 50).map(order => {
                          const fillPrice = Number(order.fill_price);
                          const limitPrice = Number(order.limit_price);
                          const quantity = Number(order.quantity || 0);
                          const status = String(order.status || 'UNKNOWN').toUpperCase();
                          const cashEffect = paperOrderCashEffect(order);
                          return (
                            <tr key={order.id} className="transition-colors hover:bg-zinc-900/35">
                              <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-zinc-500">{dateTime(order.filled_at || order.updated_at || order.created_at)}</td>
                              <td className="px-3 py-2.5">
                                <div className="font-semibold text-zinc-300">{order.intent.replace(/_/g, ' ')}</div>
                                <div className="mt-0.5 text-[10px] text-zinc-600">{order.action.replace(/_/g, ' ')}</div>
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="font-medium text-zinc-300">{humanContractName({ strike: order.strike, expiry: order.expiration }, order.option_type)}</div>
                                <div className="mt-0.5 max-w-48 select-all truncate font-mono text-[9px] text-zinc-600" title={order.osi_ticker}>{order.osi_ticker}</div>
                                <div className="mt-0.5 max-w-64 select-all truncate font-mono text-[9px] text-zinc-600" title={order.setup_id || undefined}>
                                  {order.position_id ? `Trade #${order.position_id}` : 'Unlinked trade'}{order.setup_id ? ` · ${order.setup_id}` : ''}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-400">{quantity}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-400">{Number.isFinite(limitPrice) && limitPrice > 0 ? money(limitPrice) : '—'}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-300">{Number.isFinite(fillPrice) && fillPrice > 0 ? money(fillPrice) : '—'}</td>
                              <td className="px-3 py-2.5 text-right">
                                <div className="font-mono text-zinc-300">{cashEffect.amount > 0 ? money(cashEffect.amount) : '—'}</div>
                                <div className="mt-0.5 text-[9px] text-zinc-600">{cashEffect.label}</div>
                              </td>
                              <td className={`px-3 py-2.5 text-right font-mono text-[10px] ${status === 'FILLED' ? 'text-emerald-300' : status === 'PENDING' ? 'text-amber-300' : paperOrderNeedsAttention(order) ? 'text-rose-300' : 'text-zinc-500'}`}>{status}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </section>

          <section id="paper-panel-trades" className={paperActivityTab === 'trades' ? 'block' : 'hidden'} role="tabpanel" aria-labelledby="paper-tab-trades">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
              <div>
                <div className="text-xs font-semibold text-zinc-300">Trade history</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">One trade with its decision, orders, lifecycle, risk policy, and outcome</div>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">
                {filteredPaperPositions.length > 25 ? `25 of ${filteredPaperPositions.length} matching` : `${filteredPaperPositions.length} shown`}
              </span>
            </div>
            <div className="p-2 sm:p-3">
              {filteredPaperPositions.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-zinc-500">No paper trades match the current search and filter.</div>
              ) : (
                <div className="space-y-2">
                  {filteredPaperPositions.slice(0, 25).map(position => {
                    const setupId = String(position.strategy_setup_id || '');
                    const relatedOrders = paperAccount.recentOrders.filter(order => paperRecordLinksToPosition(position, order));
                    const relatedJournal = paperAccount.journal.filter(item => paperRecordLinksToPosition(position, item));
                    const attentionOrders = relatedOrders.filter(paperOrderNeedsAttention);
                    const executionStatus = String(position.execution_status || '').toUpperCase();
                    const positionAttention = position.execution_error
                      || (/(REJECTED|FAILED|STALE|UNKNOWN)/.test(executionStatus)
                        ? `Execution state ${executionStatus.replace(/_/g, ' ')}`
                        : null);
                    const initialQuantity = Math.max(1, Number(position.contracts_requested || position.quantity || 1));
                    const entryPrice = Number(position.entry_price || 0);
                    const currentPrice = Number(position.current_price || entryPrice);
                    const isClosed = position.status === 'CLOSED';
                    const tradePnl = isClosed
                      ? Number(position.realized_pnl || 0)
                      : Number(position.realized_pnl || 0) + (currentPrice - entryPrice) * Number(position.quantity || 0) * 100;
                    const baselinePnl = Number(position.baseline_realized_pnl);
                    const hasBaseline = position.baseline_realized_pnl != null && Number.isFinite(baselinePnl);
                    const riskFlags = Array.isArray(position.decision_risk_flags) ? position.decision_risk_flags : [];
                    const evidence = position.decision_evidence && typeof position.decision_evidence === 'object'
                      ? position.decision_evidence
                      : {};
                    const analysis = position.analysis_data && typeof position.analysis_data === 'object'
                      ? position.analysis_data
                      : {};
                    return (
                      <details key={position.id} className="group/trade rounded-lg border border-zinc-800 bg-[#0d0f12]">
                        <summary className="grid cursor-pointer list-none gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-zinc-200">
                                {humanContractName({ strike: position.strike_price, expiry: position.expiration_date }, position.option_type)}
                              </span>
                              <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                                isClosed
                                  ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
                                  : 'border-sky-500/25 bg-sky-950/20 text-sky-300'
                              }`}>{position.status}</span>
                              {(positionAttention || attentionOrders.length > 0) && (
                                <span className="rounded border border-rose-500/25 bg-rose-950/20 px-1.5 py-0.5 text-[9px] font-semibold text-rose-300">Needs attention</span>
                              )}
                            </div>
                            <div className="mt-1 text-[10px] text-zinc-500">
                              {position.decision_source || 'Rules'} · {position.risk_tier || 'bounded'} risk · {String(position.exit_profile || 'balanced T2').replace(/_/g, ' ').toLowerCase()}
                            </div>
                            <div className="mt-1 select-all truncate font-mono text-[9px] text-zinc-600" title={setupId || undefined}>
                              Trade #{position.id}{setupId ? ` · ${setupId}` : ' · no setup id'} · {relatedOrders.length} orders · {relatedJournal.length} events
                            </div>
                          </div>
                          <div className="sm:text-right">
                            <div className={`font-mono text-sm font-semibold ${tradePnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                              {tradePnl >= 0 ? '+' : ''}{money(tradePnl)}
                            </div>
                            <div className="text-[9px] text-zinc-600">{isClosed ? 'realized' : 'unrealized'}</div>
                          </div>
                          <div className="flex items-center justify-between gap-3 sm:justify-end">
                            <span className="font-mono text-[10px] text-zinc-600">{dateTime(position.updated_at || position.created_at)}</span>
                            <ChevronDown className="h-3.5 w-3.5 text-zinc-500 transition-transform group-open/trade:rotate-180" />
                          </div>
                        </summary>
                        <div className="border-t border-zinc-800 p-3">
                          {(positionAttention || attentionOrders.length > 0) && (
                            <div className="mb-3 rounded-lg border border-rose-500/25 bg-rose-950/15 px-3 py-2 text-[10px] leading-5 text-rose-200" role="alert">
                              <div className="font-semibold">Trade attention required</div>
                              {positionAttention && <div>{positionAttention}</div>}
                              {attentionOrders.map(order => (
                                <div key={order.id}>Order #{order.id} · {String(order.status).replace(/_/g, ' ')} · {order.failure_reason || 'No failure reason recorded'}</div>
                              ))}
                            </div>
                          )}
                          <div className="grid gap-3 lg:grid-cols-3">
                            <div className="rounded-lg bg-zinc-950/65 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Execution and outcome</div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] text-zinc-500">
                                <div>Entry <span className="block font-mono text-xs text-zinc-200">{money(entryPrice)}</span></div>
                                <div>{isClosed ? 'Exit' : 'Current'} <span className="block font-mono text-xs text-zinc-200">{money(isClosed ? position.exit_price : currentPrice)}</span></div>
                                <div>Original size <span className="block font-mono text-xs text-zinc-200">{initialQuantity}</span></div>
                                <div>Duration <span className="block font-mono text-xs text-zinc-200">{duration(position.created_at, isClosed ? position.updated_at : null)}</span></div>
                              </div>
                              <div className="mt-2 border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">
                                Exit reason <span className="text-zinc-300">{String(position.exit_reason || 'Position remains open').replace(/_/g, ' ')}</span>
                              </div>
                            </div>

                            <div className="rounded-lg bg-zinc-950/65 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Decision intelligence</div>
                              <div className="mt-2 text-xs leading-relaxed text-zinc-300">
                                {position.decision_rationale || 'No decision rationale was recorded.'}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{position.decision_source || 'RULES'}</span>
                                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{position.ai_requested ? 'AI reviewed' : 'Rules only'}</span>
                                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{String(evidence.strategyState || 'state unavailable')}</span>
                              </div>
                              {riskFlags.length > 0 && (
                                <div className="mt-2 space-y-1 text-[10px] leading-relaxed text-amber-300">
                                  {riskFlags.map((flag, index) => <div key={`${flag}-${index}`}>• {flag}</div>)}
                                </div>
                              )}
                            </div>

                            <div className="rounded-lg bg-zinc-950/65 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Risk policy and baseline</div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] text-zinc-500">
                                <div>Policy <span className="block font-mono text-xs text-zinc-200">{position.policy_version || 'paper-exit-v2'}</span></div>
                                <div>Premium trail <span className="block font-mono text-xs text-zinc-200">{Number(position.decision_trailing_stop_pct || position.trailing_stop_loss_pct || 0) > 0 ? `${number(position.decision_trailing_stop_pct || position.trailing_stop_loss_pct)}%` : '—'}</span></div>
                                <div>Underlying stop <span className="block font-mono text-xs text-rose-200">{money(position.underlying_stop_price || position.suggested_stop_loss)}</span></div>
                                <div>Target 2 <span className="block font-mono text-xs text-sky-200">{money(position.suggested_take_profit_2)}</span></div>
                              </div>
                              <div className="mt-2 border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">
                                1-contract baseline <span className="font-mono text-zinc-300">{hasBaseline ? money(baselinePnl) : '—'}</span>
                                {isClosed && hasBaseline && (
                                  <span className={`ml-2 font-mono ${tradePnl - baselinePnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                    {tradePnl - baselinePnl >= 0 ? '+' : ''}{money(tradePnl - baselinePnl)} sizing value
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-3 lg:grid-cols-[0.75fr_1.25fr]">
                            <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Entry evidence</div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] text-zinc-500">
                                <div>Bid <span className="block font-mono text-zinc-300">{money(evidence.bid)}</span></div>
                                <div>Ask <span className="block font-mono text-zinc-300">{money(evidence.ask)}</span></div>
                                <div>Quote age <span className="block font-mono text-zinc-300">{Number.isFinite(Number(evidence.quoteAgeSeconds)) ? `${number(evidence.quoteAgeSeconds, 1)}s` : '—'}</span></div>
                                <div>Best premium <span className="block font-mono text-zinc-300">{money(analysis.trailingHighPremium || position.trailing_high_price)}</span></div>
                              </div>
                            </div>
                            <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Trade timeline</div>
                                <div className="font-mono text-[9px] text-zinc-600">{relatedOrders.length} orders · {relatedJournal.length} events</div>
                              </div>
                              <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
                                {relatedJournal.length > 0 ? [...relatedJournal].reverse().slice(-12).map(item => (
                                  <div key={item.id} className="grid grid-cols-[4.5rem_1fr] gap-2 text-[10px]">
                                    <span className="font-mono text-zinc-600">{time(item.created_at)}</span>
                                    <span className="leading-relaxed text-zinc-400"><span className="font-semibold text-zinc-300">{item.event_type.replace(/_/g, ' ')}</span> · {item.message}</span>
                                  </div>
                                )) : (
                                  <div className="text-[10px] text-zinc-600">No matching lifecycle events were recorded.</div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Linked paper orders</div>
                              <div className="font-mono text-[9px] text-zinc-600">{relatedOrders.length} total</div>
                            </div>
                            {relatedOrders.length === 0 ? (
                              <div className="mt-2 text-[10px] text-zinc-600">No entry, trim, or exit order is linked to this trade.</div>
                            ) : (
                              <div className="mt-2 divide-y divide-zinc-800">
                                {relatedOrders.map(order => {
                                  const orderStatus = String(order.status || 'UNKNOWN').toUpperCase();
                                  const cashEffect = paperOrderCashEffect(order);
                                  return (
                                    <div key={order.id} className="grid gap-1 py-2 text-[10px] sm:grid-cols-[4.5rem_minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3">
                                      <span className="font-mono text-zinc-600">{time(order.filled_at || order.updated_at || order.created_at)}</span>
                                      <span className="min-w-0 text-zinc-400">
                                        <span className="font-semibold text-zinc-300">#{order.id} · {order.intent.replace(/_/g, ' ')}</span> · {order.action.replace(/_/g, ' ')} · {order.quantity} contract{Number(order.quantity) === 1 ? '' : 's'}
                                        {order.failure_reason && <span className="mt-0.5 block text-rose-300">{order.failure_reason}</span>}
                                      </span>
                                      <span className="font-mono text-zinc-400">{cashEffect.amount > 0 ? money(cashEffect.amount) : cashEffect.label}</span>
                                      <span className={`font-mono ${orderStatus === 'FILLED' ? 'text-emerald-300' : orderStatus === 'PENDING' ? 'text-amber-300' : paperOrderNeedsAttention(order) ? 'text-rose-300' : 'text-zinc-500'}`}>{orderStatus}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section id="paper-panel-events" className={paperActivityTab === 'events' ? 'block' : 'hidden'} role="tabpanel" aria-labelledby="paper-tab-events">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
              <div>
                <div className="text-xs font-semibold text-zinc-300">System events</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Strategy decisions, lifecycle transitions, protection changes, and diagnostics</div>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">{filteredPaperJournal.length} shown</span>
            </div>
            {filteredPaperJournal.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-zinc-500">No system events match the current search and filter.</div>
            ) : (
              <div className="max-h-[32rem] divide-y divide-zinc-800 overflow-y-auto px-3 sm:px-4">
                {filteredPaperJournal.map(item => {
                  const category = paperEventCategory(item.event_type);
                  return (
                    <div key={item.id} className="grid gap-1 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:gap-3">
                      <span className={`font-mono text-[11px] ${category === 'ERROR' ? 'text-rose-300' : 'text-violet-300'}`}>{item.event_type.replace(/_/g, ' ')}</span>
                      <span className="min-w-0 text-xs leading-relaxed text-zinc-300">
                        {item.message}
                        <span className="mt-1 block select-all truncate font-mono text-[9px] text-zinc-600" title={item.setup_id || undefined}>
                          {item.position_id ? `Trade #${item.position_id}` : 'Unlinked event'}{item.setup_id ? ` · ${item.setup_id}` : ''}{item.decision_id ? ` · decision ${item.decision_id}` : ''}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-zinc-500">{dateTime(item.created_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          </section>
  );
}
