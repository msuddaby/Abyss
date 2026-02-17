import { create } from 'zustand';

interface RateLimitEntry {
  expiresAt: number;
  retrySeconds: number;
}

interface RateLimitState {
  activeLimits: Record<string, RateLimitEntry>;
  setRateLimit: (method: string, retrySeconds: number) => void;
  isRateLimited: (method: string) => boolean;
  getRemainingSeconds: (method: string) => number;
  clearRateLimit: (method: string) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useRateLimitStore = create<RateLimitState>((set, get) => ({
  activeLimits: {},

  setRateLimit: (method, retrySeconds) => {
    const expiresAt = Date.now() + retrySeconds * 1000;

    // Clear existing timer for this method
    const existing = timers.get(method);
    if (existing) clearTimeout(existing);

    // Auto-clear when expired
    const timer = setTimeout(() => {
      timers.delete(method);
      set((state) => {
        const { [method]: _, ...rest } = state.activeLimits;
        return { activeLimits: rest };
      });
    }, retrySeconds * 1000);
    timers.set(method, timer);

    set((state) => ({
      activeLimits: {
        ...state.activeLimits,
        [method]: { expiresAt, retrySeconds },
      },
    }));
  },

  isRateLimited: (method) => {
    const entry = get().activeLimits[method];
    if (!entry) return false;
    return Date.now() < entry.expiresAt;
  },

  getRemainingSeconds: (method) => {
    const entry = get().activeLimits[method];
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  },

  clearRateLimit: (method) => {
    const timer = timers.get(method);
    if (timer) clearTimeout(timer);
    timers.delete(method);
    set((state) => {
      const { [method]: _, ...rest } = state.activeLimits;
      return { activeLimits: rest };
    });
  },
}));
