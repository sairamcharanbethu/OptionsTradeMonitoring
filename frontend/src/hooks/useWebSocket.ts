import { useState, useEffect, useRef, useCallback } from 'react';

interface WebSocketMessage {
    type: string;
    data: any;
}

export const useWebSocket = (url: string = '/api/ws') => {
    const [isConnected, setIsConnected] = useState(false);
    const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
    const ws = useRef<WebSocket | null>(null);
    const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const connect = useCallback(() => {
        // Construct absolute URL if relative
        const wsUrl = url.startsWith('/')
            ? `ws${window.location.protocol === 'https:' ? 's' : ''}://${window.location.host}${url}`
            : url;

        const socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            console.log('WebSocket Connected');
            setIsConnected(true);
        };

        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                setLastMessage(msg);
            } catch (e) {
                console.error('Failed to parse WS message:', e);
            }
        };

        socket.onclose = () => {
            console.log('WebSocket Disconnected');
            setIsConnected(false);
            // Reconnect after 3s
            reconnectTimeout.current = setTimeout(connect, 3000);
        };

        socket.onerror = (error) => {
            console.error('WebSocket Error:', error);
            socket.close();
        };

        ws.current = socket;
    }, [url]);

    useEffect(() => {
        connect();
        return () => {
            if (ws.current) {
                ws.current.close();
            }
            if (reconnectTimeout.current) {
                clearTimeout(reconnectTimeout.current);
            }
        };
    }, [connect]);

    const sendMessage = useCallback((msg: any) => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify(msg));
        }
    }, []);

    return { isConnected, lastMessage, sendMessage };
};
