import axios from 'axios';
import { getStorage } from '../storage.js';

let apiBase = 'http://localhost:5000';

export function getApiBase(): string {
  return apiBase;
}

export function setApiBase(url: string): void {
  apiBase = url;
  api.defaults.baseURL = `${url}/api`;
}

const api = axios.create({
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

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    return Promise.reject(err);
  },
);

export default api;

export async function uploadFile(file: File): Promise<{ id: string; url: string; fileName: string; contentType: string; size: number }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
