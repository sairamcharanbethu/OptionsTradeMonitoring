import { useState, useEffect, useRef, useCallback } from 'react';

interface WebSocketMessage {
    type: string;
    data: any;
}

// Module-level shared states to act as a singleton connection manager
let sharedSocket: WebSocket | null = null;
let isConnectedGlobal = false;
const subscribers = new Set<(msg: WebSocketMessage) => void>();
const statusSubscribers = new Set<(connected: boolean) => void>();
let reconnectTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
let closeTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
let pingInterval: ReturnType<typeof setInterval> | undefined = undefined;

const connectGlobal = (url: string) => {
    if (sharedSocket) return;

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = undefined;
    }
    if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = undefined;
    }

    // Construct absolute URL if relative
    const wsUrl = url.startsWith('/')
        ? `ws${window.location.protocol === 'https:' ? 's' : ''}://${window.location.host}${url}`
        : url;

    console.log('[WebSocket] Connecting to:', wsUrl);
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('[WebSocket] Connected');
        isConnectedGlobal = true;
        statusSubscribers.forEach(cb => cb(true));

        // Start heartbeat ping every 30 seconds to keep the connection alive (avoid reverse proxy timeouts)
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (sharedSocket && sharedSocket.readyState === WebSocket.OPEN) {
                sharedSocket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg && msg.type === 'pong') {
                return; // Heartbeat response, ignore
            }
            subscribers.forEach(cb => cb(msg));
        } catch (e) {
            console.error('[WebSocket] Failed to parse message:', e);
        }
    };

    socket.onclose = () => {
        console.log('[WebSocket] Disconnected');
        isConnectedGlobal = false;
        statusSubscribers.forEach(cb => cb(false));
        sharedSocket = null;

        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = undefined;
        }

        // Only reconnect if there are active subscribers
        if (subscribers.size > 0 || statusSubscribers.size > 0) {
            console.log('[WebSocket] Reconnecting in 3s...');
            reconnectTimeout = setTimeout(() => connectGlobal(url), 3000);
        }
    };

    socket.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        socket.close();
    };

    sharedSocket = socket;
};

const disconnectGlobal = () => {
    if (closeTimeout) {
        clearTimeout(closeTimeout);
    }
    // Delay closing to handle fast tab switching / React dev mode double-mounts
    closeTimeout = setTimeout(() => {
        if (subscribers.size === 0 && statusSubscribers.size === 0 && sharedSocket) {
            console.log('[WebSocket] No active subscribers. Closing connection.');
            sharedSocket.close();
            sharedSocket = null;
            if (pingInterval) {
                clearInterval(pingInterval);
                pingInterval = undefined;
            }
        }
    }, 2000);
};

export const useWebSocket = (url: string = '/api/ws') => {
    const [isConnected, setIsConnected] = useState(isConnectedGlobal);
    const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);

    useEffect(() => {
        const handleMessage = (msg: WebSocketMessage) => {
            setLastMessage(msg);
        };

        const handleStatus = (connected: boolean) => {
            setIsConnected(connected);
        };

        subscribers.add(handleMessage);
        statusSubscribers.add(handleStatus);
        
        // Sync local connection state with global state on mount
        setIsConnected(isConnectedGlobal);

        // Initiate connection
        connectGlobal(url);

        return () => {
            subscribers.delete(handleMessage);
            statusSubscribers.delete(handleStatus);

            if (subscribers.size === 0 && statusSubscribers.size === 0) {
                disconnectGlobal();
            }
        };
    }, [url]);

    const sendMessage = useCallback((msg: any) => {
        if (sharedSocket && sharedSocket.readyState === WebSocket.OPEN) {
            sharedSocket.send(JSON.stringify(msg));
        } else {
            console.warn('[WebSocket] Cannot send message: socket is not open');
        }
    }, []);

    return { isConnected, lastMessage, sendMessage };
};
