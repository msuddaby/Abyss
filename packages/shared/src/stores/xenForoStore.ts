import { create } from 'zustand';
import api from '../services/api.js';
import type { XenForoConnection, XenForoNode, CreateForumTopicRequest, CreateForumTopicResponse } from '../types/index.js';

interface XenForoState {
  connection: XenForoConnection | null;
  connectionLoaded: boolean;
  nodes: XenForoNode[];
  nodesLoaded: boolean;
  isLoading: boolean;

  fetchConnection: () => Promise<void>;
  unlink: () => Promise<void>;
  fetchNodes: (force?: boolean) => Promise<void>;
  createTopic: (channelId: string, req: CreateForumTopicRequest) => Promise<CreateForumTopicResponse>;
  reset: () => void;
}

export const useXenForoStore = create<XenForoState>((set, get) => ({
  connection: null,
  connectionLoaded: false,
  nodes: [],
  nodesLoaded: false,
  isLoading: false,

  fetchConnection: async () => {
    try {
      const res = await api.get('/xenforo/connection');
      set({ connection: res.data, connectionLoaded: true });
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        set({ connection: null, connectionLoaded: true });
      } else {
        console.error('Failed to fetch XenForo connection:', e);
      }
    }
  },

  unlink: async () => {
    await api.delete('/xenforo/connection');
    set({ connection: null });
  },

  fetchNodes: async (force = false) => {
    if (!force && get().nodesLoaded) return;
    set({ isLoading: true });
    try {
      const res = await api.get('/xenforo/nodes');
      set({ nodes: res.data, nodesLoaded: true, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      console.error('Failed to fetch XenForo nodes:', e);
      throw e;
    }
  },

  createTopic: async (channelId, req) => {
    const res = await api.post(`/channels/${channelId}/forum-topic`, req);
    return res.data as CreateForumTopicResponse;
  },

  reset: () => set({ connection: null, connectionLoaded: false, nodes: [], nodesLoaded: false }),
}));
