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

api.interceptors.request.use(async (config) => {
  const token = await ensureFreshToken();
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

async function doRefresh(): Promise<string | null> {
  const storage = getStorage();
  const refreshToken = storage.getItem('refreshToken');
  if (!refreshToken) return null;
  try {
    const res = await rawApi.post('/auth/refresh', { refreshToken });
    const { token, refreshToken: newRefreshToken, user } = res.data;
    storage.setItem('token', token);
    storage.setItem('refreshToken', newRefreshToken);
    if (user) storage.setItem('user', JSON.stringify(user));
    return token;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 429) {
      const retryAfter = Number(err.response?.headers?.['retry-after']) || 5;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      try {
        const res = await rawApi.post('/auth/refresh', { refreshToken: storage.getItem('refreshToken') });
        const { token, refreshToken: newRefreshToken, user } = res.data;
        storage.setItem('token', token);
        storage.setItem('refreshToken', newRefreshToken);
        if (user) storage.setItem('user', JSON.stringify(user));
        return token;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const storage = getStorage();
    const originalRefreshToken = storage.getItem('refreshToken');
    if (!originalRefreshToken) return null;

    const token = await doRefresh();
    if (token) return token;

    // First attempt failed. Wait briefly — another tab or SignalR reconnect
    // may have rotated the token in the meantime.
    await new Promise((r) => setTimeout(r, 1000));

    // Re-read from storage: if the refresh token changed, another code path
    // succeeded and we can just use the new access token it stored.
    const currentRefreshToken = storage.getItem('refreshToken');
    if (currentRefreshToken !== originalRefreshToken) {
      return storage.getItem('token') || null;
    }

    // Same token, retry once more (covers transient network blips).
    const retryToken = await doRefresh();
    if (retryToken) return retryToken;

    // Refresh has definitively failed. Clear tokens and trigger logout now,
    // so parallel requests don't each independently discover the failure.
    storage.removeItem('token');
    storage.removeItem('refreshToken');
    if (onUnauthorized) onUnauthorized();
    return null;
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function getTokenExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = JSON.parse(atob(base64));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Returns a valid token, proactively refreshing if it expires within 2 minutes. */
export async function ensureFreshToken(): Promise<string | null> {
  const token = getStorage().getItem('token');
  if (!token) return null;
  const exp = getTokenExpiry(token);
  if (exp && Date.now() >= exp - 120_000) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;
    // Refresh failed — return the old token only if it hasn't actually expired yet.
    // Sending an expired token just wastes a round-trip to get a 401.
    if (exp && Date.now() < exp) return token;
    return null;
  }
  return token;
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
      // Last resort: another tab may have refreshed while we were retrying.
      // Check if storage has a different (possibly fresh) access token.
      const storedToken = getStorage().getItem('token');
      const sentToken = original.headers?.Authorization?.replace('Bearer ', '');
      if (storedToken && storedToken !== sentToken) {
        const exp = getTokenExpiry(storedToken);
        if (exp && Date.now() < exp) {
          original.headers = original.headers ?? {};
          original.headers.Authorization = `Bearer ${storedToken}`;
          return api(original);
        }
      }
      // Only logout if the current access token is actually expired.
      // If it's still valid, the 401 was for a different reason (permissions etc.)
      // — don't nuke the session.
      const currentToken = getStorage().getItem('token');
      if (currentToken) {
        const exp = getTokenExpiry(currentToken);
        if (exp && Date.now() < exp) {
          return Promise.reject(err);
        }
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
