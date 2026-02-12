import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import log from 'electron-log';
import { showNotification } from './notifications';
import * as https from 'https';

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
  manualDownloadUrl?: string;
}

export class UpdateManager {
  private window: BrowserWindow;
  private updateState: UpdateState = { status: 'idle' };
  private checkInterval?: NodeJS.Timeout;
  private startupCheckTimeout?: NodeJS.Timeout;
  private readonly canAutoUpdate: boolean;

  private static readonly GITHUB_REPO = 'msuddaby/Abyss';

  constructor(window: BrowserWindow) {
    this.window = window;

    // electron-updater only supports AppImage on Linux
    this.canAutoUpdate = !(process.platform === 'linux' && !process.env.APPIMAGE);

    if (this.canAutoUpdate) {
      // Configure electron-updater
      autoUpdater.logger = log;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      // Set up event handlers
      this.setupEventHandlers();
    } else {
      log.info('Auto-update not supported on this platform (non-AppImage Linux). Using GitHub release checks.');
    }

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

  private sendLog(msg: string) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('update-log', msg);
    }
  }

  private updateStatus(state: Partial<UpdateState>) {
    this.updateState = { ...this.updateState, ...state };

    // Forward status transition as log to renderer
    this.sendLog(`Status: ${this.updateState.status}${this.updateState.version ? ` (v${this.updateState.version})` : ''}`);

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
  async checkForUpdates(manual = false): Promise<UpdateState> {
    try {
      if (manual) {
        log.info('Manual update check triggered by user');
        this.sendLog('Manual update check triggered');
      }

      if (this.canAutoUpdate) {
        await autoUpdater.checkForUpdates();
      } else {
        await this.checkGitHubRelease();
      }

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
   * Check GitHub releases API for a newer version (fallback for non-AppImage Linux)
   */
  private checkGitHubRelease(): Promise<void> {
    this.updateStatus({ status: 'checking' });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${UpdateManager.GITHUB_REPO}/releases/latest`,
        headers: { 'User-Agent': `Abyss-Desktop/${app.getVersion()}` },
      };

      https.get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode === 404) {
              this.updateStatus({ status: 'not-available', version: app.getVersion() });
              resolve();
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`GitHub API returned ${res.statusCode}`));
              return;
            }
            const release = JSON.parse(data);
            const latestVersion = (release.tag_name as string).replace(/^v/, '');
            const currentVersion = app.getVersion();

            if (this.isNewerVersion(latestVersion, currentVersion)) {
              log.info(`Update available via GitHub: ${latestVersion}`);
              this.updateStatus({
                status: 'available',
                version: latestVersion,
                manualDownloadUrl: release.html_url,
              });
            } else {
              this.updateStatus({ status: 'not-available', version: currentVersion });
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Compare semver strings: returns true if latest > current
   */
  private isNewerVersion(latest: string, current: string): boolean {
    const l = latest.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < Math.max(l.length, c.length); i++) {
      const lv = l[i] ?? 0;
      const cv = c[i] ?? 0;
      if (lv > cv) return true;
      if (lv < cv) return false;
    }
    return false;
  }

  /**
   * Download available update
   */
  async downloadUpdate(): Promise<void> {
    if (this.updateState.status !== 'available') {
      throw new Error('No update available to download');
    }

    // Non-AppImage Linux: open releases page in browser
    if (!this.canAutoUpdate && this.updateState.manualDownloadUrl) {
      shell.openExternal(this.updateState.manualDownloadUrl);
      return;
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

    // Destroy all windows first to bypass the close-to-tray handler
    // (which calls event.preventDefault() and hides instead of closing)
    BrowserWindow.getAllWindows().forEach(w => w.destroy());

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
