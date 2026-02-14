import { useEffect, useState } from 'react';

/**
 * Global hook that tracks whether the app window is visible and focused.
 * Combines browser tab visibility (document.hidden) with Electron window focus.
 * Returns true when animations should run, false when they should be paused.
 */
export function useWindowVisibility() {
  const [isVisible, setIsVisible] = useState(() => {
    // Initial state: check if document is visible
    return !document.hidden;
  });

  useEffect(() => {
    let isDocumentVisible = !document.hidden;
    let isWindowFocused = true; // Assume focused initially

    const updateVisibility = () => {
      setIsVisible(isDocumentVisible && isWindowFocused);
    };

    // Browser tab visibility (works in both web and Electron)
    const handleVisibilityChange = () => {
      isDocumentVisible = !document.hidden;
      updateVisibility();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Electron window focus (only in desktop app)
    let unsubscribe: (() => void) | undefined;
    if (window.electron?.onWindowFocusChanged) {
      unsubscribe = window.electron.onWindowFocusChanged((focused: boolean) => {
        isWindowFocused = focused;
        updateVisibility();
      });

      // Get initial focus state
      window.electron.isFocused?.().then((focused: boolean) => {
        isWindowFocused = focused;
        updateVisibility();
      });
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribe?.();
    };
  }, []);

  return isVisible;
}
