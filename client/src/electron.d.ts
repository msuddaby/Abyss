type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface UpdateInfo {
  status: UpdateStatus;
  version?: string;
  progress?: number;
  error?: string;
}

interface ElectronUpdates {
  checkForUpdates: () => Promise<UpdateInfo>;
  getUpdateInfo: () => Promise<UpdateInfo>;
  downloadUpdate: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
  onUpdateStatusChanged: (callback: (state: UpdateInfo) => void) => () => void;
}

interface Window {
  electron?: {
    // PTT key management
    registerPttKey: (key: string) => void;
    unregisterPttKey: () => void;
    onGlobalPttPress: (callback: () => void) => () => void; // Returns unsubscribe function
    onGlobalPttRelease: (callback: () => void) => () => void; // Returns unsubscribe function

    // Persistent storage (electron-store via main process)
    getStoreItem: (key: string) => string | null;
    setStoreItem: (key: string, value: string) => void;
    removeStoreItem: (key: string) => void;

    // Notifications
    showNotification: (title: string, body: string, data?: any) => void;
    onNotificationClicked: (callback: (data: any) => void) => () => void; // Returns unsubscribe function

    // Window state
    isFocused: () => Promise<boolean>;
    showWindow: () => void;
    minimizeWindow: () => void;
    toggleMaximize: () => void;
    closeWindow: () => void;

    // Auto-updater (only available in production builds)
    updates: ElectronUpdates;
  };
}
