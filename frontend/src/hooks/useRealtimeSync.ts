import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeRealtime, useRealtimeConnected } from '@/hooks/useWebSocket';
import { QUERY_KEYS } from '@/hooks/useDashboardData';
import { toTradeEventItem, tradeEventStore, useTradeEvents, type TradeEventItem } from '@/hooks/tradeEventStore';
import type { KillSwitchResponse, Position, StrategyEngineState } from '@/lib/api';

export type RealtimeTradeEvent = TradeEventItem;

const MAX_EVENTS = 100;

/**
 * Recent trade events (newest first). Backed by the app-wide trade-event store,
 * which the Decision Log seeds from GET /api/trade-events and this hook appends
 * to from TRADE_EVENT pushes — so consumers see history, not only post-load events.
 */
export function useRecentTradeEvents(): RealtimeTradeEvent[] {
  return useTradeEvents();
}

/**
 * Mount once (AppShell). Applies server pushes to the react-query caches the
 * dashboard and terminal read, so the UI mirrors the system within a second:
 *   STRATEGY_STATE  -> strategyState cache (kill-switch overlay preserved)
 *   POSITION_UPDATE -> patch mark/stop in place (quote) or refetch (lifecycle)
 *   KILL_SWITCH     -> killSwitch cache
 *   TRADE_EVENT     -> recent-events ring buffer + refetch of linked position
 */
export function useRealtimeSync() {
  const queryClient = useQueryClient();
  const isConnected = useRealtimeConnected();
  const [recentEvents, setRecentEvents] = useState<RealtimeTradeEvent[]>([]);
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleInvalidate = () => {
      if (invalidateTimer.current) return;
      invalidateTimer.current = setTimeout(() => {
        invalidateTimer.current = null;
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradeUsage });
      }, 250);
    };

    const unsubscribe = subscribeRealtime((msg) => {
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'STRATEGY_STATE': {
          const incoming = msg.data as StrategyEngineState;
          if (!incoming) return;
          queryClient.setQueryData<StrategyEngineState>(QUERY_KEYS.strategyState, (current) => ({
            ...incoming,
            // A raw push has no kill-switch overlay; keep the last evaluated one.
            entryBlocked: incoming.entryBlocked ?? current?.entryBlocked ?? null,
            entryBlockedReason: incoming.entryBlockedReason ?? current?.entryBlockedReason ?? null
          }));
          return;
        }
        case 'POSITION_UPDATE': {
          const update = msg.data as { id: number; kind?: string; [key: string]: any };
          if (!update?.id) return;
          if (update.kind === 'quote') {
            queryClient.setQueryData<Position[]>(QUERY_KEYS.positions, (current) => {
              if (!current) return current;
              return current.map((position) => Number(position.id) === Number(update.id)
                ? {
                    ...position,
                    current_price: update.current_price != null ? Number(update.current_price) : position.current_price,
                    stop_loss_trigger: update.stop_loss_trigger != null ? Number(update.stop_loss_trigger) : position.stop_loss_trigger,
                    trailing_high_price: update.trailing_high_price != null ? Number(update.trailing_high_price) : position.trailing_high_price,
                    underlying_price: update.underlying_price != null ? Number(update.underlying_price) : position.underlying_price,
                    delta: update.delta != null ? Number(update.delta) : position.delta
                  }
                : position);
            });
          } else {
            scheduleInvalidate();
          }
          return;
        }
        case 'KILL_SWITCH': {
          const incoming = msg.data as Partial<KillSwitchResponse>;
          if (!incoming) return;
          queryClient.setQueryData<KillSwitchResponse>(QUERY_KEYS.killSwitch, (current) => ({
            paper: incoming.paper ?? current?.paper,
            live: incoming.live ?? current?.live
          }) as KillSwitchResponse);
          return;
        }
        case 'TRADE_EVENT': {
          const event = toTradeEventItem(msg.data, msg);
          if (!event) return;
          tradeEventStore.append(event);
          setRecentEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
          if (event.position_id) scheduleInvalidate();
          if (event.event_type === 'SETUP_VETOED' || event.event_type === 'SETUP_VETO_CLEARED') {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.strategyState });
          }
          return;
        }
        default:
          return;
      }
    });

    return () => {
      unsubscribe();
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current);
    };
  }, [queryClient]);

  return { isConnected, recentEvents };
}
