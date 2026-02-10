import { useToastStore } from '../stores/toastStore.js';
import { useServerStore } from '../stores/serverStore.js';
import { useDmStore } from '../stores/dmStore.js';

export interface NotificationData {
  channelId?: string;
  messageId?: string;
  serverId?: string | null;
}

/**
 * Navigate to the channel/DM referenced by notification data.
 */
export function navigateToNotification(data: NotificationData) {
  if (!data.channelId) return;

  if (data.serverId) {
    // Server channel notification
    const { servers, setActiveServer, channels, setActiveChannel } = useServerStore.getState();
    const server = servers.find((s) => s.id === data.serverId);
    if (server) {
      const currentServer = useServerStore.getState().activeServer;
      if (currentServer?.id === server.id) {
        // Already on this server, just switch channel
        const channel = channels.find((c) => c.id === data.channelId);
        if (channel) setActiveChannel(channel);
      } else {
        // Switch server, then find and select channel after channels load
        setActiveServer(server).then(() => {
          const ch = useServerStore.getState().channels.find((c) => c.id === data.channelId);
          if (ch) useServerStore.getState().setActiveChannel(ch);
        });
      }
    }
    useDmStore.getState().exitDmMode();
  } else {
    // DM notification
    const { dmChannels, setActiveDmChannel, enterDmMode } = useDmStore.getState();
    const dm = dmChannels.find((d) => d.id === data.channelId);
    if (dm) {
      enterDmMode();
      setActiveDmChannel(dm);
    }
  }
}

/**
 * Show a desktop notification (Electron only) and always show in-app toast
 * Desktop notification only shows when window is not focused
 */
export const showDesktopNotification = async (
  title: string,
  body: string,
  data?: NotificationData
) => {
  const onAction = data ? () => navigateToNotification(data) : undefined;
  useToastStore.getState().addToast(body, 'info', 4000, onAction, title);

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
 * Set up listener for OS notification clicks (Electron only).
 * Call once at app startup. Returns an unsubscribe function.
 */
export function setupNotificationClickListener(): (() => void) | undefined {
  if (typeof window !== 'undefined' && window.electron?.onNotificationClicked) {
    return window.electron.onNotificationClicked((data: NotificationData) => {
      navigateToNotification(data);
    });
  }
}

/**
 * Check if running in Electron environment
 */
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && !!window.electron;
};
