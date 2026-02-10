import { create } from 'zustand';

export type ToastType = 'error' | 'success' | 'info';

export interface Toast {
  id: string;
  title?: string;
  message: string;
  type: ToastType;
  onAction?: () => void;
}

const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRemove(id: string, duration: number, remove: (id: string) => void) {
  const timeout = setTimeout(() => {
    remove(id);
  }, duration);
  timeouts.set(id, timeout);
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType, durationMs?: number, onAction?: () => void, title?: string) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  addToast: (message, type = 'info', durationMs = 4000, onAction?, title?) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({ toasts: [...state.toasts, { id, title, message, type, onAction }] }));
    scheduleRemove(id, durationMs, get().removeToast);
  },
  removeToast: (id) => {
    const timeout = timeouts.get(id);
    if (timeout) clearTimeout(timeout);
    timeouts.delete(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clearToasts: () => {
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout);
    }
    timeouts.clear();
    set({ toasts: [] });
  },
}));
