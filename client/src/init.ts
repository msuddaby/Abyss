// This module MUST be imported before anything that uses @abyss/shared stores/services.
// It initializes the storage adapter and API base URL.
import { setStorage, setApiBase, setOnUnauthorized, useAuthStore, hydrateVoiceStore } from '@abyss/shared';
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

setApiBase(import.meta.env.VITE_API_URL || 'http://localhost:5000');
setOnUnauthorized(() => useAuthStore.getState().logout());

// Listen for OS notification clicks to navigate to the relevant channel
setupNotificationClickListener();
