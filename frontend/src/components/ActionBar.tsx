import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, CircleSlash2, Layers3, Power, PowerOff, Radio, RotateCcw, ShieldAlert } from 'lucide-react';
import HoldToConfirmButton from '@/components/HoldToConfirmButton';
import { api, type Position, type User } from '@/lib/api';
import { QUERY_KEYS, useKillSwitch, usePositions, useStrategyState } from '@/hooks/useDashboardData';
import { useRealtimeConnected } from '@/hooks/useWebSocket';
import { StatusChip } from '@/components/ui/semantics';
import { cn } from '@/lib/utils';

/**
 * Operator action bar — visible on every route. One gesture per intervention:
 *   Disarm (click) / Arm (hold)   Shift+D
 *   Flatten all live (hold)       Shift+F
 *   Veto current setup (hold)     Shift+V   (un-veto is a click)
 *   Close this position (hold)    on /positions/:id and /trades/:id/command
 * Destructive actions are hold-to-confirm (~800ms) instead of modal dialogs.
 */


type Tone = 'ok' | 'warn' | 'error' | 'info';
type Toast = { id: number; tone: Tone; text: string };

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export default function ActionBar({ user }: { user: User }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const connected = useRealtimeConnected();
  const { data: killSwitch, isError: killSwitchUnavailable } = useKillSwitch();
  const { data: positions = [] } = usePositions();
  const { data: strategyState } = useStrategyState();
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((tone: Tone, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, text }].slice(-4));
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  const liveOpen = useMemo(
    () => positions.filter((position: Position) => position.status === 'OPEN' && !position.is_simulated && String(position.execution_broker || '') === 'wealthsimple_snaptrade'),
    [positions]
  );

  const routePositionId = useMemo(() => {
    const match = location.pathname.match(/^\/(?:positions|trades)\/(\d+)(?:\/command)?$/);
    return match ? Number(match[1]) : null;
  }, [location.pathname]);
  const routePosition = routePositionId != null
    ? positions.find((position: Position) => Number(position.id) === routePositionId && position.status === 'OPEN')
    : undefined;

  const signal = strategyState?.signal as Record<string, any> | null | undefined;
  const setupId = strategyState?.setupId || null;
  const setupLive = Boolean(setupId) && ['ARMED', 'ACTIVE'].includes(String(signal?.state || '').toUpperCase());
  const setupVetoed = strategyState?.setupVetoed === true;
  const setupLabel = signal?.strategy
    ? `${String(signal.strategy).replace(/_/g, ' ')} ${signal.favoring === 'puts' ? 'PUT' : 'CALL'}`
    : 'no armed setup';

  const live = killSwitch?.live;
  const disarmed = live?.disarmed === true;
  const halted = live?.halted === true;

  const run = useCallback(async (key: string, action: () => Promise<string>, tone: Tone = 'ok') => {
    if (busy) return;
    setBusy(key);
    try {
      const text = await action();
      pushToast(tone, text);
    } catch (err: any) {
      pushToast('error', err?.message || 'Action failed');
    } finally {
      setBusy(null);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.killSwitch });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyState });
    }
  }, [busy, pushToast, queryClient]);

  const disarm = useCallback(() => run('arm', async () => {
    const result = await api.disarmLiveTrading();
    return result.live.disarmed ? 'Live entries disarmed. Open positions keep being managed.' : 'Disarm requested.';
  }, 'warn'), [run]);

  const arm = useCallback(() => run('arm', async () => {
    const result = await api.armLiveTrading();
    return result.live.halted ? `Re-armed, but entries stay halted: ${result.live.reason || 'daily loss limit'}` : 'Live entries re-armed.';
  }, 'ok'), [run]);

  const flatten = useCallback(() => run('flatten', async () => {
    const summary = await api.flattenLivePositions(true);
    const skipped = summary.skipped.length ? ` ${summary.skipped.length} skipped (${summary.skipped.map((s) => `#${s.id}: ${s.reason}`).join('; ')}).` : '';
    return `Flatten: ${summary.submitted}/${summary.requested} MARKET exits submitted.${skipped}${summary.disarmed ? ' Live entries disarmed.' : ''}`;
  }, 'warn'), [run]);

  const veto = useCallback(() => {
    if (!setupId) return;
    return run('veto', async () => {
      await api.vetoSetup(setupId, 'action bar');
      return `Setup ${setupId.slice(0, 8)} vetoed. The engine will not enter it; a new plan gets a new id.`;
    }, 'warn');
  }, [run, setupId]);

  const unveto = useCallback(() => {
    if (!setupId) return;
    return run('veto', async () => {
      await api.unvetoSetup(setupId);
      return `Veto cleared on setup ${setupId.slice(0, 8)}.`;
    }, 'ok');
  }, [run, setupId]);

  const closeRoutePosition = useCallback(() => {
    if (!routePosition) return;
    return run('close', async () => {
      await api.closePosition(Number(routePosition.id));
      return `Close submitted for ${routePosition.symbol} ${routePosition.option_type} ${routePosition.strike_price}.`;
    }, 'warn');
  }, [routePosition, run]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.toUpperCase();
      if (key === 'D') { event.preventDefault(); void (disarmed ? arm() : disarm()); }
      else if (key === 'F') { if (liveOpen.length > 0) { event.preventDefault(); void flatten(); } }
      else if (key === 'V') { if (setupId && setupLive) { event.preventDefault(); void (setupVetoed ? unveto() : veto()); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arm, disarm, disarmed, flatten, liveOpen.length, setupId, setupLive, setupVetoed, unveto, veto]);

  const statusChip = killSwitchUnavailable
    ? { text: 'kill switch unreachable', severity: 'critical' as const }
    : halted && !disarmed
      ? { text: 'halted: loss limit', severity: 'critical' as const }
      : disarmed
        ? { text: 'disarmed', severity: 'warn' as const }
        : { text: 'armed', severity: 'ok' as const };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Operator actions"
        className="fixed inset-x-2 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/95 p-2 shadow-lg backdrop-blur-xl lg:static lg:inset-auto lg:ml-auto lg:w-auto lg:flex-nowrap lg:gap-1.5 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none"
      >
        <span className="flex items-center gap-1.5 pl-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground" title={connected ? 'Live push connected' : 'Reconnecting — falling back to polling'}>
          <Radio className={cn('h-3.5 w-3.5', connected ? 'text-sev-ok-dot' : 'animate-pulse text-sev-warn')} aria-hidden="true" />
          <span className="sr-only lg:not-sr-only">{connected ? 'live' : 'reconnecting'}</span>
        </span>
        <StatusChip severity={statusChip.severity} aria-live="polite">{statusChip.text}</StatusChip>

        {disarmed ? (
          <HoldToConfirmButton label="Arm" hint="Re-arm autonomous live entries" icon={<Power className="h-3.5 w-3.5" />} tone="good" busy={busy === 'arm'} onConfirm={arm} shortcut="Shift+D" />
        ) : (
          <button
            type="button"
            className="flex h-10 min-w-[7.5rem] items-center justify-center gap-1.5 rounded-md border border-transparent bg-act-warn px-3 text-xs font-semibold text-act-warn-fg transition-colors hover:bg-act-warn/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-act-disabled-line disabled:bg-act-disabled-bg disabled:text-act-disabled-fg"
            onClick={disarm}
            disabled={busy !== null}
            title="Disarm autonomous live entries (Shift+D). Exits keep running."
            aria-label="Disarm autonomous live entries, shortcut Shift+D"
          >
            <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{busy === 'arm' ? 'Working…' : 'Disarm'}</span>
          </button>
        )}

        <HoldToConfirmButton
          label="Flatten all"
          hint={`MARKET-exit ${liveOpen.length} open live position${liveOpen.length === 1 ? '' : 's'} and disarm`}
          icon={<ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />}
          tone="danger"
          disabled={liveOpen.length === 0}
          busy={busy === 'flatten'}
          onConfirm={flatten}
          shortcut="Shift+F"
          count={liveOpen.length}
        />

        {setupVetoed ? (
          <button
            type="button"
            className="flex h-10 min-w-[7.5rem] items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-act-disabled-line disabled:bg-act-disabled-bg disabled:text-act-disabled-fg"
            onClick={unveto}
            disabled={busy !== null || !setupId}
            title={`Vetoed: ${setupLabel} · ${setupId?.slice(0, 8)}. Click to clear (Shift+V).`}
            aria-label={`Setup vetoed. Clear the veto on ${setupLabel}, shortcut Shift+V`}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Vetoed · un-veto</span>
          </button>
        ) : (
          <HoldToConfirmButton
            label="Veto setup"
            hint={setupLive ? `Veto ${setupLabel} · ${setupId?.slice(0, 8)}` : 'No armed or active setup to veto'}
            icon={<Ban className="h-3.5 w-3.5" aria-hidden="true" />}
            tone="warn"
            disabled={!setupId || !setupLive}
            busy={busy === 'veto'}
            onConfirm={veto}
            shortcut="Shift+V"
          />
        )}
        {setupLive && !setupVetoed && (
          <span className="hidden truncate text-2xs text-muted-foreground xl:inline" title={setupId || undefined}>
            <Layers3 className="mr-1 inline h-3 w-3" aria-hidden="true" />{setupLabel} · {setupId?.slice(0, 8)}
          </span>
        )}

        {routePosition && (
          <HoldToConfirmButton
            label="Close position"
            hint={`MARKET-close ${routePosition.symbol} ${routePosition.option_type} ${routePosition.strike_price} (${routePosition.quantity})`}
            icon={<CircleSlash2 className="h-3.5 w-3.5" aria-hidden="true" />}
            tone="danger"
            busy={busy === 'close'}
            onConfirm={closeRoutePosition}
          />
        )}
      </div>

      <div className="pointer-events-none fixed inset-x-2 bottom-[calc(8rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-end gap-2 lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-auto" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto max-w-md rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur-xl',
              toast.tone === 'error' ? 'border-sev-critical/40 bg-sev-critical-soft text-sev-critical'
                : toast.tone === 'warn' ? 'border-sev-warn/40 bg-sev-warn-soft text-sev-warn'
                  : toast.tone === 'ok' ? 'border-sev-info/40 bg-sev-info-soft text-sev-info'
                    : 'border-border bg-background/95 text-foreground'
            )}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </>
  );
}
