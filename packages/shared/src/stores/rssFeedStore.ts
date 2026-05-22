import { create } from 'zustand';
import api from '../services/api.js';
import type { RssFeedState } from '../types/index.js';

interface ChannelFeedState extends RssFeedState {
  loading: boolean;
}

interface RssFeedStoreState {
  feeds: Record<string, ChannelFeedState>;
  fetchItems: (channelId: string) => Promise<void>;
  forceRefresh: (channelId: string) => Promise<void>;
  applyUpdate: (channelId: string, state: RssFeedState) => void;
  clear: (channelId: string) => void;
}

const empty = (): ChannelFeedState => ({
  items: [],
  lastFetched: null,
  lastError: null,
  loading: false,
});

export const useRssFeedStore = create<RssFeedStoreState>((set, get) => ({
  feeds: {},

  fetchItems: async (channelId) => {
    const existing = get().feeds[channelId];
    set({ feeds: { ...get().feeds, [channelId]: { ...(existing ?? empty()), loading: true } } });
    try {
      const res = await api.get<RssFeedState>(`/channels/${channelId}/rss`);
      set({
        feeds: {
          ...get().feeds,
          [channelId]: { ...res.data, loading: false },
        },
      });
    } catch (e) {
      console.error('RSS fetch failed', e);
      set({
        feeds: {
          ...get().feeds,
          [channelId]: { ...(get().feeds[channelId] ?? empty()), loading: false, lastError: 'Failed to load feed' },
        },
      });
    }
  },

  forceRefresh: async (channelId) => {
    const existing = get().feeds[channelId] ?? empty();
    set({ feeds: { ...get().feeds, [channelId]: { ...existing, loading: true } } });
    try {
      const res = await api.post<RssFeedState>(`/channels/${channelId}/rss/refresh`);
      set({
        feeds: {
          ...get().feeds,
          [channelId]: { ...res.data, loading: false },
        },
      });
    } catch (e) {
      console.error('RSS refresh failed', e);
      set({
        feeds: {
          ...get().feeds,
          [channelId]: { ...(get().feeds[channelId] ?? empty()), loading: false, lastError: 'Refresh failed' },
        },
      });
    }
  },

  applyUpdate: (channelId, state) => {
    set({
      feeds: {
        ...get().feeds,
        [channelId]: { ...state, loading: false },
      },
    });
  },

  clear: (channelId) => {
    const next = { ...get().feeds };
    delete next[channelId];
    set({ feeds: next });
  },
}));
