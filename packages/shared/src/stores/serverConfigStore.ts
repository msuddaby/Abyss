import { create } from 'zustand';
import { getStorage } from '../storage.js';

interface ServerConfigState {
  serverUrl: string | null;
  setServerUrl: (url: string) => void;
  clearServerUrl: () => void;
  hasConfigured: boolean;
}

export const useServerConfigStore = create<ServerConfigState>((set) => {
  const storage = getStorage();
  const stored = storage.getItem('serverUrl');
  const hasConfigured = stored !== null;

  return {
    serverUrl: stored,
    hasConfigured,
    setServerUrl: (url: string) => {
      const trimmed = url.trim();
      storage.setItem('serverUrl', trimmed);
      set({ serverUrl: trimmed, hasConfigured: true });
    },
    clearServerUrl: () => {
      storage.removeItem('serverUrl');
      set({ serverUrl: null, hasConfigured: false });
    },
  };
});
