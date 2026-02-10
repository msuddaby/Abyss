import axios from 'axios';
import { getStorage } from '../storage.js';

let apiBase = 'http://localhost:5000';

export function getApiBase(): string {
  return apiBase;
}

export function setApiBase(url: string): void {
  apiBase = url;
  api.defaults.baseURL = `${url}/api`;
  rawApi.defaults.baseURL = `${url}/api`;
}

const api = axios.create({
  baseURL: `${apiBase}/api`,
});

const rawApi = axios.create({
  baseURL: `${apiBase}/api`,
});

api.interceptors.request.use((config) => {
  const token = getStorage().getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

let refreshPromise: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const refreshToken = getStorage().getItem('refreshToken');
    if (!refreshToken) return null;
    try {
      const res = await rawApi.post('/auth/refresh', { refreshToken });
      const { token, refreshToken: newRefreshToken, user } = res.data;
      const storage = getStorage();
      storage.setItem('token', token);
      storage.setItem('refreshToken', newRefreshToken);
      if (user) storage.setItem('user', JSON.stringify(user));
      return token;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const status = err.response?.status;
    const original = err.config as (typeof err.config & { _retry?: boolean });
    if (status === 401 && original && !original._retry) {
      original._retry = true;
      const newToken = await refreshAccessToken();
      if (newToken) {
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
      if (onUnauthorized) onUnauthorized();
    }
    return Promise.reject(err);
  },
);

export default api;

export async function uploadFile(
  file: File,
  options?: { serverId?: string; channelId?: string },
  onProgress?: (percent: number) => void,
): Promise<{ id: string; url: string; fileName: string; contentType: string; size: number }> {
  const formData = new FormData();
  formData.append('file', file);
  if (options?.serverId) formData.append('serverId', options.serverId);
  if (options?.channelId) formData.append('channelId', options.channelId);
  const res = await api.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (evt) => {
      if (!onProgress) return;
      const total = evt.total ?? 0;
      if (total > 0) {
        const percent = Math.min(100, Math.round((evt.loaded / total) * 100));
        onProgress(percent);
      }
    },
  });
  return res.data;
}
