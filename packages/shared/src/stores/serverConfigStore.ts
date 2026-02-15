import { create } from 'zustand';
import { getStorage } from '../storage.js';

interface ServerConfigState {
  serverUrl: string | null;
  setServerUrl: (url: string) => void;
  clearServerUrl: () => void;
  hasConfigured: boolean;
  _hydrated: boolean;
  _hydrate: () => void;
}

let hydrateScheduled = false;

export const useServerConfigStore = create<ServerConfigState>((set, get) => ({
  serverUrl: null,
  hasConfigured: false,
  _hydrated: false,
  _hydrate: () => {
    if (get()._hydrated) return;
    try {
      const storage = getStorage();
      const stored = storage.getItem('serverUrl');
      set({ serverUrl: stored, hasConfigured: stored !== null, _hydrated: true });
    } catch {
      // Storage not initialized yet, will be hydrated later
      set({ _hydrated: true });
    }
  },
  setServerUrl: (url: string) => {
    get()._hydrate(); // Ensure hydrated before setting
    const trimmed = url.trim();
    const storage = getStorage();
    storage.setItem('serverUrl', trimmed);
    set({ serverUrl: trimmed, hasConfigured: true });
  },
  clearServerUrl: () => {
    get()._hydrate(); // Ensure hydrated before clearing
    const storage = getStorage();
    storage.removeItem('serverUrl');
    set({ serverUrl: null, hasConfigured: false });
  },
}));

// Auto-hydrate on next tick when store is first accessed
const originalSubscribe = useServerConfigStore.subscribe;
useServerConfigStore.subscribe = (...args) => {
  if (!hydrateScheduled && !useServerConfigStore.getState()._hydrated) {
    hydrateScheduled = true;
    queueMicrotask(() => {
      useServerConfigStore.getState()._hydrate();
    });
  }
  return originalSubscribe(...args);
};
