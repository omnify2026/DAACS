/**
 * WebSocket Reconnection Utility
 * Provides automatic reconnection logic for WebSocket connections
 */

interface ReconnectingWebSocketOptions {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
}

interface ReconnectingWebSocketResult {
    ws: WebSocket;
    disconnect: () => void;
}

export function createReconnectingWebSocket(
    url: string,
    onMessage: (data: any) => void,
    onError?: (error: Event) => void,
    options: ReconnectingWebSocketOptions = {}
): ReconnectingWebSocketResult {
    const {
        maxAttempts = 10,
        baseDelay = 1000,
        maxDelay = 30000,
    } = options;

    let ws: WebSocket;
    let reconnectAttempts = 0;
    let shouldReconnect = true;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
        ws = new WebSocket(url);

        ws.onopen = () => {
            reconnectAttempts = 0;
            console.log(`[WS] Connected to ${url}`);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                onMessage(data);
            } catch (e) {
                // If not JSON, pass raw data
                onMessage({ type: "error", content: event.data });
            }
        };

        ws.onerror = (error) => {
            console.error(`[WS] Error on ${url}:`, error);
            if (onError) onError(error);
        };

        ws.onclose = () => {
            if (shouldReconnect && reconnectAttempts < maxAttempts) {

                const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), maxDelay);
                reconnectAttempts++;
                console.log(`[WS] Reconnecting to ${url} in ${delay}ms (attempt ${reconnectAttempts}/${maxAttempts})...`);

                reconnectTimeout = setTimeout(connect, delay);
            } else if (reconnectAttempts >= maxAttempts) {
                console.error(`[WS] Max reconnection attempts reached for ${url}`);
            }
        };
    }

    connect();

    return {
        get ws() {
            return ws;
        },
        disconnect: () => {
            shouldReconnect = false;
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            if (ws) {
                ws.close();
            }
        },
    };
}
