import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { StorageAdapter } from '@abyss/shared';

const PRELOAD_KEYS = [
  'token',
  'user',
  'activeServerId',
  'lastChannelByServer',
  'isMuted',
  'isDeafened',
  'voiceMode',
  'pttKey',
];

// Keys stored in SecureStore (Keychain/EncryptedSharedPreferences)
const SECURE_KEYS = new Set(['token']);

const cache = new Map<string, string>();

export async function preloadStorage(): Promise<StorageAdapter> {
  // Preload secure keys from SecureStore
  for (const key of SECURE_KEYS) {
    const value = await SecureStore.getItemAsync(key);
    if (value !== null) {
      cache.set(key, value);
    }
  }

  // Preload remaining keys from AsyncStorage
  const asyncKeys = PRELOAD_KEYS.filter((k) => !SECURE_KEYS.has(k));
  const pairs = await AsyncStorage.multiGet(asyncKeys);
  for (const [key, value] of pairs) {
    if (value !== null) {
      cache.set(key, value);
    }
  }

  return {
    getItem(key: string): string | null {
      return cache.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      cache.set(key, value);
      if (SECURE_KEYS.has(key)) {
        SecureStore.setItemAsync(key, value);
      } else {
        AsyncStorage.setItem(key, value);
      }
    },
    removeItem(key: string): void {
      cache.delete(key);
      if (SECURE_KEYS.has(key)) {
        SecureStore.deleteItemAsync(key);
      } else {
        AsyncStorage.removeItem(key);
      }
    },
  };
}
