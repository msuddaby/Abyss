import { create } from 'zustand';
import api from '../services/api.js';
import { getConnection } from '../services/signalr.js';
import type { WatchParty, QueueItem } from '../types/index.js';

interface WatchPartyState {
  activeParty: WatchParty | null;
  isBrowsingLibrary: boolean;
  isTunedIn: boolean;

  setActiveParty: (party: WatchParty | null) => void;
  setTunedIn: (val: boolean) => void;
  updatePlaybackState: (timeMs: number, isPlaying: boolean) => void;
  setQueue: (queue: QueueItem[]) => void;
  updateHost: (hostUserId: string) => void;

  startWatchParty: (channelId: string, data: { mediaProviderConnectionId: string; providerItemId: string; itemTitle: string; itemThumbnail?: string; itemDurationMs?: number }) => Promise<void>;
  stopWatchParty: (channelId: string) => Promise<void>;
  fetchWatchParty: (channelId: string) => Promise<void>;
  addToQueue: (channelId: string, data: { providerItemId: string; title: string; thumbnail?: string; durationMs?: number }) => Promise<void>;
  removeFromQueue: (channelId: string, index: number) => Promise<void>;
  reorderQueue: (channelId: string, newOrder: number[]) => Promise<void>;
  transferHost: (channelId: string, newHostUserId: string) => Promise<void>;

  setIsBrowsingLibrary: (val: boolean) => void;
}

export const useWatchPartyStore = create<WatchPartyState>((set, get) => ({
  activeParty: null,
  isBrowsingLibrary: false,
  isTunedIn: true,

  setActiveParty: (party) => set({ activeParty: party, ...(party ? { isTunedIn: true } : {}) }),
  setTunedIn: (val) => set({ isTunedIn: val }),

  updatePlaybackState: (timeMs, isPlaying) => {
    const { activeParty } = get();
    if (!activeParty) return;
    set({ activeParty: { ...activeParty, currentTimeMs: timeMs, isPlaying, lastSyncAt: new Date().toISOString() } });
  },

  setQueue: (queue) => {
    const { activeParty } = get();
    if (!activeParty) return;
    set({ activeParty: { ...activeParty, queue } });
  },

  updateHost: (hostUserId) => {
    const { activeParty } = get();
    if (!activeParty) return;
    set({ activeParty: { ...activeParty, hostUserId } });
  },

  startWatchParty: async (channelId, data) => {
    try {
      const res = await api.post(`/channels/${channelId}/watch-party/start`, data);
      set({ activeParty: res.data });
    } catch (e) {
      console.error('Failed to start watch party:', e);
      throw e;
    }
  },

  stopWatchParty: async (channelId) => {
    try {
      await api.post(`/channels/${channelId}/watch-party/stop`);
      set({ activeParty: null });
    } catch (e) {
      console.error('Failed to stop watch party:', e);
      throw e;
    }
  },

  fetchWatchParty: async (channelId) => {
    try {
      const res = await api.get(`/channels/${channelId}/watch-party`);
      set({ activeParty: res.data || null });
    } catch (e) {
      console.error('Failed to fetch watch party:', e);
    }
  },

  addToQueue: async (channelId, data) => {
    try {
      await api.post(`/channels/${channelId}/watch-party/queue/add`, data);
    } catch (e) {
      console.error('Failed to add to queue:', e);
      throw e;
    }
  },

  removeFromQueue: async (channelId, index) => {
    try {
      await api.post(`/channels/${channelId}/watch-party/queue/remove`, { index });
    } catch (e) {
      console.error('Failed to remove from queue:', e);
      throw e;
    }
  },

  reorderQueue: async (channelId, newOrder) => {
    try {
      await api.post(`/channels/${channelId}/watch-party/queue/reorder`, { newOrder });
    } catch (e) {
      console.error('Failed to reorder queue:', e);
      throw e;
    }
  },

  transferHost: async (channelId, newHostUserId) => {
    try {
      const conn = getConnection();
      await conn.invoke('TransferWatchPartyHost', channelId, newHostUserId);
    } catch (e) {
      console.error('Failed to transfer host:', e);
      throw e;
    }
  },

  setIsBrowsingLibrary: (val) => set({ isBrowsingLibrary: val }),
}));
