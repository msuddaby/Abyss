// This module MUST be imported before anything that uses @abyss/shared stores/services.
// It initializes the storage adapter and API base URL.
import { Capacitor } from '@capacitor/core';
import { setStorage, setApiBase, setOnUnauthorized, useAuthStore, hydrateVoiceStore, hydrateTtsUsers, useServerConfigStore } from '@abyss/shared';
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
hydrateTtsUsers();

// Hydrate server config store after storage is initialized
useServerConfigStore.getState()._hydrate();

// Auto-configure for production web deployments only (not mobile, not desktop)
const isProductionWeb = typeof window !== 'undefined' &&
  !window.location.hostname.includes('localhost') &&
  !window.location.hostname.includes('127.0.0.1') &&
  !Capacitor.isNativePlatform() &&
  typeof window.electron === 'undefined';
const storedServerUrl = useServerConfigStore.getState().serverUrl;

// Production web: auto-configure to use current domain (disable server selection)
if (isProductionWeb && !storedServerUrl) {
  // Use empty string for relative paths - automatically uses current domain
  setApiBase('');
  // Mark as configured so the setup modal doesn't show
  useServerConfigStore.setState({ hasConfigured: true });
} else {
  // Development, Mobile & Desktop: allow server selection
  // Server URL priority: stored config > env var > empty (relative paths)
  // Mobile/Desktop apps use VITE_API_URL as default but allow users to change it
  const serverUrl = storedServerUrl ?? import.meta.env.VITE_API_URL ?? '';
  setApiBase(serverUrl);
}

setOnUnauthorized(() => useAuthStore.getState().logout());

// Listen for OS notification clicks to navigate to the relevant channel
if (!Capacitor.isNativePlatform()) {
  setupNotificationClickListener();
} else {
  // Native (Capacitor): adjust layout when software keyboard appears/hides.
  // visualViewport shrinks when the keyboard is visible, so we derive the
  // keyboard height from the difference and push the layout up via CSS var.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const update = () => {
      const kbHeight = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kbHeight}px`);
      document.documentElement.classList.toggle('keyboard-open', kbHeight > 0);
    };
    vv.addEventListener('resize', update);
  }

  // Native (Capacitor): set up push notification tap listeners
  import('./services/pushNotifications').then(({ setupPushNotificationListeners }) => {
    setupPushNotificationListeners();
  });

  // Native (Capacitor): notify the OTA updater that the current bundle is healthy
  import('./services/otaUpdater').then(({ initOtaUpdater }) => {
    initOtaUpdater();
  });
}
