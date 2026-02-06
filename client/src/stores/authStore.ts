import { create } from 'zustand';
import api from '../services/api';
import { resetConnection } from '../services/signalr';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
  initialize: () => Promise<void>;
  updateProfile: (data: { displayName?: string; bio?: string; status?: string }) => Promise<void>;
  updateAvatar: (file: File) => Promise<void>;
}

const savedToken = localStorage.getItem('token');
const savedUser = localStorage.getItem('user');

export const useAuthStore = create<AuthState>((set, get) => ({
  user: savedUser ? JSON.parse(savedUser) : null,
  token: savedToken,
  isAuthenticated: !!(savedToken && savedUser),

  initialize: async () => {
    const { token, user: savedUser } = get();
    if (!token || !savedUser) return;
    try {
      const res = await api.get(`/auth/profile/${savedUser.id}`);
      const user = res.data;
      localStorage.setItem('user', JSON.stringify(user));
      set({ user });
    } catch {
      // token expired or invalid — log out
      get().logout();
    }
  },

  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    const { token, user } = res.data;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true });
  },

  register: async (username, email, password, displayName) => {
    const res = await api.post('/auth/register', { username, email, password, displayName });
    const { token, user } = res.data;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true });
  },

  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    resetConnection();
    set({ token: null, user: null, isAuthenticated: false });
  },

  updateProfile: async (data) => {
    const res = await api.put('/auth/profile', data);
    const user = res.data;
    localStorage.setItem('user', JSON.stringify(user));
    set({ user });
  },

  updateAvatar: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await api.post('/auth/avatar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const user = res.data;
    localStorage.setItem('user', JSON.stringify(user));
    set({ user });
  },
}));
