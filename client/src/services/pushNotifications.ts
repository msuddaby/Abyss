import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import { api } from '@abyss/shared';
import { navigateToNotification } from '@abyss/shared/services/electronNotifications';

let currentToken: string | null = null;

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    let permStatus = await PushNotifications.checkPermissions();

    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }

    if (permStatus.receive !== 'granted') {
      console.log('[Push] Permission denied');
      return null;
    }

    // Wait for registration event to get the token
    const token = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 10000);

      PushNotifications.addListener('registration', (result) => {
        clearTimeout(timeout);
        resolve(result.value);
      });

      PushNotifications.addListener('registrationError', (err) => {
        clearTimeout(timeout);
        console.error('[Push] Registration error:', err);
        resolve(null);
      });

      PushNotifications.register();
    });

    if (!token) return null;

    currentToken = token;
    console.log('[Push] Token:', token);

    // Register with backend
    await api.post('/notifications/register-device', {
      token,
      platform: Capacitor.getPlatform(),
    });

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

  // Foreground: no-op — SignalR toasts handle in-app display
  PushNotifications.addListener('pushNotificationReceived', () => {});

  // Tap on notification: navigate to the relevant channel
  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const data = action.notification.data;
    if (data?.channelId) {
      navigateToNotification({
        channelId: data.channelId,
        serverId: data.serverId || null,
        messageId: data.messageId,
      });
    }
  });
}
