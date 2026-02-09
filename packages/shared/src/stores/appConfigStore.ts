import { create } from 'zustand';
import api from '../services/api.js';

interface AppConfigState {
  maxMessageLength: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  setMaxMessageLength: (value: number) => void;
}

export const useAppConfigStore = create<AppConfigState>((set, get) => ({
  maxMessageLength: 4000,
  loaded: false,
  loading: false,
  error: null,
  fetchConfig: async () => {
    if (get().loading || get().loaded) return;
    set({ loading: true, error: null });
    try {
      const res = await api.get('/config');
      const maxMessageLength = Number(res.data?.maxMessageLength ?? 4000);
      set({
        maxMessageLength: Number.isFinite(maxMessageLength) && maxMessageLength > 0 ? Math.floor(maxMessageLength) : 4000,
        loaded: true,
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false, error: err?.response?.data || 'Failed to load app config.' });
    }
  },
  setMaxMessageLength: (value) => set({ maxMessageLength: value }),
}));
