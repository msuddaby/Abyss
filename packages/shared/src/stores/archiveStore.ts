import { create } from 'zustand';
import api, { postMultipart } from '../services/api.js';
import { useWatchPartyStore } from './watchPartyStore.js';
import type { ArchiveAlbum, ArchiveItem, ArchiveStats, ArchiveTypeFilter, GalleryItem } from '../types/index.js';

export type ArchiveTab = 'uploads' | 'gallery';
export type ArchiveSort = 'newest' | 'oldest';

export interface ArchiveUpload {
  id: string;
  fileName: string;
  /** 0-100, or -1 when the total size is unknown. */
  progress: number;
  error?: string;
}

interface ItemPage { items: ArchiveItem[]; nextCursor: string | null }
interface GalleryPage { items: GalleryItem[]; nextCursor: string | null }

interface ArchiveFilter {
  albumId: string | null;
  type: ArchiveTypeFilter;
  q: string;
  sort: ArchiveSort;
}

interface GalleryFilter {
  channelId: string | null;
  type: ArchiveTypeFilter;
}

interface ArchiveState {
  /** Server whose archive is open in the content area, or null when a channel is showing. */
  openServerId: string | null;
  tab: ArchiveTab;

  albums: ArchiveAlbum[];
  stats: ArchiveStats | null;
  items: ArchiveItem[];
  itemsCursor: string | null;
  itemsLoading: boolean;
  filter: ArchiveFilter;

  gallery: GalleryItem[];
  galleryCursor: string | null;
  galleryLoading: boolean;
  galleryFilter: GalleryFilter;

  uploads: ArchiveUpload[];
  /** Hidden per-server media-provider connection used to start watch parties. */
  connectionIds: Record<string, string>;

  openArchive: (serverId: string) => void;
  closeArchive: () => void;
  setTab: (tab: ArchiveTab) => void;
  setFilter: (patch: Partial<ArchiveFilter>) => void;
  setGalleryFilter: (patch: Partial<GalleryFilter>) => void;

  fetchAlbums: (serverId: string) => Promise<void>;
  fetchStats: (serverId: string) => Promise<void>;
  /** Debounced re-fetch of album counts + totals after any add/edit/delete. */
  refreshCounts: (serverId: string) => void;
  fetchItems: (serverId: string, opts?: { append?: boolean }) => Promise<void>;
  fetchGallery: (serverId: string, opts?: { append?: boolean }) => Promise<void>;

  createAlbum: (serverId: string, name: string) => Promise<ArchiveAlbum>;
  renameAlbum: (serverId: string, albumId: string, name: string) => Promise<void>;
  deleteAlbum: (serverId: string, albumId: string) => Promise<void>;

  uploadFiles: (serverId: string, files: File[], albumId: string | null) => Promise<void>;
  dismissUpload: (id: string) => void;
  updateItem: (serverId: string, itemId: string, patch: { title?: string; description?: string; albumId?: string | null }) => Promise<void>;
  deleteItem: (serverId: string, itemId: string) => Promise<void>;
  saveFromAttachment: (serverId: string, attachmentId: string, albumId?: string | null) => Promise<ArchiveItem>;

  getConnectionId: (serverId: string) => Promise<string>;
  startWatchParty: (channelId: string, item: ArchiveItem) => Promise<void>;
  queueItem: (channelId: string, item: ArchiveItem) => Promise<void>;

  // SignalR
  addItemLocal: (item: ArchiveItem) => void;
  updateItemLocal: (item: ArchiveItem) => void;
  removeItemLocal: (itemId: string) => void;
}

const PAGE_SIZE = 50;

function matchesFilter(item: ArchiveItem, f: ArchiveFilter): boolean {
  if (f.albumId && item.albumId !== f.albumId) return false;
  if (f.type === 'video' && !item.contentType.startsWith('video/')) return false;
  if (f.type === 'image' && !item.contentType.startsWith('image/')) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = `${item.title} ${item.description ?? ''} ${item.uploader?.displayName ?? ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// Guards against out-of-order responses when filters change quickly.
let itemsRequestSeq = 0;
let galleryRequestSeq = 0;
let countsTimer: ReturnType<typeof setTimeout> | null = null;

export const useArchiveStore = create<ArchiveState>((set, get) => ({
  openServerId: null,
  tab: 'uploads',

  albums: [],
  stats: null,
  items: [],
  itemsCursor: null,
  itemsLoading: false,
  filter: { albumId: null, type: 'all', q: '', sort: 'newest' },

  gallery: [],
  galleryCursor: null,
  galleryLoading: false,
  galleryFilter: { channelId: null, type: 'all' },

  uploads: [],
  connectionIds: {},

  openArchive: (serverId) => {
    if (get().openServerId === serverId) return;
    set({
      openServerId: serverId,
      albums: [], stats: null, items: [], itemsCursor: null, gallery: [], galleryCursor: null,
      filter: { albumId: null, type: 'all', q: '', sort: 'newest' },
      galleryFilter: { channelId: null, type: 'all' },
    });
  },
  closeArchive: () => set({ openServerId: null }),
  setTab: (tab) => set({ tab }),
  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),
  setGalleryFilter: (patch) => set({ galleryFilter: { ...get().galleryFilter, ...patch } }),

  fetchAlbums: async (serverId) => {
    const res = await api.get<ArchiveAlbum[]>(`/servers/${serverId}/archive/albums`);
    if (get().openServerId === serverId) set({ albums: res.data });
  },

  fetchStats: async (serverId) => {
    const res = await api.get<ArchiveStats>(`/servers/${serverId}/archive/stats`);
    if (get().openServerId === serverId) set({ stats: res.data });
  },

  refreshCounts: (serverId) => {
    if (get().openServerId !== serverId) return;
    // Bursts (multi-file uploads, our own action + its SignalR echo) collapse into one fetch.
    if (countsTimer) clearTimeout(countsTimer);
    countsTimer = setTimeout(() => {
      countsTimer = null;
      if (get().openServerId !== serverId) return;
      get().fetchAlbums(serverId).catch(console.error);
      get().fetchStats(serverId).catch(console.error);
    }, 400);
  },

  fetchItems: async (serverId, opts) => {
    const append = opts?.append ?? false;
    const { filter, itemsCursor } = get();
    if (append && !itemsCursor) return;
    const seq = ++itemsRequestSeq;
    set({ itemsLoading: true });
    try {
      const params: Record<string, string | number> = { limit: PAGE_SIZE, sort: filter.sort };
      if (filter.albumId) params.albumId = filter.albumId;
      if (filter.type !== 'all') params.type = filter.type;
      if (filter.q.trim()) params.q = filter.q.trim();
      if (append && itemsCursor) params.cursor = itemsCursor;
      const res = await api.get<ItemPage>(`/servers/${serverId}/archive/items`, { params });
      if (seq !== itemsRequestSeq || get().openServerId !== serverId) return;
      set({
        items: append ? [...get().items, ...res.data.items] : res.data.items,
        itemsCursor: res.data.nextCursor,
      });
    } finally {
      if (seq === itemsRequestSeq) set({ itemsLoading: false });
    }
  },

  fetchGallery: async (serverId, opts) => {
    const append = opts?.append ?? false;
    const { galleryFilter, galleryCursor } = get();
    if (append && !galleryCursor) return;
    const seq = ++galleryRequestSeq;
    set({ galleryLoading: true });
    try {
      const params: Record<string, string | number> = { limit: 60 };
      if (galleryFilter.channelId) params.channelId = galleryFilter.channelId;
      if (galleryFilter.type !== 'all') params.type = galleryFilter.type;
      if (append && galleryCursor) params.cursor = galleryCursor;
      const res = await api.get<GalleryPage>(`/servers/${serverId}/archive/gallery`, { params });
      if (seq !== galleryRequestSeq || get().openServerId !== serverId) return;
      set({
        gallery: append ? [...get().gallery, ...res.data.items] : res.data.items,
        galleryCursor: res.data.nextCursor,
      });
    } finally {
      if (seq === galleryRequestSeq) set({ galleryLoading: false });
    }
  },

  createAlbum: async (serverId, name) => {
    const res = await api.post<ArchiveAlbum>(`/servers/${serverId}/archive/albums`, { name });
    set({ albums: [...get().albums.filter((a) => a.id !== res.data.id), res.data].sort((a, b) => a.name.localeCompare(b.name)) });
    return res.data;
  },

  renameAlbum: async (serverId, albumId, name) => {
    const res = await api.patch<ArchiveAlbum>(`/servers/${serverId}/archive/albums/${albumId}`, { name });
    set({ albums: get().albums.map((a) => (a.id === albumId ? res.data : a)) });
  },

  deleteAlbum: async (serverId, albumId) => {
    await api.delete(`/servers/${serverId}/archive/albums/${albumId}`);
    const { filter } = get();
    set({
      albums: get().albums.filter((a) => a.id !== albumId),
      items: get().items.map((i) => (i.albumId === albumId ? { ...i, albumId: null } : i)),
      filter: filter.albumId === albumId ? { ...filter, albumId: null } : filter,
    });
    get().refreshCounts(serverId);
  },

  uploadFiles: async (serverId, files, albumId) => {
    // Sequential: big videos in parallel would just compete for the same uplink.
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      set({ uploads: [...get().uploads, { id, fileName: file.name, progress: 0 }] });
      const patch = (p: Partial<ArchiveUpload>) =>
        set({ uploads: get().uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) });
      try {
        const form = new FormData();
        form.append('file', file);
        if (albumId) form.append('albumId', albumId);
        const item = await postMultipart<ArchiveItem>(`/servers/${serverId}/archive/items`, form, {
          onProgress: (progress) => patch({ progress }),
        });
        get().addItemLocal(item);
        get().refreshCounts(serverId);
        set({ uploads: get().uploads.filter((u) => u.id !== id) });
      } catch (err: any) {
        const msg = typeof err?.response?.data === 'string' ? err.response.data : err?.message || 'Upload failed';
        patch({ error: msg, progress: 0 });
      }
    }
  },

  dismissUpload: (id) => set({ uploads: get().uploads.filter((u) => u.id !== id) }),

  updateItem: async (serverId, itemId, patch) => {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.albumId !== undefined) {
      if (patch.albumId === null) body.clearAlbum = true;
      else body.albumId = patch.albumId;
    }
    const res = await api.patch<ArchiveItem>(`/servers/${serverId}/archive/items/${itemId}`, body);
    get().updateItemLocal(res.data);
    if (patch.albumId !== undefined) get().refreshCounts(serverId);
  },

  deleteItem: async (serverId, itemId) => {
    await api.delete(`/servers/${serverId}/archive/items/${itemId}`);
    get().removeItemLocal(itemId);
    get().refreshCounts(serverId);
  },

  saveFromAttachment: async (serverId, attachmentId, albumId) => {
    const res = await api.post<ArchiveItem>(`/servers/${serverId}/archive/items/from-attachment/${attachmentId}`, {
      albumId: albumId ?? null,
    });
    get().addItemLocal(res.data);
    get().refreshCounts(serverId);
    return res.data;
  },

  getConnectionId: async (serverId) => {
    const cached = get().connectionIds[serverId];
    if (cached) return cached;
    const res = await api.get<{ connectionId: string }>(`/servers/${serverId}/archive/connection`);
    set({ connectionIds: { ...get().connectionIds, [serverId]: res.data.connectionId } });
    return res.data.connectionId;
  },

  startWatchParty: async (channelId, item) => {
    const connectionId = await get().getConnectionId(item.serverId);
    await useWatchPartyStore.getState().startWatchParty(channelId, {
      mediaProviderConnectionId: connectionId,
      providerItemId: item.id,
      itemTitle: item.title,
      itemThumbnail: item.posterPath ?? undefined,
      itemDurationMs: item.durationMs ?? undefined,
    });
  },

  queueItem: async (channelId, item) => {
    const connectionId = await get().getConnectionId(item.serverId);
    await useWatchPartyStore.getState().addToQueue(channelId, {
      providerItemId: item.id,
      title: item.title,
      thumbnail: item.posterPath ?? undefined,
      durationMs: item.durationMs ?? undefined,
      mediaProviderConnectionId: connectionId,
    });
  },

  addItemLocal: (item) => {
    const { openServerId, items, filter } = get();
    if (item.serverId !== openServerId || items.some((i) => i.id === item.id)) return;
    if (!matchesFilter(item, filter)) return;
    set({ items: filter.sort === 'newest' ? [item, ...items] : [...items, item] });
  },

  updateItemLocal: (item) => {
    const { items, filter } = get();
    if (!items.some((i) => i.id === item.id)) return;
    set({
      items: matchesFilter(item, filter)
        ? items.map((i) => (i.id === item.id ? item : i))
        : items.filter((i) => i.id !== item.id),
    });
  },

  removeItemLocal: (itemId) => set({ items: get().items.filter((i) => i.id !== itemId) }),
}));
