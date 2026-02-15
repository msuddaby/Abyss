import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // PTT key management
  registerPttKey: (key: string) => {
    ipcRenderer.send('register-ptt-key', key);
  },

  unregisterPttKey: () => {
    ipcRenderer.send('unregister-ptt-key');
  },

  forceReleasePtt: () => {
    ipcRenderer.send('force-release-ptt');
  },

  onGlobalPttPress: (callback: () => void) => {
    const subscription = (_event: any) => callback();
    ipcRenderer.on('global-ptt-press', subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('global-ptt-press', subscription);
    };
  },

  onGlobalPttRelease: (callback: () => void) => {
    const subscription = (_event: any) => callback();
    ipcRenderer.on('global-ptt-release', subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('global-ptt-release', subscription);
    };
  },

  // Persistent storage (electron-store via main process)
  getStoreItem: (key: string) => {
    return ipcRenderer.sendSync('store-get', key);
  },
  setStoreItem: (key: string, value: string) => {
    ipcRenderer.sendSync('store-set', key, value);
  },
  removeStoreItem: (key: string) => {
    ipcRenderer.sendSync('store-remove', key);
  },

  // Notifications
  showNotification: (title: string, body: string, data?: any) => {
    ipcRenderer.send('show-notification', title, body, data);
  },

  onNotificationClicked: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('notification-clicked', subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('notification-clicked', subscription);
    };
  },

  // Window state
  isFocused: async (): Promise<boolean> => {
    return await ipcRenderer.invoke('is-focused');
  },

  getSystemIdleTime: async (): Promise<number> => {
    return await ipcRenderer.invoke('get-system-idle-time');
  },

  onWindowFocusChanged: (callback: (focused: boolean) => void) => {
    const subscription = (_event: any, focused: boolean) => callback(focused);
    ipcRenderer.on('window-focus-changed', subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('window-focus-changed', subscription);
    };
  },

  onScreenLockChanged: (callback: (locked: boolean) => void) => {
    const subscription = (_event: any, locked: boolean) => callback(locked);
    ipcRenderer.on('screen-lock-changed', subscription);

    return () => {
      ipcRenderer.removeListener('screen-lock-changed', subscription);
    };
  },

  showWindow: () => {
    ipcRenderer.send('show-window');
  },

  minimizeWindow: () => {
    ipcRenderer.send('minimize-window');
  },

  toggleMaximize: () => {
    ipcRenderer.send('toggle-maximize');
  },

  closeWindow: () => {
    ipcRenderer.send('close-window');
  },

  restartApp: () => {
    ipcRenderer.send('restart-app');
  },

  // Update log forwarding from main process
  onUpdateLog: (callback: (msg: string) => void) => {
    const subscription = (_event: any, msg: string) => callback(msg);
    ipcRenderer.on('update-log', subscription);
    return () => {
      ipcRenderer.removeListener('update-log', subscription);
    };
  },

  // Screen share source picker
  onScreenShareSources: (callback: (sources: any[]) => void) => {
    const subscription = (_event: any, sources: any[]) => callback(sources);
    ipcRenderer.on('screen-share-sources', subscription);
    return () => {
      ipcRenderer.removeListener('screen-share-sources', subscription);
    };
  },

  selectScreenShareSource: (sourceId: string | null) => {
    ipcRenderer.send('screen-share-selected', sourceId);
  },

  // Auto-launch on startup
  autoLaunch: {
    isEnabled: async () => {
      return await ipcRenderer.invoke('auto-launch-is-enabled');
    },

    enable: async () => {
      return await ipcRenderer.invoke('auto-launch-enable');
    },

    disable: async () => {
      return await ipcRenderer.invoke('auto-launch-disable');
    },

    setEnabled: async (enabled: boolean) => {
      return await ipcRenderer.invoke('auto-launch-set-enabled', enabled);
    },
  },

  // Auto-updater (only available in production builds)
  updates: {
    checkForUpdates: async () => {
      return await ipcRenderer.invoke('check-for-updates');
    },

    getUpdateInfo: async () => {
      return await ipcRenderer.invoke('get-update-info');
    },

    downloadUpdate: async () => {
      return await ipcRenderer.invoke('download-update');
    },

    quitAndInstall: async () => {
      return await ipcRenderer.invoke('quit-and-install');
    },

    onUpdateStatusChanged: (callback: (state: any) => void) => {
      const subscription = (_event: any, state: any) => callback(state);
      ipcRenderer.on('update-status-changed', subscription);

      // Return unsubscribe function
      return () => {
        ipcRenderer.removeListener('update-status-changed', subscription);
      };
    },
  },
});
