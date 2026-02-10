import { useToastStore } from '../stores/toastStore';

/**
 * Show a desktop notification (Electron only) and always show in-app toast
 * Desktop notification only shows when window is not focused
 */
export const showDesktopNotification = async (
  title: string,
  body: string,
  data?: any
) => {
  // Always show in-app toast notification
  useToastStore.getState().addToast(body, 'info');

  // If running in Electron, also show desktop notification
  if (typeof window !== 'undefined' && window.electron) {
    try {
      const isFocused = await window.electron.isFocused();

      // Only show desktop notification if window is not focused
      if (!isFocused) {
        window.electron.showNotification(title, body, data);
      }
    } catch (error) {
      console.error('[ElectronNotifications] Failed to show notification:', error);
    }
  }
};

/**
 * Check if running in Electron environment
 */
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && !!window.electron;
};
