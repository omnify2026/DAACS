import { useEffect, useCallback } from 'react';

interface ShortcutConfig {
    /** Ctrl+Enter: Submit/Send */
    onSubmit?: () => void;
    /** Ctrl+B: Toggle sidebar */
    onToggleSidebar?: () => void;
    /** Escape: Cancel/Close */
    onCancel?: () => void;
    /** Ctrl+N: New project */
    onNewProject?: () => void;
    /** Ctrl+/: Focus search */
    onFocusSearch?: () => void;
}

/**
 * 키보드 단축키 훅
 * 
 * @example
 * useKeyboardShortcuts({
 *   onSubmit: () => sendMessage(),
 *   onToggleSidebar: () => setSidebarOpen(!sidebarOpen),
 *   onCancel: () => setDialogOpen(false),
 * });
 */
export function useKeyboardShortcuts(config: ShortcutConfig) {
    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        const { key, ctrlKey, metaKey, target } = event;
        const isMod = ctrlKey || metaKey;

        // Ignore shortcuts when typing in inputs (except specific ones)
        const isInput = target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target as HTMLElement)?.isContentEditable;

        // Ctrl+Enter / Cmd+Enter: Submit
        if (isMod && key === 'Enter' && config.onSubmit) {
            event.preventDefault();
            config.onSubmit();
            return;
        }

        // Escape: Cancel (works even in inputs)
        if (key === 'Escape' && config.onCancel) {
            event.preventDefault();
            config.onCancel();
            return;
        }

        // Skip remaining shortcuts if in input
        if (isInput) return;

        // Ctrl+B / Cmd+B: Toggle sidebar
        if (isMod && key === 'b' && config.onToggleSidebar) {
            event.preventDefault();
            config.onToggleSidebar();
            return;
        }

        // Ctrl+N / Cmd+N: New project
        if (isMod && key === 'n' && config.onNewProject) {
            event.preventDefault();
            config.onNewProject();
            return;
        }

        // Ctrl+/ or Cmd+/: Focus search
        if (isMod && key === '/' && config.onFocusSearch) {
            event.preventDefault();
            config.onFocusSearch();
            return;
        }
    }, [config]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);
}

export default useKeyboardShortcuts;
