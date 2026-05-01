export const storage = {
    get(key: string): string | null {
        try {
            return window.localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key: string, value: string): void {
        try {
            window.localStorage.setItem(key, value);
        } catch {
            // ignore storage failures
        }
    },
    remove(key: string): void {
        try {
            window.localStorage.removeItem(key);
        } catch {
            // ignore storage failures
        }
    },
};
