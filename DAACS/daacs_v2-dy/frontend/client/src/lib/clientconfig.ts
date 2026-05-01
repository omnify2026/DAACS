export type ClientConfig = {
    apiBaseUrl: string;
    wsBaseUrl: string;
    apiTimeoutMs: number;
};

function parseNumber(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export const clientConfig: ClientConfig = {
    apiBaseUrl: import.meta.env.VITE_DAACS_API_BASE || "/api",
    wsBaseUrl: import.meta.env.VITE_DAACS_WS_BASE || "/ws",
    apiTimeoutMs: parseNumber(import.meta.env.VITE_DAACS_API_TIMEOUT_MS, 30000),
};
