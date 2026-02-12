import { create } from 'zustand';
import api from '../services/api.js';
import type { MediaProviderConnection, MediaLibrary, MediaItem, PlaybackInfo } from '../types/index.js';

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
      const res = await api.post(`/servers/${serverId}/media-providers/link`, data);
      set((s) => ({ connections: [...s.connections, res.data], isLoading: false }));
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
      set({ libraries: res.data, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      console.error('Failed to fetch libraries:', e);
    }
  },

  fetchLibraryItems: async (serverId, connectionId, libraryId) => {
    set({ isLoading: true });
    try {
      const res = await api.get(`/servers/${serverId}/media-providers/${connectionId}/libraries/${libraryId}/items`);
      set({ libraryItems: res.data, isLoading: false });
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
      return res.data as MediaItem[];
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
      set({ searchResults: res.data, isLoading: false });
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
        const { getApiBase } = await import('../services/api.js');
        const { getStorage } = await import('../storage.js');
        const storage = getStorage();
        const token = storage.getItem('token');
        const separator = playbackInfo.url.includes('?') ? '&' : '?';
        playbackInfo.url = `${getApiBase()}${playbackInfo.url}${token ? `${separator}token=${token}` : ''}`;
      }

      return playbackInfo;
    } catch (e) {
      console.error('Failed to get playback info:', e);
      return null;
    }
  },

  setConnections: (connections) => set({ connections }),
  addConnection: (connection) => set((s) => ({ connections: [...s.connections, connection] })),
  removeConnection: (connectionId) => set((s) => ({ connections: s.connections.filter((c) => c.id !== connectionId) })),
  clearLibrary: () => set({ libraries: [], libraryItems: [], searchResults: [] }),
}));
