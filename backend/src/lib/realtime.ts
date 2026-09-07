/**
 * Operator real-time push over the existing /api/ws WebSocket, fanned out
 * across backend instances through a Redis pub/sub channel.
 *
 * Message envelope: { type, data, ts }. Types:
 *   STRATEGY_STATE   — adapter state (same shape as GET /api/signals/strategy-state, minus the kill-switch overlay)
 *   POSITION_UPDATE  — { id, kind: 'quote' | 'lifecycle', ...changed fields }
 *   TRADE_EVENT      — a trade_events row as recorded (event_type, message, metadata, signal_id, position_id, stream_id)
 *   KILL_SWITCH      — { paper?, live } kill-switch status
 *
 * Delivery model:
 *   1. The publishing instance fans out to its OWN sockets immediately (local path).
 *   2. It also publishes the envelope to the Redis channel `realtime:events`
 *      tagged with its instance id; every other instance that is subscribed
 *      fans it out to its own sockets. An instance ignores its own messages
 *      coming back from the channel, so nothing is delivered twice.
 *   3. If Redis is unavailable the local path still runs — the bus only adds
 *      cross-instance reach, it never gates delivery.
 *
 * Publishing must never throw into the trading path: every step is guarded.
 * A message with a userId is delivered only to sockets authenticated as that
 * user (falls back to all sockets when no socket has authenticated yet, so a
 * single-operator install without auth still sees state).
 */
import { randomUUID } from 'crypto';
import { redis } from './redis';

export type RealtimeMessageType = 'STRATEGY_STATE' | 'POSITION_UPDATE' | 'TRADE_EVENT' | 'KILL_SWITCH';

export const REALTIME_CHANNEL = 'realtime:events';

type SocketLike = { readyState: number; send: (payload: string) => void };

/** Minimal pub/sub surface so tests can inject a fake bus. */
export type RealtimeBus = {
  publish: (channel: string, message: string) => Promise<unknown> | unknown;
  subscribe: (channel: string, onMessage: (message: string) => void, onStatus?: (subscribed: boolean) => void) => (() => Promise<void>) | null;
};

type RealtimeConfig = {
  websocketServer?: { clients: Iterable<SocketLike> } | null;
  getWebsocketServer?: () => { clients: Iterable<SocketLike> } | null | undefined;
  socketUserIds?: Map<any, number> | null;
  log?: { debug?: (msg: string) => void; warn?: (msg: string) => void; info?: (msg: string) => void } | null;
  /** Cross-instance bus. Defaults to the shared Redis client; pass null to disable. */
  bus?: RealtimeBus | null;
};

type BusEnvelope = {
  type: RealtimeMessageType;
  data: unknown;
  ts: string;
  userId: number | null;
  origin: string;
};

const instanceId = randomUUID();
let config: RealtimeConfig = { bus: redis };
let published = 0;          // local socket sends
let busPublished = 0;       // envelopes handed to the bus
let busReceived = 0;        // envelopes fanned out from other instances
let busDropped = 0;         // own echoes / malformed
let busSubscribed = false;
let lastPublishAt: string | null = null;
let unsubscribe: (() => Promise<void>) | null = null;

export function configureRealtime(next: RealtimeConfig): void {
  config = { ...config, ...next };
}

/**
 * Start listening on the bus so envelopes published by other instances reach
 * this instance's sockets. Idempotent. Safe when Redis is absent (no-op).
 */
export function startRealtimeBus(): boolean {
  if (unsubscribe) return true;
  const bus = config.bus;
  if (!bus) return false;
  try {
    const stop = bus.subscribe(REALTIME_CHANNEL, handleBusMessage, (subscribed) => {
      busSubscribed = subscribed;
      config.log?.info?.(`[Realtime] bus ${subscribed ? 'subscribed' : 'disconnected'} (${REALTIME_CHANNEL})`);
    });
    if (!stop) return false;
    unsubscribe = stop;
    return true;
  } catch (err: any) {
    config.log?.warn?.(`[Realtime] bus subscribe failed: ${err?.message || String(err)}`);
    return false;
  }
}

export async function stopRealtimeBus(): Promise<void> {
  const stop = unsubscribe;
  unsubscribe = null;
  busSubscribed = false;
  if (stop) {
    try { await stop(); } catch { /* ignore */ }
  }
}

export function resetRealtimeForTests(): void {
  config = { bus: null };
  published = 0;
  busPublished = 0;
  busReceived = 0;
  busDropped = 0;
  busSubscribed = false;
  lastPublishAt = null;
  unsubscribe = null;
}

export function realtimePublishedCount(): number {
  return published;
}

export function realtimeInstanceId(): string {
  return instanceId;
}

export function getRealtimeHealth() {
  return {
    instanceId,
    channel: REALTIME_CHANNEL,
    busConfigured: Boolean(config.bus),
    busSubscribed,
    localSends: published,
    busPublished,
    busReceived,
    busDropped,
    lastPublishAt,
    lastPublishAgeMs: lastPublishAt ? Math.max(0, Date.now() - new Date(lastPublishAt).getTime()) : null
  };
}

function resolveServer() {
  try {
    return config.getWebsocketServer ? config.getWebsocketServer() : config.websocketServer;
  } catch {
    return null;
  }
}

/** Fan an already-serialised envelope out to this instance's sockets. */
function fanOutLocal(type: RealtimeMessageType, payload: string, targetUserId: number | null): number {
  const server = resolveServer();
  if (!server) return 0;
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
}

function handleBusMessage(message: string): void {
  try {
    const envelope = JSON.parse(message) as BusEnvelope;
    if (!envelope || typeof envelope !== 'object' || envelope.origin === instanceId) {
      busDropped += 1; // our own echo (or garbage): the local path already delivered it
      return;
    }
    const payload = JSON.stringify({ type: envelope.type, data: envelope.data, ts: envelope.ts });
    fanOutLocal(envelope.type, payload, envelope.userId ?? null);
    busReceived += 1;
  } catch (err: any) {
    busDropped += 1;
    config.log?.debug?.(`[Realtime] bus message ignored: ${err?.message || String(err)}`);
  }
}

/**
 * Publish to local sockets and to the cross-instance bus. Returns the number
 * of LOCAL sockets the message was sent to (bus delivery is asynchronous).
 */
export function publishRealtime(type: RealtimeMessageType, data: unknown, options: { userId?: number | null } = {}): number {
  const ts = new Date().toISOString();
  const targetUserId = options.userId != null && Number.isFinite(Number(options.userId)) ? Number(options.userId) : null;
  let sent = 0;
  try {
    lastPublishAt = ts;
    const payload = JSON.stringify({ type, data, ts });
    sent = fanOutLocal(type, payload, targetUserId);
  } catch (err: any) {
    config.log?.debug?.(`[Realtime] publish failed for ${type}: ${err?.message || String(err)}`);
  }
  try {
    const bus = config.bus;
    if (bus) {
      const envelope: BusEnvelope = { type, data, ts, userId: targetUserId, origin: instanceId };
      const result = bus.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
      busPublished += 1;
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((err: any) => config.log?.debug?.(`[Realtime] bus publish failed: ${err?.message || String(err)}`));
      }
    }
  } catch (err: any) {
    config.log?.debug?.(`[Realtime] bus publish failed for ${type}: ${err?.message || String(err)}`);
  }
  return sent;
}
