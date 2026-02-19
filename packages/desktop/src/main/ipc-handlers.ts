import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { execFile, ChildProcess } from 'child_process';
import Store from 'electron-store';
import { GlobalShortcutManager } from './global-shortcuts';
import { AutoLaunchManager } from './auto-launch';
import { showNotification } from './notifications';
import { UpdateManager } from './update-manager';
import { getLinuxIdleSeconds } from './linux-idle';

const store = new Store();

// TTS fallback via espeak-ng for Linux (Chromium speechSynthesis is broken)
let ttsProcess: ChildProcess | null = null;

// Shared idle validation state for Windows
let lastReportedIdle = 0;
let lastIdleCheckTime = Date.now();
let consecutiveSuspiciousReads = 0;

export function setupIpcHandlers(
  window: BrowserWindow,
  shortcutManager: GlobalShortcutManager,
  autoLaunchManager: AutoLaunchManager,
  updateManager?: UpdateManager
) {
  // Check accessibility permissions
  ipcMain.handle('check-accessibility-permissions', () => {
    return shortcutManager.hasAccessibilityPermissions();
  });

  // Request accessibility permissions
  ipcMain.on('request-accessibility-permissions', () => {
    shortcutManager.requestAccessibilityPermissions();
  });

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

  // Force-release PTT if stuck (macOS issue workaround)
  ipcMain.on('force-release-ptt', () => {
    shortcutManager.forceReleasePtt();
  });

  // Show desktop notification
  ipcMain.on('show-notification', (_event, title: string, body: string, data?: any) => {
    showNotification(window, title, body, data);
  });

  // TTS via espeak-ng (fallback for Linux where Chromium speechSynthesis is broken)
  ipcMain.on('tts-speak', (_event, text: string) => {
    if (ttsProcess) {
      ttsProcess.kill();
      ttsProcess = null;
    }
    ttsProcess = execFile('espeak-ng', [text], (error) => {
      if (error && (error as any).killed) return; // cancelled
      if (error) console.error('[TTS] espeak-ng error:', error.message);
      ttsProcess = null;
    });
  });

  ipcMain.on('tts-cancel', () => {
    if (ttsProcess) {
      ttsProcess.kill();
      ttsProcess = null;
    }
  });

  // Check if window is focused
  ipcMain.handle('is-focused', () => {
    return window.isFocused();
  });

  // Get system-wide idle time in seconds (with D-Bus fallback on Linux Wayland)
  ipcMain.handle('get-system-idle-time', async () => {
    const now = Date.now();
    const timeSinceLastCheck = (now - lastIdleCheckTime) / 1000;
    lastIdleCheckTime = now;

    const electronIdle = powerMonitor.getSystemIdleTime();

    if (electronIdle > 0) {
      // On Windows, validate idle time to detect when the API is unreliable
      // (e.g., when games are active but window is minimized)
      if (process.platform === 'win32' && lastReportedIdle > 0) {
        const expectedIncrease = Math.min(timeSinceLastCheck, 600); // Cap at 10 min
        const actualIncrease = electronIdle - lastReportedIdle;

        // Check for suspicious patterns:
        // 1. Idle time jumped from <60s to 600+s without gradual increase
        // 2. Idle time decreased unexpectedly (should only happen on user input)
        const isSuspiciousJump = (
          lastReportedIdle < 60 &&
          electronIdle >= 600 &&
          timeSinceLastCheck < 120
        );
        const isNegativeChange = electronIdle < lastReportedIdle - 30;

        if (isSuspiciousJump || isNegativeChange) {
          consecutiveSuspiciousReads++;
          console.log(`[Idle] Suspicious idle reading on Windows: ${electronIdle}s (was ${lastReportedIdle}s after ${timeSinceLastCheck.toFixed(1)}s)`);

          // If we see multiple suspicious readings, the API is unreliable
          if (consecutiveSuspiciousReads >= 2) {
            console.log('[Idle] Windows idle detection appears unreliable, returning 0');
            lastReportedIdle = 0;
            return 0;
          }
        } else if (electronIdle < 60) {
          // Reset counter when we see genuine activity
          consecutiveSuspiciousReads = 0;
        }
      }

      lastReportedIdle = electronIdle;
      return electronIdle;
    }

    // Linux D-Bus fallback
    if (process.platform === 'linux') {
      const dbusIdle = await getLinuxIdleSeconds();
      if (dbusIdle !== null) {
        lastReportedIdle = dbusIdle;
        return dbusIdle;
      }
    }

    lastReportedIdle = 0;
    return 0;
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

  // Restart app
  ipcMain.on('restart-app', () => {
    app.relaunch();
    app.exit(0);
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

  // Auto-launch handlers
  ipcMain.handle('auto-launch-is-enabled', async () => {
    return await autoLaunchManager.isEnabled();
  });

  ipcMain.handle('auto-launch-enable', async () => {
    await autoLaunchManager.enable();
  });

  ipcMain.handle('auto-launch-disable', async () => {
    await autoLaunchManager.disable();
  });

  ipcMain.handle('auto-launch-set-enabled', async (_event, enabled: boolean) => {
    await autoLaunchManager.setEnabled(enabled);
  });

  // Update handlers (only available in production)
  if (updateManager) {
    ipcMain.handle('check-for-updates', async () => {
      return await updateManager.checkForUpdates(true);
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
