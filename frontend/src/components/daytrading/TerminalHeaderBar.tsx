import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Bell,
  BellOff,
  CircleAlert,
  CircleCheck,
  RefreshCw
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import CockpitHeader from '@/components/daytrading/CockpitHeader';
import { money, relativeAge } from './terminalModel';
import Metric from './Metric';
import type { DayTradingTerminalModel } from '@/hooks/useDayTradingTerminal';

type Props = Pick<DayTradingTerminalModel,
  'services' |
  'refreshing' |
  'browserAlertsEnabled' |
  'armToggling' |
  'confirmRearm' |
  'isConnected' |
  'strategyState' |
  'settings' |
  'tradeUsage' |
  'killSwitch' |
  'killSwitchUnavailable' |
  'positions' |
  'lifecycle' |
  'setup' |
  'executionMode' |
  'liveKillSwitch' |
  'liveHalted' |
  'liveDisarmed' |
  'handleDisarmLive' |
  'handleArmLive' |
  'snapshotAge' |
  'freshSnapshot' |
  'usageRemaining' |
  'marketSessionLabel' |
  'refreshAll' |
  'toggleBrowserAlerts' |
  'strategyHealth' |
  'ibkrHealth' |
  'systemReady'
>;

export default function TerminalHeaderBar(props: Props) {
  const {
    services, refreshing, browserAlertsEnabled, armToggling, confirmRearm, isConnected, strategyState, settings, tradeUsage, killSwitch, killSwitchUnavailable, positions, lifecycle, setup, executionMode, liveKillSwitch, liveHalted, liveDisarmed, handleDisarmLive, handleArmLive, snapshotAge, freshSnapshot, usageRemaining, marketSessionLabel, refreshAll, toggleBrowserAlerts, strategyHealth, ibkrHealth, systemReady
  } = props;
  return (
    <>
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-3 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Day trading</span>
              <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-2xs text-zinc-300">SPY · signal-only-v2</Badge>
            </div>
            <h1 className="mt-1 hidden text-2xl font-semibold tracking-[-0.03em] text-zinc-50 sm:block">One signal. One decision.</h1>
            <p className="mt-0.5 hidden max-w-2xl text-xs leading-relaxed text-zinc-500 sm:block">
              Follow the strategy lifecycle from setup formation through guarded execution and position management.
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2">
            <Link
              to="/system-health"
              className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 text-2xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 active:translate-y-px sm:w-auto sm:px-3"
              title="System health"
              aria-label="Open system health"
            >
              {systemReady ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" /> : <CircleAlert className="h-3.5 w-3.5 text-amber-400" />}
              <span className="hidden sm:inline">System health</span>
              <ArrowUpRight className="hidden h-3 w-3 sm:block" />
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleBrowserAlerts}
              className="h-9 w-9 border-zinc-800 bg-zinc-950 px-0 text-2xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 active:translate-y-px sm:w-auto sm:px-3"
              title="Notify this browser when a setup becomes ARMED or ACTIVE"
              aria-label={browserAlertsEnabled ? 'Disable setup alerts' : 'Enable setup alerts'}
            >
              {browserAlertsEnabled ? <Bell className="h-3.5 w-3.5 text-emerald-400 sm:mr-1.5" /> : <BellOff className="h-3.5 w-3.5 sm:mr-1.5" />}
              <span className="hidden sm:inline">Alerts</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshAll}
              disabled={refreshing}
              className="h-9 w-9 border-zinc-800 bg-zinc-950 px-0 text-2xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 active:translate-y-px sm:w-auto sm:px-3"
              title="Refresh Day Trading data"
              aria-label="Refresh Day Trading data"
            >
              <RefreshCw className={`h-3.5 w-3.5 sm:mr-2 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </header>

        <CockpitHeader
          strategyState={strategyState}
          killSwitch={killSwitch}
          killSwitchUnavailable={killSwitchUnavailable}
          positions={positions}
          tradeUsage={tradeUsage}
          settings={settings}
          healthy={services ? systemReady : null}
          healthLabel={strategyHealth?.status ? `Strategy engine ${strategyHealth.status}` : undefined}
        />

        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-2xs sm:hidden">
          <span className={freshSnapshot ? 'text-emerald-300' : 'text-amber-300'}>
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current" />
            Strategy {strategyHealth?.status || (freshSnapshot ? 'LIVE' : 'STARTING')}
          </span>
          <span className="font-mono text-zinc-400">Capacity {tradeUsage?.used ?? 0}/{tradeUsage?.max ?? settings.max_trades_per_day ?? 2}</span>
          <span className={services?.scanner?.marketOpen ? 'text-emerald-300' : 'text-zinc-500'}>
            Market {services?.scanner?.marketOpen ? 'open' : 'closed'}
          </span>
        </div>

        <div
          className={`flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-6 ${
            killSwitchUnavailable
              ? 'border-amber-500/40 bg-amber-950/25'
              : liveHalted
                ? 'border-rose-500/40 bg-rose-950/25'
                : executionMode.live
                  ? 'border-amber-500/30 bg-amber-950/15'
                  : 'border-zinc-800 bg-zinc-950/40'
          }`}
          aria-label="Live trading arm state"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              killSwitchUnavailable ? 'bg-amber-400' : liveHalted ? 'bg-rose-400' : executionMode.live ? 'bg-amber-400 animate-pulse' : 'bg-sky-400'
            }`} />
            <div className="min-w-0">
              <div className={`text-2xs font-semibold tracking-wide ${
                killSwitchUnavailable ? 'text-amber-200' : liveHalted ? 'text-rose-200' : executionMode.live ? 'text-amber-200' : 'text-sky-200'
              }`}>
                {killSwitchUnavailable
                  ? 'KILL-SWITCH STATUS UNAVAILABLE — TREATING LIVE ENTRIES AS BLOCKED'
                  : liveDisarmed
                    ? 'LIVE TRADING DISARMED'
                    : liveHalted
                      ? 'LIVE TRADING HALTED'
                      : executionMode.live
                        ? `LIVE ARMED · ${executionMode.label.toUpperCase()}`
                        : 'PAPER / SIMULATION — NO LIVE ORDERS'}
              </div>
              {!killSwitchUnavailable && liveHalted && liveKillSwitch?.reason && (
                <div className="truncate text-2xs text-rose-300/90">{liveKillSwitch.reason}</div>
              )}
              {!killSwitchUnavailable && liveKillSwitch?.enabled && (
                <div className="font-mono text-2xs text-zinc-400">
                  day P&L: realized {money(liveKillSwitch.dayRealizedPnl)} · open {money(liveKillSwitch.dayOpenPnl)} · total {money(liveKillSwitch.dayTotalPnl)} / limit -{money(liveKillSwitch.limit)}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {liveDisarmed ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-act-warn/60 text-2xs text-act-warn hover:bg-act-warn/12"
                onClick={handleArmLive}
                disabled={armToggling || killSwitchUnavailable}
              >
                {confirmRearm ? 'Click again to confirm re-arm' : 'Re-arm live'}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-act-danger/60 text-2xs text-act-danger hover:bg-act-danger/12"
                onClick={handleDisarmLive}
                disabled={armToggling || killSwitchUnavailable}
              >
                Disarm live
              </Button>
            )}
          </div>
        </div>

        <div className="hidden gap-x-4 border-b border-zinc-800 px-6 sm:grid sm:grid-cols-3 lg:grid-cols-6">
          <Metric
            label="Strategy"
            value={strategyHealth?.status || (freshSnapshot ? 'LIVE' : 'STARTING')}
            detail={relativeAge(snapshotAge)}
            tone={freshSnapshot ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="IBKR"
            value={ibkrHealth?.connected ? 'Connected' : 'Unavailable'}
            detail={ibkrHealth?.mode ? `${ibkrHealth.mode} · ${ibkrHealth.port || '—'}` : 'market data'}
            tone={ibkrHealth?.connected ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="Execution"
            value={executionMode.label}
            detail={executionMode.autonomous ? 'one contract per strategy entry' : executionMode.live ? 'manual real orders enabled' : 'no live orders'}
            tone={executionMode.live ? 'text-amber-300' : 'text-sky-300'}
          />
          <Metric
            label="Daily capacity"
            value={`${tradeUsage?.used ?? 0} / ${tradeUsage?.max ?? settings.max_trades_per_day ?? 2}`}
            detail={`${tradeUsage?.remaining ?? 0} remaining`}
            tone={usageRemaining > 0 ? 'text-zinc-100' : 'text-rose-300'}
          />
          <Metric
            label="App updates"
            value={isConnected ? 'Live' : 'Polling'}
            detail={isConnected ? 'socket connected' : 'refresh fallback'}
            tone={isConnected ? 'text-emerald-300' : 'text-amber-300'}
          />
          <Metric
            label="Market"
            value={services?.scanner?.marketOpen ? 'Open' : 'Closed'}
            detail={marketSessionLabel}
            tone={services?.scanner?.marketOpen ? 'text-emerald-300' : 'text-zinc-400'}
          />
        </div>
    </>
  );
}
