/**
 * Operator real-time push over the existing /api/ws WebSocket.
 *
 * Message envelope: { type, data, ts }. Types:
 *   STRATEGY_STATE   — adapter state (same shape as GET /api/signals/strategy-state, minus the kill-switch overlay)
 *   POSITION_UPDATE  — { id, kind: 'quote' | 'lifecycle', ...changed fields }
 *   TRADE_EVENT      — a trade_events row as recorded (event_type, message, metadata, signal_id, position_id)
 *   KILL_SWITCH      — { paper?, live } kill-switch status
 *
 * Publishing must never throw into the trading path: every send is guarded.
 * A message with a userId is delivered only to sockets authenticated as that
 * user (falls back to all sockets when no socket has authenticated yet, so a
 * single-operator install without auth still sees state).
 */
export type RealtimeMessageType = 'STRATEGY_STATE' | 'POSITION_UPDATE' | 'TRADE_EVENT' | 'KILL_SWITCH';

type SocketLike = { readyState: number; send: (payload: string) => void };

type RealtimeConfig = {
  websocketServer?: { clients: Iterable<SocketLike> } | null;
  getWebsocketServer?: () => { clients: Iterable<SocketLike> } | null | undefined;
  socketUserIds?: Map<any, number> | null;
  log?: { debug?: (msg: string) => void; warn?: (msg: string) => void } | null;
};

let config: RealtimeConfig = {};
let published = 0;

export function configureRealtime(next: RealtimeConfig): void {
  config = { ...config, ...next };
}

export function resetRealtimeForTests(): void {
  config = {};
  published = 0;
}

export function realtimePublishedCount(): number {
  return published;
}

function resolveServer() {
  try {
    return config.getWebsocketServer ? config.getWebsocketServer() : config.websocketServer;
  } catch {
    return null;
  }
}

export function publishRealtime(type: RealtimeMessageType, data: unknown, options: { userId?: number | null } = {}): number {
  try {
    const server = resolveServer();
    if (!server) return 0;
    const payload = JSON.stringify({ type, data, ts: new Date().toISOString() });
    const targetUserId = options.userId != null && Number.isFinite(Number(options.userId)) ? Number(options.userId) : null;
    const userMap = config.socketUserIds || null;
    const anyAuthenticated = Boolean(userMap && userMap.size > 0);
    let sent = 0;
    for (const client of server.clients) {
      if (!client || client.readyState !== 1) continue;
      if (targetUserId !== null && anyAuthenticated) {
        const mapped = userMap!.get(client);
        if (mapped !== targetUserId) continue;
      }
      try {
        client.send(payload);
        sent += 1;
      } catch (err: any) {
        config.log?.debug?.(`[Realtime] send failed for ${type}: ${err?.message || String(err)}`);
      }
    }
    published += sent;
    return sent;
  } catch (err: any) {
    config.log?.debug?.(`[Realtime] publish failed for ${type}: ${err?.message || String(err)}`);
    return 0;
  }
}
