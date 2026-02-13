import { create } from 'zustand';
import api from '../services/api.js';
import type { SoundboardClip } from '../types/index.js';

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
}

export const useSoundboardStore = create<SoundboardState>((set) => ({
  clips: [],
  loading: false,

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
    const res = await api.post(`/servers/${serverId}/soundboard`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
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
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== clipId),
    }));
  },
}));
