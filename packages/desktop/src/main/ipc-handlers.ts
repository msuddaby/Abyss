import { BrowserWindow, ipcMain } from 'electron';
import Store from 'electron-store';
import { GlobalShortcutManager } from './global-shortcuts';
import { showNotification } from './notifications';
import { UpdateManager } from './update-manager';

const store = new Store();

export function setupIpcHandlers(
  window: BrowserWindow,
  shortcutManager: GlobalShortcutManager,
  updateManager?: UpdateManager
) {
  // Register PTT key
  ipcMain.on('register-ptt-key', (_event, key: string) => {
    const success = shortcutManager.registerPttKey(key);
    if (!success) {
      console.error('[IPC] Failed to register PTT key:', key);
    }
  });

  // Unregister PTT key
  ipcMain.on('unregister-ptt-key', () => {
    shortcutManager.unregisterPttKey();
  });

  // Show desktop notification
  ipcMain.on('show-notification', (_event, title: string, body: string, data?: any) => {
    showNotification(window, title, body, data);
  });

  // Check if window is focused
  ipcMain.handle('is-focused', () => {
    return window.isFocused();
  });

  // Show window (from tray or notification)
  ipcMain.on('show-window', () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });

  // Minimize window
  ipcMain.on('minimize-window', () => {
    window.minimize();
  });

  // Maximize/unmaximize window
  ipcMain.on('toggle-maximize', () => {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  // Close window (hide to tray)
  ipcMain.on('close-window', () => {
    window.hide();
  });

  // Synchronous key/value storage for renderer (used by @abyss/shared storage adapter)
  ipcMain.on('store-get', (event, key: string) => {
    const value = store.get(`client.${key}`);
    event.returnValue = value ?? null;
  });
  ipcMain.on('store-set', (event, key: string, value: string) => {
    store.set(`client.${key}`, value);
    event.returnValue = true;
  });
  ipcMain.on('store-remove', (event, key: string) => {
    store.delete(`client.${key}`);
    event.returnValue = true;
  });

  // Update handlers (only available in production)
  if (updateManager) {
    ipcMain.handle('check-for-updates', async () => {
      return await updateManager.checkForUpdates();
    });

    ipcMain.handle('get-update-info', () => {
      return updateManager.getUpdateInfo();
    });

    ipcMain.handle('download-update', async () => {
      return await updateManager.downloadUpdate();
    });

    ipcMain.handle('quit-and-install', () => {
      updateManager.quitAndInstall();
    });
  }
}
