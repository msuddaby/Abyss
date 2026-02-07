import { create } from 'zustand';
import api from '../services/api.js';
import { resetConnection } from '../services/signalr.js';
import { getStorage } from '../storage.js';
import type { User } from '../types/index.js';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  initialized: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
  initialize: () => Promise<void>;
  updateProfile: (data: { displayName?: string; bio?: string; status?: string }) => Promise<void>;
  updateAvatar: (file: File) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: (() => { try { const u = getStorage().getItem('user'); return u ? JSON.parse(u) : null; } catch { return null; } })(),
  token: (() => { try { return getStorage().getItem('token'); } catch { return null; } })(),
  isAuthenticated: (() => { try { const s = getStorage(); return !!(s.getItem('token') && s.getItem('user')); } catch { return false; } })(),
  initialized: false,

  initialize: async () => {
    const storage = getStorage();
    const storedToken = storage.getItem('token');
    const storedUser = storage.getItem('user');
    if (!storedToken || !storedUser) {
      set({ initialized: true });
      return;
    }

    let savedUser: User;
    try {
      savedUser = JSON.parse(storedUser) as User;
    } catch {
      get().logout();
      set({ initialized: true });
      return;
    }

    set({ token: storedToken, user: savedUser, isAuthenticated: true });
    try {
      const res = await api.get(`/auth/profile/${savedUser.id}`);
      const user = res.data;
      storage.setItem('user', JSON.stringify(user));
      set({ user });
    } catch {
      get().logout();
    }
    set({ initialized: true });
  },

  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    const { token, user } = res.data;
    const s = getStorage();
    s.setItem('token', token);
    s.setItem('user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true });
  },

  register: async (username, email, password, displayName) => {
    const res = await api.post('/auth/register', { username, email, password, displayName });
    const { token, user } = res.data;
    const s = getStorage();
    s.setItem('token', token);
    s.setItem('user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true });
  },

  logout: () => {
    const s = getStorage();
    s.removeItem('token');
    s.removeItem('user');
    resetConnection();
    set({ token: null, user: null, isAuthenticated: false, initialized: true });
  },

  updateProfile: async (data) => {
    const res = await api.put('/auth/profile', data);
    const user = res.data;
    getStorage().setItem('user', JSON.stringify(user));
    set({ user });
  },

  updateAvatar: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await api.post('/auth/avatar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const user = res.data;
    getStorage().setItem('user', JSON.stringify(user));
    set({ user });
  },
}));
