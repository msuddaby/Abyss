import { useEffect, useState } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { setStorage, setApiBase, setOnUnauthorized, useAuthStore } from '@abyss/shared';
import { preloadStorage } from '../src/storage';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const segments = useSegments();
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    (async () => {
      const adapter = await preloadStorage();
      setStorage(adapter);
      setApiBase(Constants.expoConfig?.extra?.apiUrl ?? 'http://localhost:5000');
      setOnUnauthorized(() => useAuthStore.getState().logout());

      // Re-hydrate store state now that storage is available
      const { token: storedToken } = useAuthStore.getState();
      if (storedToken) {
        await initialize();
      }

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

  if (!isReady) return null;

  return <Slot />;
}
