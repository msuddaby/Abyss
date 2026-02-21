import { FirebaseMessaging } from '@capacitor-firebase/messaging';
import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import { api, useServerStore } from '@abyss/shared';
import { navigateToNotification } from '@abyss/shared/services/electronNotifications';

let currentToken: string | null = null;
let pendingNavigation: { channelId: string; serverId: string | null; messageId?: string } | null = null;

/** Call after servers/channels are loaded to handle a queued notification tap */
export function processPendingNotification(): void {
  if (!pendingNavigation) return;
  const data = pendingNavigation;
  pendingNavigation = null;
  console.log('[Push] Processing pending notification:', JSON.stringify(data));
  navigateToNotification(data);
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    console.log('[Push] Starting registration on platform:', Capacitor.getPlatform());
    let permStatus = await PushNotifications.checkPermissions();
    console.log('[Push] Permission status:', permStatus.receive);

    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
      console.log('[Push] Permission after request:', permStatus.receive);
    }

    if (permStatus.receive !== 'granted') {
      console.log('[Push] Permission denied');
      return null;
    }

    // Register with APNS first (required before Firebase can get FCM token)
    console.log('[Push] Registering with APNS...');
    await PushNotifications.register();

    // Get FCM token from Firebase (converts APNS token → FCM token)
    console.log('[Push] Getting FCM token...');
    const { token } = await FirebaseMessaging.getToken();
    console.log('[Push] FCM token:', token?.substring(0, 20) + '...');

    if (!token) {
      console.error('[Push] No FCM token received');
      return null;
    }

    currentToken = token;

    // Register with backend
    console.log('[Push] Registering token with backend...');
    await api.post('/notifications/register-device', {
      token,
      platform: Capacitor.getPlatform(),
    });
    console.log('[Push] Backend registration successful');

    return token;
  } catch (error) {
    console.error('[Push] Failed to register:', error);
    return null;
  }
}

export async function unregisterPushToken(): Promise<void> {
  if (!currentToken) return;

  try {
    await api.delete('/notifications/unregister-device', {
      data: { token: currentToken },
    });
    currentToken = null;
  } catch (error) {
    console.error('[Push] Failed to unregister:', error);
  }
}

export function setupPushNotificationListeners(): void {
  if (!Capacitor.isNativePlatform()) return;

  // Clear badge when app opens / returns to foreground
  PushNotifications.removeAllDeliveredNotifications().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      PushNotifications.removeAllDeliveredNotifications().catch(() => {});
    }
  });

  // Foreground: log only — SignalR toasts handle in-app display
  FirebaseMessaging.addListener('notificationReceived', (notification) => {
    console.log('[Push] Foreground notification received:', JSON.stringify(notification));
  });

  // Tap on notification: navigate to the relevant channel
  FirebaseMessaging.addListener('notificationActionPerformed', (action) => {
    console.log('[Push] Notification tapped:', JSON.stringify(action.notification));
    const data = action.notification.data as Record<string, string>;
    if (data?.channelId) {
      const nav = {
        channelId: data.channelId,
        serverId: data.serverId || null,
        messageId: data.messageId,
      };
      const { servers } = useServerStore.getState();
      if (servers.length === 0) {
        console.log('[Push] Stores not loaded yet, queuing navigation');
        pendingNavigation = nav;
      } else {
        console.log('[Push] Navigating to channel:', nav.channelId, 'server:', nav.serverId);
        navigateToNotification(nav);
      }
    }
  });
}
