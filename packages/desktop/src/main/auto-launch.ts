import AutoLaunch from 'auto-launch';
import { app } from 'electron';
import Store from 'electron-store';
import * as path from 'path';
import * as fs from 'fs';

const store = new Store();

/**
 * Get the correct executable path for auto-launch.
 * On Linux AppImage, app.getPath('exe') returns a temp FUSE mount path
 * that doesn't persist across reboots. Use the stable symlink instead.
 */
function getAutoLaunchPath(): string {
  const appImagePath = process.env.APPIMAGE;
  if (appImagePath) {
    // Prefer the stable symlink so auto-launch survives updates
    const stablePath = path.join(path.dirname(appImagePath), 'Abyss.AppImage');
    if (fs.existsSync(stablePath)) {
      return stablePath;
    }
    return appImagePath;
  }
  return app.getPath('exe');
}

export class AutoLaunchManager {
  private autoLauncher: AutoLaunch;

  constructor() {
    this.autoLauncher = new AutoLaunch({
      name: 'Abyss',
      path: getAutoLaunchPath(),
      isHidden: false, // Start minimized if true
    });

    // Enable auto-launch by default on first run
    this.initializeAutoLaunch();
  }

  /**
   * Initialize auto-launch on first run
   */
  private async initializeAutoLaunch(): Promise<void> {
    try {
      // Check if autoLaunch preference has been set before
      const hasPreference = store.has('autoLaunch');

      if (!hasPreference) {
        // First run - enable auto-launch by default
        await this.enable();
        console.log('[AutoLaunch] Enabled by default on first run');
      }
    } catch (error) {
      console.error('[AutoLaunch] Failed to initialize:', error);
    }
  }

  /**
   * Enable auto-launch on system startup
   */
  async enable(): Promise<void> {
    try {
      await this.autoLauncher.enable();
      store.set('autoLaunch', true);
      console.log('[AutoLaunch] Enabled');
    } catch (error) {
      console.error('[AutoLaunch] Failed to enable:', error);
      throw error;
    }
  }

  /**
   * Disable auto-launch on system startup
   */
  async disable(): Promise<void> {
    try {
      await this.autoLauncher.disable();
      store.set('autoLaunch', false);
      console.log('[AutoLaunch] Disabled');
    } catch (error) {
      console.error('[AutoLaunch] Failed to disable:', error);
      throw error;
    }
  }

  /**
   * Check if auto-launch is currently enabled
   */
  async isEnabled(): Promise<boolean> {
    try {
      return await this.autoLauncher.isEnabled();
    } catch (error) {
      console.error('[AutoLaunch] Failed to check status:', error);
      return false;
    }
  }

  /**
   * Get the stored preference (used for settings UI)
   */
  getStoredPreference(): boolean {
    return store.get('autoLaunch', true) as boolean;
  }

  /**
   * Set auto-launch based on boolean value
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.enable();
    } else {
      await this.disable();
    }
  }
}
