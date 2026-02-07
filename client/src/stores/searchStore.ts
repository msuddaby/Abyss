import { create } from 'zustand';
import api from '../services/api';
import type { SearchResult } from '../types';

interface SearchFilters {
  channelId?: string;
  authorId?: string;
  hasAttachment?: boolean;
  before?: string;
  after?: string;
}

interface SearchState {
  isOpen: boolean;
  query: string;
  filters: SearchFilters;
  results: SearchResult[];
  totalCount: number;
  loading: boolean;
  hasMore: boolean;
  offset: number;
  openSearch: () => void;
  closeSearch: () => void;
  setQuery: (query: string) => void;
  setFilters: (filters: SearchFilters) => void;
  clearFilters: () => void;
  search: (serverId: string) => Promise<void>;
  loadMore: (serverId: string) => Promise<void>;
}

const LIMIT = 25;

export const useSearchStore = create<SearchState>((set, get) => ({
  isOpen: false,
  query: '',
  filters: {},
  results: [],
  totalCount: 0,
  loading: false,
  hasMore: false,
  offset: 0,

  openSearch: () => set({ isOpen: true }),
  closeSearch: () => set({ isOpen: false, query: '', filters: {}, results: [], totalCount: 0, offset: 0, hasMore: false }),

  setQuery: (query) => set({ query }),
  setFilters: (filters) => set({ filters }),
  clearFilters: () => set({ filters: {} }),

  search: async (serverId) => {
    const { query, filters } = get();
    if (!query.trim()) {
      set({ results: [], totalCount: 0, offset: 0, hasMore: false });
      return;
    }
    set({ loading: true, offset: 0 });
    try {
      const params = new URLSearchParams({ q: query.trim(), offset: '0', limit: String(LIMIT) });
      if (filters.channelId) params.set('channelId', filters.channelId);
      if (filters.authorId) params.set('authorId', filters.authorId);
      if (filters.hasAttachment) params.set('hasAttachment', 'true');
      if (filters.before) params.set('before', filters.before);
      if (filters.after) params.set('after', filters.after);

      const res = await api.get(`/servers/${serverId}/search?${params}`);
      const { results, totalCount } = res.data;
      set({ results, totalCount, hasMore: results.length >= LIMIT, offset: results.length });
    } catch (e) {
      console.error('Search failed', e);
      set({ results: [], totalCount: 0 });
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async (serverId) => {
    const { query, filters, offset, hasMore, loading } = get();
    if (!hasMore || loading || !query.trim()) return;
    set({ loading: true });
    try {
      const params = new URLSearchParams({ q: query.trim(), offset: String(offset), limit: String(LIMIT) });
      if (filters.channelId) params.set('channelId', filters.channelId);
      if (filters.authorId) params.set('authorId', filters.authorId);
      if (filters.hasAttachment) params.set('hasAttachment', 'true');
      if (filters.before) params.set('before', filters.before);
      if (filters.after) params.set('after', filters.after);

      const res = await api.get(`/servers/${serverId}/search?${params}`);
      const { results, totalCount } = res.data;
      set((s) => ({
        results: [...s.results, ...results],
        totalCount,
        hasMore: results.length >= LIMIT,
        offset: s.offset + results.length,
      }));
    } catch (e) {
      console.error('Search loadMore failed', e);
    } finally {
      set({ loading: false });
    }
  },
}));
