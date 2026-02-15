import { create } from 'zustand';
import { getStorage } from '../storage.js';

export interface RecentInstance {
  url: string;
  nickname?: string;
  lastAccessed: number;
}

interface ServerConfigState {
  serverUrl: string | null;
  setServerUrl: (url: string) => void;
  clearServerUrl: () => void;
  hasConfigured: boolean;
  recentInstances: RecentInstance[];
  addRecentInstance: (url: string, nickname?: string) => void;
  removeRecentInstance: (url: string) => void;
  updateInstanceNickname: (url: string, nickname: string) => void;
  _hydrated: boolean;
  _hydrate: () => void;
}

let hydrateScheduled = false;

function getRecentInstances(): RecentInstance[] {
  try {
    const storage = getStorage();
    const stored = storage.getItem('recentInstances');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveRecentInstances(instances: RecentInstance[]) {
  try {
    const storage = getStorage();
    storage.setItem('recentInstances', JSON.stringify(instances));
  } catch {
    // Ignore storage errors
  }
}

export const useServerConfigStore = create<ServerConfigState>((set, get) => ({
  serverUrl: null,
  hasConfigured: false,
  recentInstances: [],
  _hydrated: false,
  _hydrate: () => {
    if (get()._hydrated) return;
    try {
      const storage = getStorage();
      const stored = storage.getItem('serverUrl');
      const recent = getRecentInstances();
      set({ serverUrl: stored, hasConfigured: stored !== null, recentInstances: recent, _hydrated: true });
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
    // Add to recent instances
    get().addRecentInstance(trimmed);
  },
  clearServerUrl: () => {
    get()._hydrate(); // Ensure hydrated before clearing
    const storage = getStorage();
    storage.removeItem('serverUrl');
    set({ serverUrl: null, hasConfigured: false });
  },
  addRecentInstance: (url: string, nickname?: string) => {
    get()._hydrate();
    const trimmed = url.trim();
    const recent = get().recentInstances;
    // Remove if already exists
    const filtered = recent.filter((i) => i.url !== trimmed);
    // Add to front with current timestamp
    filtered.unshift({ url: trimmed, nickname, lastAccessed: Date.now() });
    // Keep only last 10
    const limited = filtered.slice(0, 10);
    saveRecentInstances(limited);
    set({ recentInstances: limited });
  },
  removeRecentInstance: (url: string) => {
    get()._hydrate();
    const recent = get().recentInstances.filter((i) => i.url !== url);
    saveRecentInstances(recent);
    set({ recentInstances: recent });
  },
  updateInstanceNickname: (url: string, nickname: string) => {
    get()._hydrate();
    const recent = get().recentInstances.map((i) =>
      i.url === url ? { ...i, nickname } : i
    );
    saveRecentInstances(recent);
    set({ recentInstances: recent });
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
