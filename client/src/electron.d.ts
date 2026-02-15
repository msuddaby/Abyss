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
  manualDownloadUrl?: string;
}

interface ElectronUpdates {
  checkForUpdates: () => Promise<UpdateInfo>;
  getUpdateInfo: () => Promise<UpdateInfo>;
  downloadUpdate: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
  onUpdateStatusChanged: (callback: (state: UpdateInfo) => void) => () => void;
}

interface ScreenShareSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  isScreen: boolean;
}

interface Window {
  electron?: {
    platform: string;

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

    // Screen share source picker
    onScreenShareSources: (callback: (sources: ScreenShareSource[]) => void) => () => void;
    selectScreenShareSource: (sourceId: string | null) => void;

    // Window state
    isFocused: () => Promise<boolean>;
    onWindowFocusChanged: (callback: (focused: boolean) => void) => () => void; // Returns unsubscribe function
    showWindow: () => void;
    minimizeWindow: () => void;
    toggleMaximize: () => void;
    closeWindow: () => void;
    restartApp: () => void;

    // Update log forwarding
    onUpdateLog: (callback: (msg: string) => void) => () => void;

    // Auto-launch on startup
    autoLaunch: {
      isEnabled: () => Promise<boolean>;
      enable: () => Promise<void>;
      disable: () => Promise<void>;
      setEnabled: (enabled: boolean) => Promise<void>;
    };

    // Auto-updater (only available in production builds)
    updates: ElectronUpdates;
  };
}
