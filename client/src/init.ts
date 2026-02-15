// This module MUST be imported before anything that uses @abyss/shared stores/services.
// It initializes the storage adapter and API base URL.
import { Capacitor } from '@capacitor/core';
import { setStorage, setApiBase, setOnUnauthorized, useAuthStore, hydrateVoiceStore, useServerConfigStore } from '@abyss/shared';
import { setupNotificationClickListener } from '@abyss/shared/services/electronNotifications';

const electronStoreAvailable =
  typeof window !== 'undefined' &&
  !!window.electron?.getStoreItem &&
  !!window.electron?.setStoreItem &&
  !!window.electron?.removeStoreItem;

setStorage({
  getItem: (key) => {
    if (electronStoreAvailable) {
      const stored = window.electron!.getStoreItem(key);
      if (stored !== null) return stored;
      const legacy = localStorage.getItem(key);
      if (legacy !== null) {
        window.electron!.setStoreItem(key, legacy);
      }
      return legacy;
    }
    return localStorage.getItem(key);
  },
  setItem: (key, value) => {
    if (electronStoreAvailable) {
      window.electron!.setStoreItem(key, value);
      return;
    }
    localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (electronStoreAvailable) {
      window.electron!.removeStoreItem(key);
      return;
    }
    localStorage.removeItem(key);
  },
});

hydrateVoiceStore();

// Hydrate server config store after storage is initialized
useServerConfigStore.getState()._hydrate();

// Server URL priority: stored config > env var > empty (relative paths)
// Empty VITE_API_URL = use relative paths (Vite proxy handles /api and /hubs in dev).
const storedServerUrl = useServerConfigStore.getState().serverUrl;
const serverUrl = storedServerUrl ?? import.meta.env.VITE_API_URL ?? '';
setApiBase(serverUrl);
setOnUnauthorized(() => useAuthStore.getState().logout());

// Listen for OS notification clicks to navigate to the relevant channel
if (!Capacitor.isNativePlatform()) {
  setupNotificationClickListener();
} else {
  // Native (Capacitor): set up push notification tap listeners
  import('./services/pushNotifications').then(({ setupPushNotificationListeners }) => {
    setupPushNotificationListeners();
  });

  // Native (Capacitor): notify the OTA updater that the current bundle is healthy
  import('./services/otaUpdater').then(({ initOtaUpdater }) => {
    initOtaUpdater();
  });
}
