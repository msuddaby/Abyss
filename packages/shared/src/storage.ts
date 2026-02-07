export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storage: StorageAdapter | null = null;

export function setStorage(s: StorageAdapter): void {
  storage = s;
}

export function getStorage(): StorageAdapter {
  if (!storage) throw new Error('StorageAdapter not initialized. Call setStorage() before using stores.');
  return storage;
}
