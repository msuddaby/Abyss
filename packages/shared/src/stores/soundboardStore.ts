import { create } from 'zustand';
import api, { postMultipart } from '../services/api.js';
import { getStorage } from '../storage.js';
import { resilientInvoke } from '../services/signalr.js';
import type { SoundboardClip } from '../types/index.js';
import {
  DEFAULT_SOUNDBOARD_FX,
  clampPitch,
  clampSpeed,
  effectiveFx,
  isFxNeutral,
  type SoundboardFx,
} from '../utils/soundboardFx.js';

const RECENT_MAX = 12;

function saveJson(key: string, value: unknown) {
  try {
    getStorage().setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
}

function readJson(key: string): unknown {
  try {
    const raw = getStorage().getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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
  // Global speed/pitch applied to every clip this user plays (panel clicks and
  // keybinds alike). Local preference; sent with each play so listeners hear it.
  fx: SoundboardFx;
  setFx: (fx: Partial<SoundboardFx>) => void;
  resetFx: () => void;
  favoriteClipIds: string[];
  toggleFavorite: (clipId: string) => void;
  recentClipIds: string[];
  /** Play a clip in the given voice channel. `original` skips the global FX. */
  playClip: (channelId: string, clipId: string, opts?: { original?: boolean }) => Promise<void>;
}

export const useSoundboardStore = create<SoundboardState>((set, get) => ({
  clips: [],
  loading: false,
  clipKeybinds: {},
  fx: DEFAULT_SOUNDBOARD_FX,
  favoriteClipIds: [],
  recentClipIds: [],

  setFx: (partial) => {
    const next = { ...get().fx, ...partial };
    next.speed = clampSpeed(next.speed);
    next.pitch = clampPitch(next.pitch);
    saveJson('soundboardFx', next);
    set({ fx: next });
  },

  resetFx: () => {
    saveJson('soundboardFx', DEFAULT_SOUNDBOARD_FX);
    set({ fx: DEFAULT_SOUNDBOARD_FX });
  },

  toggleFavorite: (clipId: string) => {
    const favs = get().favoriteClipIds;
    const next = favs.includes(clipId) ? favs.filter((id) => id !== clipId) : [...favs, clipId];
    saveJson('soundboardFavorites', next);
    set({ favoriteClipIds: next });
  },

  playClip: async (channelId: string, clipId: string, opts) => {
    const recent = [clipId, ...get().recentClipIds.filter((id) => id !== clipId)].slice(0, RECENT_MAX);
    saveJson('soundboardRecent', recent);
    set({ recentClipIds: recent });

    const { speed, pitch } = effectiveFx(get().fx);
    if (opts?.original || isFxNeutral(speed, pitch)) {
      await resilientInvoke('PlaySoundboardClip', channelId, clipId);
      return;
    }
    try {
      await resilientInvoke('PlaySoundboardClipFx', channelId, clipId, speed, pitch);
    } catch (err) {
      // Older server without the FX method: play the clip unaltered.
      if (String((err as Error)?.message ?? err).includes('Method does not exist')) {
        await resilientInvoke('PlaySoundboardClip', channelId, clipId);
        return;
      }
      throw err;
    }
  },

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
    const { favoriteClipIds, recentClipIds } = get();
    if (favoriteClipIds.includes(clipId)) get().toggleFavorite(clipId);
    if (recentClipIds.includes(clipId)) {
      const next = recentClipIds.filter((id) => id !== clipId);
      saveJson('soundboardRecent', next);
      set({ recentClipIds: next });
    }
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== clipId),
    }));
  },
}));

function readIdList(key: string): string[] {
  const parsed = readJson(key);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function readFx(): SoundboardFx {
  const parsed = readJson('soundboardFx') as Partial<SoundboardFx> | null;
  if (!parsed || typeof parsed !== 'object') return DEFAULT_SOUNDBOARD_FX;
  return {
    speed: clampSpeed(typeof parsed.speed === 'number' ? parsed.speed : 1),
    pitch: clampPitch(typeof parsed.pitch === 'number' ? parsed.pitch : 0),
    tape: parsed.tape === true,
  };
}

/**
 * Hydrate soundboard local preferences (clip keybinds, FX, favourites, recents)
 * from persistent storage.
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
  useSoundboardStore.setState({
    clipKeybinds: binds,
    fx: readFx(),
    favoriteClipIds: readIdList('soundboardFavorites'),
    recentClipIds: readIdList('soundboardRecent').slice(0, RECENT_MAX),
  });
}
