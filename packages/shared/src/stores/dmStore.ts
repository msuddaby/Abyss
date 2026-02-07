import { create } from 'zustand';
import api from '../services/api.js';
import type { DmChannel } from '../types/index.js';

interface DmState {
  dmChannels: DmChannel[];
  activeDmChannel: DmChannel | null;
  isDmMode: boolean;
  fetchDmChannels: () => Promise<void>;
  setActiveDmChannel: (dm: DmChannel | null) => void;
  enterDmMode: () => void;
  exitDmMode: () => void;
  createOrGetDm: (userId: string) => Promise<DmChannel>;
  addDmChannelLocal: (dm: DmChannel) => void;
  moveDmToTop: (channelId: string) => void;
}

export const useDmStore = create<DmState>((set) => ({
  dmChannels: [],
  activeDmChannel: null,
  isDmMode: false,

  fetchDmChannels: async () => {
    const res = await api.get('/dm');
    set({ dmChannels: res.data });
  },

  setActiveDmChannel: (dm) => {
    set({ activeDmChannel: dm });
  },

  enterDmMode: () => {
    set({ isDmMode: true });
  },

  exitDmMode: () => {
    set({ isDmMode: false, activeDmChannel: null });
  },

  createOrGetDm: async (userId) => {
    const res = await api.post(`/dm/${userId}`);
    const dm: DmChannel = res.data;
    set((s) => {
      if (s.dmChannels.some((d) => d.id === dm.id)) return s;
      return { dmChannels: [dm, ...s.dmChannels] };
    });
    return dm;
  },

  addDmChannelLocal: (dm) => {
    set((s) => {
      if (s.dmChannels.some((d) => d.id === dm.id)) return s;
      return { dmChannels: [dm, ...s.dmChannels] };
    });
  },

  moveDmToTop: (channelId) => {
    set((s) => {
      const idx = s.dmChannels.findIndex((d) => d.id === channelId);
      if (idx <= 0) return s;
      const dm = { ...s.dmChannels[idx], lastMessageAt: new Date().toISOString() };
      const rest = s.dmChannels.filter((_, i) => i !== idx);
      return { dmChannels: [dm, ...rest] };
    });
  },
}));
