import AutoLaunch from 'auto-launch';
import { app } from 'electron';
import Store from 'electron-store';

const store = new Store();

export class AutoLaunchManager {
  private autoLauncher: AutoLaunch;

  constructor() {
    this.autoLauncher = new AutoLaunch({
      name: 'Abyss',
      path: app.getPath('exe'),
      isHidden: false, // Start minimized if true
    });
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
    return store.get('autoLaunch', false) as boolean;
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
