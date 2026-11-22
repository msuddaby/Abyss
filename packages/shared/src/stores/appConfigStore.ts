import { create } from 'zustand';
import api from '../services/api.js';
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../utils/uploadLimits.js';
import { DEFAULT_TOMATO_SETTINGS, type TomatoSettings } from '../types/index.js';

interface AppConfigState {
  maxMessageLength: number;
  forceRelayMode: boolean;
  uploadLimits: UploadLimits;
  tomatoes: TomatoSettings;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  setMaxMessageLength: (value: number) => void;
  setForceRelayMode: (value: boolean) => void;
  setTomatoes: (value: unknown) => void;
}

export function parseTomatoSettings(raw: any): TomatoSettings {
  const d = DEFAULT_TOMATO_SETTINGS;
  const int = (v: unknown, fallback: number, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
  };
  if (!raw || typeof raw !== 'object') return d;
  return {
    unlimitedAmmo: raw.unlimitedAmmo === true,
    maxAmmo: int(raw.maxAmmo, d.maxAmmo, 1),
    refillMinutes: int(raw.refillMinutes, d.refillMinutes, 1),
    maxPerMessage: int(raw.maxPerMessage, d.maxPerMessage, 0),
  };
}

function positiveOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseUploadLimits(raw: any): UploadLimits {
  const scalars = {
    emojiMaxSize: positiveOrUndefined(raw?.emojiMaxSize),
    soundMaxSize: positiveOrUndefined(raw?.soundMaxSize),
    soundMaxDurationSeconds: positiveOrUndefined(raw?.soundMaxDurationSeconds),
    avatarMaxSize: positiveOrUndefined(raw?.avatarMaxSize),
    serverIconMaxSize: positiveOrUndefined(raw?.serverIconMaxSize),
  };

  const sizes = raw?.maxSizesByCategory;
  const extensions = raw?.extensionCategories;
  if (!sizes || typeof sizes !== 'object') return { ...DEFAULT_UPLOAD_LIMITS, ...scalars };

  const maxSizesByCategory: Record<string, number> = {};
  for (const [category, value] of Object.entries(sizes)) {
    const size = Number(value);
    if (Number.isFinite(size) && size > 0) maxSizesByCategory[category] = size;
  }
  // No usable sizes means we validate nothing client-side and let the server decide.
  if (Object.keys(maxSizesByCategory).length === 0) return { ...DEFAULT_UPLOAD_LIMITS, ...scalars };

  const extensionCategories: Record<string, string> = {};
  if (extensions && typeof extensions === 'object') {
    for (const [ext, category] of Object.entries(extensions)) {
      if (typeof category === 'string') extensionCategories[ext.toLowerCase()] = category;
    }
  }

  return { maxSizesByCategory, extensionCategories, ...scalars };
}

export const useAppConfigStore = create<AppConfigState>((set, get) => ({
  maxMessageLength: 4000,
  forceRelayMode: false,
  uploadLimits: DEFAULT_UPLOAD_LIMITS,
  tomatoes: DEFAULT_TOMATO_SETTINGS,
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
        forceRelayMode: res.data?.forceRelayMode === true,
        uploadLimits: parseUploadLimits(res.data?.uploadLimits),
        tomatoes: parseTomatoSettings(res.data?.tomatoes),
        loaded: true,
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false, error: err?.response?.data || 'Failed to load app config.' });
    }
  },
  setMaxMessageLength: (value) => set({ maxMessageLength: value }),
  setForceRelayMode: (value) => set({ forceRelayMode: value }),
  setTomatoes: (value) => set({ tomatoes: parseTomatoSettings(value) }),
}));
