import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // PTT key management
  registerPttKey: (key: string) => {
    ipcRenderer.send('register-ptt-key', key);
  },

  unregisterPttKey: () => {
    ipcRenderer.send('unregister-ptt-key');
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
