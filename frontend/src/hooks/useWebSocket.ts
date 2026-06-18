import { useState, useEffect, useCallback } from 'react';

interface WebSocketMessage {
    type: string;
    data: any;
}

type WebSocketState = {
    sharedSocket: WebSocket | null;
    isConnected: boolean;
    clientId: string;
    subscribers: Set<(msg: WebSocketMessage) => void>;
    statusSubscribers: Set<(connected: boolean) => void>;
    reconnectTimeout?: ReturnType<typeof setTimeout>;
    closeTimeout?: ReturnType<typeof setTimeout>;
    pingInterval?: ReturnType<typeof setInterval>;
};

declare global {
    interface Window {
        __optionsTradeWebSocketState?: WebSocketState;
    }
}

// Browser-level singleton so lazy chunks or mixed import paths still share one socket per tab.
const wsState = window.__optionsTradeWebSocketState ??= {
    sharedSocket: null,
    isConnected: false,
    clientId: window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    subscribers: new Set<(msg: WebSocketMessage) => void>(),
    statusSubscribers: new Set<(connected: boolean) => void>(),
};

const withClientId = (rawUrl: string) => {
    const wsUrl = new URL(rawUrl, window.location.href);
    wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('wsClientId', wsState.clientId);
    return wsUrl.toString();
};

const connectGlobal = (url: string) => {
    if (wsState.sharedSocket) return;

    if (wsState.reconnectTimeout) {
        clearTimeout(wsState.reconnectTimeout);
        wsState.reconnectTimeout = undefined;
    }
    if (wsState.closeTimeout) {
        clearTimeout(wsState.closeTimeout);
        wsState.closeTimeout = undefined;
    }

    // Construct absolute URL if relative
    const wsUrl = withClientId(url);

    console.log('[WebSocket] Connecting to:', wsUrl);
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('[WebSocket] Connected');
        wsState.isConnected = true;
        wsState.statusSubscribers.forEach(cb => cb(true));

        // Start heartbeat ping every 30 seconds to keep the connection alive (avoid reverse proxy timeouts)
        if (wsState.pingInterval) clearInterval(wsState.pingInterval);
        wsState.pingInterval = setInterval(() => {
            if (wsState.sharedSocket && wsState.sharedSocket.readyState === WebSocket.OPEN) {
                wsState.sharedSocket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg && msg.type === 'pong') {
                return; // Heartbeat response, ignore
            }
            wsState.subscribers.forEach(cb => cb(msg));
        } catch (e) {
            console.error('[WebSocket] Failed to parse message:', e);
        }
    };

    socket.onclose = () => {
        console.log('[WebSocket] Disconnected');
        wsState.isConnected = false;
        wsState.statusSubscribers.forEach(cb => cb(false));
        wsState.sharedSocket = null;

        if (wsState.pingInterval) {
            clearInterval(wsState.pingInterval);
            wsState.pingInterval = undefined;
        }

        // Only reconnect if there are active subscribers
        if (wsState.subscribers.size > 0 || wsState.statusSubscribers.size > 0) {
            console.log('[WebSocket] Reconnecting in 3s...');
            wsState.reconnectTimeout = setTimeout(() => connectGlobal(url), 3000);
        }
    };

    socket.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        socket.close();
    };

    wsState.sharedSocket = socket;
};

const disconnectGlobal = () => {
    if (wsState.closeTimeout) {
        clearTimeout(wsState.closeTimeout);
    }
    // Delay closing to handle fast tab switching / React dev mode double-mounts
    wsState.closeTimeout = setTimeout(() => {
        if (wsState.subscribers.size === 0 && wsState.statusSubscribers.size === 0 && wsState.sharedSocket) {
            console.log('[WebSocket] No active subscribers. Closing connection.');
            wsState.sharedSocket.close();
            wsState.sharedSocket = null;
            if (wsState.pingInterval) {
                clearInterval(wsState.pingInterval);
                wsState.pingInterval = undefined;
            }
        }
    }, 2000);
};

export const useWebSocket = (url: string = '/api/ws') => {
    const [isConnected, setIsConnected] = useState(wsState.isConnected);
    const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);

    useEffect(() => {
        const handleMessage = (msg: WebSocketMessage) => {
            setLastMessage(msg);
        };

        const handleStatus = (connected: boolean) => {
            setIsConnected(connected);
        };

        wsState.subscribers.add(handleMessage);
        wsState.statusSubscribers.add(handleStatus);
        
        // Sync local connection state with global state on mount
        setIsConnected(wsState.isConnected);

        // Initiate connection
        connectGlobal(url);

        return () => {
            wsState.subscribers.delete(handleMessage);
            wsState.statusSubscribers.delete(handleStatus);

            if (wsState.subscribers.size === 0 && wsState.statusSubscribers.size === 0) {
                disconnectGlobal();
            }
        };
    }, [url]);

    const sendMessage = useCallback((msg: any) => {
        if (wsState.sharedSocket && wsState.sharedSocket.readyState === WebSocket.OPEN) {
            wsState.sharedSocket.send(JSON.stringify(msg));
        } else {
            console.warn('[WebSocket] Cannot send message: socket is not open');
        }
    }, []);

    return { isConnected, lastMessage, sendMessage };
};
