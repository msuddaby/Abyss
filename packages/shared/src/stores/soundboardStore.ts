import { create } from 'zustand';
import api, { postMultipart } from '../services/api.js';
import { getStorage } from '../storage.js';
import type { SoundboardClip } from '../types/index.js';

function saveClipKeybinds(binds: Record<string, string>) {
  try {
    getStorage().setItem('soundboardKeybinds', JSON.stringify(binds));
  } catch {
    // Ignore storage errors
  }
}

interface SoundboardState {
  clips: SoundboardClip[];
  loading: boolean;
  fetchClips: (serverId: string) => Promise<void>;
  uploadClip: (serverId: string, formData: FormData) => Promise<SoundboardClip>;
  renameClip: (serverId: string, clipId: string, name: string) => Promise<void>;
  deleteClip: (serverId: string, clipId: string) => Promise<void>;
  addClipLocal: (clip: SoundboardClip) => void;
  updateClipLocal: (clip: SoundboardClip) => void;
  removeClipLocal: (clipId: string) => void;
  // Per-clip keybinds (local preference, same format/rules as the voice
  // shortcuts: "mod+shift+m", bare "f9", bare macro key names, etc). Keyed
  // by clip id, persisted to local storage — not synced server-side, since
  // this is a personal binding rather than a server-wide setting.
  clipKeybinds: Record<string, string>;
  setClipKeybind: (clipId: string, bind: string) => void;
  clearClipKeybind: (clipId: string) => void;
}

export const useSoundboardStore = create<SoundboardState>((set, get) => ({
  clips: [],
  loading: false,
  clipKeybinds: {},

  setClipKeybind: (clipId: string, bind: string) => {
    // Only one clip may own a given bind at a time — clear it from
    // whichever other clip previously held it, mirroring the voice
    // keybinds' "same-key-unequips-others" behavior.
    const next: Record<string, string> = {};
    for (const [id, existing] of Object.entries(get().clipKeybinds)) {
      if (existing !== bind) next[id] = existing;
    }
    next[clipId] = bind;
    saveClipKeybinds(next);
    set({ clipKeybinds: next });
  },

  clearClipKeybind: (clipId: string) => {
    const next = { ...get().clipKeybinds };
    delete next[clipId];
    saveClipKeybinds(next);
    set({ clipKeybinds: next });
  },

  fetchClips: async (serverId: string) => {
    set({ loading: true });
    try {
      const res = await api.get(`/servers/${serverId}/soundboard`);
      set({ clips: res.data, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  uploadClip: async (serverId: string, formData: FormData) => {
    return postMultipart<SoundboardClip>(`/servers/${serverId}/soundboard`, formData);
  },

  renameClip: async (serverId: string, clipId: string, name: string) => {
    await api.patch(`/servers/${serverId}/soundboard/${clipId}`, { name });
  },

  deleteClip: async (serverId: string, clipId: string) => {
    await api.delete(`/servers/${serverId}/soundboard/${clipId}`);
  },

  addClipLocal: (clip: SoundboardClip) => {
    set((s) => {
      if (s.clips.some((c) => c.id === clip.id)) return s;
      return { clips: [...s.clips, clip] };
    });
  },

  updateClipLocal: (clip: SoundboardClip) => {
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clip.id ? clip : c)),
    }));
  },

  removeClipLocal: (clipId: string) => {
    get().clearClipKeybind(clipId);
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== clipId),
    }));
  },
}));

/**
 * Hydrate soundboard clip keybinds from persistent storage.
 * Must be called AFTER setStorage() so the adapter is available — the store
 * itself is constructed at module-eval time, before any adapter exists.
 */
export function hydrateSoundboardKeybinds() {
  let binds: Record<string, string> = {};
  try {
    const raw = getStorage().getItem('soundboardKeybinds');
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, bind] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof bind === 'string' && bind) binds[id] = bind;
      }
    }
  } catch {
    binds = {};
  }
  useSoundboardStore.setState({ clipKeybinds: binds });
}
