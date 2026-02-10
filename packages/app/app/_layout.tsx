import { useEffect, useState } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { View } from 'react-native';
import { setStorage, setApiBase, setOnUnauthorized, useAuthStore, useServerStore, useUnreadStore, useAppConfigStore, hydrateVoiceStore } from '@abyss/shared';
import { preloadStorage } from '../src/storage';
import { registerForPushNotifications, addNotificationResponseListener, setBadgeCount } from '../src/utils/notifications';
import ToastHost from '../src/components/ToastHost';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const segments = useSegments();
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const initialize = useAuthStore((s) => s.initialize);
  const serverUnreads = useUnreadStore((s) => s.serverUnreads);
  const dmUnreads = useUnreadStore((s) => s.dmUnreads);

  useEffect(() => {
    (async () => {
      const adapter = await preloadStorage();
      setStorage(adapter);
      hydrateVoiceStore();
      setApiBase(Constants.expoConfig?.extra?.apiUrl ?? 'http://localhost:5000');
      setOnUnauthorized(() => useAuthStore.getState().logout());

      // Re-hydrate store state now that storage is available
      await initialize();
      await useAppConfigStore.getState().fetchConfig().catch(() => {});

      setIsReady(true);
      SplashScreen.hideAsync();
    })();
  }, []);

  useEffect(() => {
    if (!isReady) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!token && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (token && inAuthGroup) {
      router.replace('/(main)');
    }
  }, [isReady, token, segments]);

  // Register for push notifications when logged in
  useEffect(() => {
    if (!isReady || !token) return;

    registerForPushNotifications().catch((error) => {
      console.error('Failed to register for push notifications:', error);
    });
  }, [isReady, token]);

  // Listen for notification taps
  useEffect(() => {
    if (!isReady) return;

    const subscription = addNotificationResponseListener((response) => {
      const data = response.notification.request.content.data;
      if (data.type === 'message' && data.channelId) {
        const channelId = data.channelId as string;
        const serverId = data.serverId as string | undefined;

        // Set active server/channel and navigate
        if (serverId) {
          useServerStore.getState().setActiveServer(serverId);
        }
        useServerStore.getState().setActiveChannel(channelId);
        router.push('/(main)');
      }
    });

    return () => subscription.remove();
  }, [isReady]);

  // Update badge count when unreads change
  useEffect(() => {
    if (!isReady || !token) return;

    // Calculate total mention count from all servers and DMs
    let totalMentions = 0;

    serverUnreads.forEach((unread) => {
      totalMentions += unread.mentionCount;
    });

    dmUnreads.forEach((unread) => {
      totalMentions += unread.mentionCount;
    });

    setBadgeCount(totalMentions);
  }, [isReady, token, serverUnreads, dmUnreads]);

  if (!isReady) return null;

  return (
    <View style={{ flex: 1 }}>
      <Slot />
      <ToastHost />
    </View>
  );
}
