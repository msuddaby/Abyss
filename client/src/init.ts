// This module MUST be imported before anything that uses @abyss/shared stores/services.
// It initializes the storage adapter and API base URL.
import { setStorage, setApiBase, setOnUnauthorized, useAuthStore } from '@abyss/shared';

setStorage({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
});

setApiBase(import.meta.env.VITE_API_URL || 'http://localhost:5000');
setOnUnauthorized(() => useAuthStore.getState().logout());
