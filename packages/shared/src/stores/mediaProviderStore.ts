import { create } from 'zustand';
import api, { getApiBase } from '../services/api.js';
import { getStorage } from '../storage.js';
import type { MediaProviderConnection, MediaLibrary, MediaItem, PlaybackInfo, YouTubeResolveResult } from '../types/index.js';

function resolveProxyUrls<T extends { thumbnailUrl?: string }>(items: T[]): T[] {
  const base = getApiBase();
  const token = getStorage().getItem('token');
  for (const item of items) {
    if (item.thumbnailUrl?.startsWith('/')) {
      const sep = item.thumbnailUrl.includes('?') ? '&' : '?';
      item.thumbnailUrl = `${base}${item.thumbnailUrl}${token ? `${sep}token=${token}` : ''}`;
    }
  }
  return items;
}

interface MediaProviderState {
  connections: MediaProviderConnection[];
  libraries: MediaLibrary[];
  libraryItems: MediaItem[];
  searchResults: MediaItem[];
  isLoading: boolean;

  fetchConnections: (serverId: string) => Promise<void>;
  linkProvider: (serverId: string, data: { providerType: string; displayName: string; serverUrl: string; authToken: string }) => Promise<void>;
  unlinkProvider: (serverId: string, connectionId: string) => Promise<void>;
  fetchLibraries: (serverId: string, connectionId: string) => Promise<void>;
  fetchLibraryItems: (serverId: string, connectionId: string, libraryId: string) => Promise<void>;
  fetchItemChildren: (serverId: string, connectionId: string, itemId: string) => Promise<MediaItem[]>;
  searchItems: (serverId: string, connectionId: string, query: string, libraryId?: string) => Promise<void>;
  getPlaybackInfo: (serverId: string, connectionId: string, itemId: string) => Promise<PlaybackInfo | null>;
  resolveYouTubeUrl: (serverId: string, url: string) => Promise<YouTubeResolveResult | null>;
  setConnections: (connections: MediaProviderConnection[]) => void;
  addConnection: (connection: MediaProviderConnection) => void;
  removeConnection: (connectionId: string) => void;
  clearLibrary: () => void;
}

export const useMediaProviderStore = create<MediaProviderState>((set) => ({
  connections: [],
  libraries: [],
  libraryItems: [],
  searchResults: [],
  isLoading: false,

  fetchConnections: async (serverId) => {
    try {
      const res = await api.get(`/servers/${serverId}/media-providers`);
      set({ connections: res.data });
    } catch (e) {
      console.error('Failed to fetch media providers:', e);
    }
  },

  linkProvider: async (serverId, data) => {
    set({ isLoading: true });
    try {
      await api.post(`/servers/${serverId}/media-providers/link`, data);
      set({ isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      throw e;
    }
  },

  unlinkProvider: async (serverId, connectionId) => {
    try {
      await api.delete(`/servers/${serverId}/media-providers/${connectionId}`);
      set((s) => ({ connections: s.connections.filter((c) => c.id !== connectionId) }));
    } catch (e) {
      console.error('Failed to unlink provider:', e);
      throw e;
    }
  },

  fetchLibraries: async (serverId, connectionId) => {
    set({ isLoading: true });
    try {
      const res = await api.get(`/servers/${serverId}/media-providers/${connectionId}/libraries`);
      set({ libraries: resolveProxyUrls(res.data), isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      console.error('Failed to fetch libraries:', e);
    }
  },

  fetchLibraryItems: async (serverId, connectionId, libraryId) => {
    set({ isLoading: true });
    try {
      const res = await api.get(`/servers/${serverId}/media-providers/${connectionId}/libraries/${libraryId}/items`);
      set({ libraryItems: resolveProxyUrls(res.data), isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      console.error('Failed to fetch library items:', e);
    }
  },

  fetchItemChildren: async (serverId, connectionId, itemId) => {
    set({ isLoading: true });
    try {
      const res = await api.get(`/servers/${serverId}/media-providers/${connectionId}/items/${encodeURIComponent(itemId)}/children`);
      set({ isLoading: false });
      return resolveProxyUrls(res.data as MediaItem[]);
    } catch (e) {
      set({ isLoading: false });
      console.error('Failed to fetch item children:', e);
      return [];
    }
  },

  searchItems: async (serverId, connectionId, query, libraryId) => {
    set({ isLoading: true });
    try {
      const params: Record<string, string> = { query };
      if (libraryId) params.library = libraryId;
      const res = await api.get(`/servers/${serverId}/media-providers/${connectionId}/search`, { params });
      set({ searchResults: resolveProxyUrls(res.data), isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      console.error('Failed to search items:', e);
    }
  },

  getPlaybackInfo: async (serverId, connectionId, itemId) => {
    try {
      const res = await api.get(`/servers/${serverId}/media-providers/${connectionId}/items/${encodeURIComponent(itemId)}/playback`);
      const playbackInfo = res.data as PlaybackInfo;

      // If URL is relative (proxy), prepend API base and append auth token
      if (playbackInfo.url.startsWith('/')) {
        const token = getStorage().getItem('token');
        const separator = playbackInfo.url.includes('?') ? '&' : '?';
        playbackInfo.url = `${getApiBase()}${playbackInfo.url}${token ? `${separator}token=${token}` : ''}`;
      }

      return playbackInfo;
    } catch (e) {
      console.error('Failed to get playback info:', e);
      return null;
    }
  },

  resolveYouTubeUrl: async (serverId, url) => {
    try {
      const res = await api.get(`/servers/${serverId}/media-providers/youtube/resolve`, { params: { url } });
      return res.data as YouTubeResolveResult;
    } catch (e) {
      console.error('Failed to resolve YouTube URL:', e);
      return null;
    }
  },

  setConnections: (connections) => set({ connections }),
  addConnection: (connection) => set((s) => ({ connections: [...s.connections, connection] })),
  removeConnection: (connectionId) => set((s) => ({ connections: s.connections.filter((c) => c.id !== connectionId) })),
  clearLibrary: () => set({ libraries: [], libraryItems: [], searchResults: [] }),
}));
