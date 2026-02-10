import { app, BrowserWindow } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import log from 'electron-log';
import { showNotification } from './notifications';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  progress?: number;
  error?: string;
}

export class UpdateManager {
  private window: BrowserWindow;
  private updateState: UpdateState = { status: 'idle' };
  private checkInterval?: NodeJS.Timeout;
  private startupCheckTimeout?: NodeJS.Timeout;

  constructor(window: BrowserWindow) {
    this.window = window;

    // Configure electron-updater
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Set up event handlers
    this.setupEventHandlers();

    // Schedule periodic checks: startup (5min delay) + every 6 hours
    this.schedulePeriodicChecks();
  }

  private setupEventHandlers() {
    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for updates...');
      this.updateStatus({ status: 'checking' });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log.info('Update available:', info.version);
      this.updateStatus({
        status: 'available',
        version: info.version
      });

      // Show notification if window not focused
      showNotification(
        this.window,
        'Update Available',
        `Version ${info.version} is available. Click to download.`,
        { type: 'update-available', version: info.version }
      );
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      log.info('Update not available. Current version:', info.version);
      this.updateStatus({
        status: 'not-available',
        version: info.version
      });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      log.info(`Download progress: ${progress.percent.toFixed(2)}%`);
      this.updateStatus({
        status: 'downloading',
        progress: Math.round(progress.percent)
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log.info('Update downloaded:', info.version);
      this.updateStatus({
        status: 'downloaded',
        version: info.version
      });

      // Show notification
      showNotification(
        this.window,
        'Update Ready',
        `Version ${info.version} has been downloaded. Restart to install.`,
        { type: 'update-downloaded', version: info.version }
      );
    });

    autoUpdater.on('error', (error) => {
      log.error('Update error:', error);
      this.updateStatus({
        status: 'error',
        error: error.message
      });
    });
  }

  private updateStatus(state: Partial<UpdateState>) {
    this.updateState = { ...this.updateState, ...state };

    // Send update to renderer process
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('update-status-changed', this.updateState);
    }
  }

  private schedulePeriodicChecks() {
    // Check on startup after 5 minutes
    this.startupCheckTimeout = setTimeout(() => {
      this.checkForUpdates();
    }, 5 * 60 * 1000);

    // Check every 6 hours
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * Manually check for updates
   */
  async checkForUpdates(): Promise<UpdateState> {
    try {
      await autoUpdater.checkForUpdates();
      return this.updateState;
    } catch (error) {
      log.error('Failed to check for updates:', error);
      this.updateStatus({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return this.updateState;
    }
  }

  /**
   * Download available update
   */
  async downloadUpdate(): Promise<void> {
    if (this.updateState.status !== 'available') {
      throw new Error('No update available to download');
    }

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      log.error('Failed to download update:', error);
      throw error;
    }
  }

  /**
   * Install downloaded update and restart app
   */
  quitAndInstall(): void {
    if (this.updateState.status !== 'downloaded') {
      throw new Error('No update downloaded to install');
    }

    // This will quit the app and install the update
    autoUpdater.quitAndInstall(false, true);
  }

  /**
   * Get current update state
   */
  getUpdateInfo(): UpdateState {
    return { ...this.updateState };
  }

  /**
   * Cleanup on app quit
   */
  cleanup(): void {
    if (this.startupCheckTimeout) {
      clearTimeout(this.startupCheckTimeout);
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}
