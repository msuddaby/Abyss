import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from '@abyss/shared';

// Configure how notifications are handled when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotifications(): Promise<string | null> {
  try {
    // Request permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Push notification permission denied');
      return null;
    }

    // Get push token
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

    if (!projectId) {
      console.error('Missing Expo project ID - notifications require EAS project');
      return null;
    }

    const pushToken = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    console.log('Push token:', pushToken.data);

    // Register with backend
    await api.post('/notifications/register-device', {
      token: pushToken.data,
      platform: Platform.OS,
    });

    return pushToken.data;
  } catch (error) {
    console.error('Failed to get push token:', error);
    return null;
  }
}

export async function unregisterPushToken(token: string) {
  try {
    await api.delete('/notifications/unregister-device', {
      data: { token },
    });
  } catch (error) {
    console.error('Failed to unregister push token:', error);
  }
}

export async function setBadgeCount(count: number) {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch (error) {
    console.error('Failed to set badge count:', error);
  }
}

export async function clearBadgeCount() {
  await setBadgeCount(0);
}

// Listen for notification taps
export function addNotificationResponseListener(
  callback: (notification: Notifications.NotificationResponse) => void
) {
  return Notifications.addNotificationResponseReceivedListener(callback);
}
