import { create } from 'zustand';
import api from '../services/api.js';
import { resetConnection } from '../services/signalr.js';
import { clearTurnCredentials } from '../services/turn.js';
import { getStorage } from '../storage.js';
import type { User } from '../types/index.js';

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isSysadmin: boolean;
  initialized: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, displayName: string, inviteCode?: string) => Promise<void>;
  logout: () => void;
  initialize: () => Promise<void>;
  updateProfile: (data: { displayName?: string; bio?: string; status?: string }) => Promise<void>;
  updateAvatar: (file: File) => Promise<void>;
  setPresenceStatus: (status: number) => void;
}

const getSysadminFromToken = (token: string | null): boolean => {
  if (!token) return false;
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = JSON.parse(atob(base64));
    return json.sysadmin === true || json.sysadmin === 'true';
  } catch {
    return false;
  }
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: (() => { try { const u = getStorage().getItem('user'); return u ? JSON.parse(u) : null; } catch { return null; } })(),
  token: (() => { try { return getStorage().getItem('token'); } catch { return null; } })(),
  refreshToken: (() => { try { return getStorage().getItem('refreshToken'); } catch { return null; } })(),
  isAuthenticated: (() => { try { const s = getStorage(); return !!(s.getItem('token') && s.getItem('user')); } catch { return false; } })(),
  isSysadmin: (() => { try { return getSysadminFromToken(getStorage().getItem('token')); } catch { return false; } })(),
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

    set({
      token: storedToken,
      refreshToken: storage.getItem('refreshToken'),
      user: savedUser,
      isAuthenticated: true,
      isSysadmin: getSysadminFromToken(storedToken),
    });
    try {
      const res = await api.get(`/auth/profile/${savedUser.id}`);
      const user = res.data;
      storage.setItem('user', JSON.stringify(user));
      set({ user });
    } catch (err: any) {
      // Only logout on 401 (auth truly invalid) or 404 (user deleted).
      // Network errors, 500s, etc. should not log out — keep cached user data.
      const status = err?.response?.status;
      if (status === 401 || status === 404) {
        get().logout();
      }
    }
    set({ initialized: true });
  },

  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    const { token, refreshToken, user } = res.data;
    const s = getStorage();
    s.setItem('token', token);
    s.setItem('refreshToken', refreshToken);
    s.setItem('user', JSON.stringify(user));
    set({ token, refreshToken, user, isAuthenticated: true, isSysadmin: getSysadminFromToken(token) });
  },

  register: async (username, email, password, displayName, inviteCode) => {
    const res = await api.post('/auth/register', { username, email, password, displayName, inviteCode });
    const { token, refreshToken, user } = res.data;
    const s = getStorage();
    s.setItem('token', token);
    s.setItem('refreshToken', refreshToken);
    s.setItem('user', JSON.stringify(user));
    set({ token, refreshToken, user, isAuthenticated: true, isSysadmin: getSysadminFromToken(token) });
  },

  logout: () => {
    const s = getStorage();
    const refreshToken = s.getItem('refreshToken');
    if (refreshToken) {
      api.post('/auth/logout', { refreshToken }).catch(() => undefined);
    }
    s.removeItem('token');
    s.removeItem('refreshToken');
    s.removeItem('user');
    resetConnection();
    clearTurnCredentials();
    set({ token: null, refreshToken: null, user: null, isAuthenticated: false, isSysadmin: false, initialized: true });
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

  setPresenceStatus: (status) => {
    const user = get().user;
    if (!user) return;
    const updatedUser = { ...user, presenceStatus: status };
    getStorage().setItem('user', JSON.stringify(updatedUser));
    set({ user: updatedUser });
  },
}));
