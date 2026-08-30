import { create } from 'zustand';
import api from '../services/api.js';
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../utils/uploadLimits.js';

interface AppConfigState {
  maxMessageLength: number;
  forceRelayMode: boolean;
  uploadLimits: UploadLimits;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  setMaxMessageLength: (value: number) => void;
  setForceRelayMode: (value: boolean) => void;
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
        loaded: true,
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false, error: err?.response?.data || 'Failed to load app config.' });
    }
  },
  setMaxMessageLength: (value) => set({ maxMessageLength: value }),
  setForceRelayMode: (value) => set({ forceRelayMode: value }),
}));
