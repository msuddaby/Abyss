import { app, BrowserWindow, nativeImage, Notification } from 'electron';
import * as path from 'path';

// Keep a reference to the active notification so it doesn't get garbage
// collected before the user clicks it (macOS drops the click handler otherwise).
let activeNotification: Notification | null = null;

let cachedIcon: Electron.NativeImage | undefined;
function getNotificationIcon(): Electron.NativeImage | undefined {
  if (cachedIcon) return cachedIcon;
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png');
    cachedIcon = nativeImage.createFromPath(iconPath);
    if (cachedIcon.isEmpty()) cachedIcon = undefined;
  } catch { /* ignore */ }
  return cachedIcon;
}

// Throttle + dedupe state. On Linux, notification.show() goes through libnotify
// → D-Bus → the desktop notification daemon. A burst of notifications can stall
// the main process if the daemon is slow. We drop native pops when:
//   - any notification fired in the last GLOBAL_FLOOR_MS, or
//   - the same channel fired one in the last PER_KEY_MS.
// In-app toasts (renderer-side) are unaffected — they happen before the IPC.
const GLOBAL_FLOOR_MS = 200;
const PER_KEY_MS = 1000;
const lastFiredByKey = new Map<string, number>();
let lastFiredGlobal = 0;

function shouldDrop(data?: { channelId?: string }): boolean {
  const now = Date.now();
  if (now - lastFiredGlobal < GLOBAL_FLOOR_MS) return true;
  const key = data?.channelId ?? '__global__';
  const last = lastFiredByKey.get(key) ?? 0;
  if (now - last < PER_KEY_MS) return true;
  lastFiredByKey.set(key, now);
  lastFiredGlobal = now;
  // Prevent the map from growing unbounded — drop entries older than PER_KEY_MS*4.
  if (lastFiredByKey.size > 64) {
    for (const [k, t] of lastFiredByKey) {
      if (now - t > PER_KEY_MS * 4) lastFiredByKey.delete(k);
    }
  }
  return false;
}

export function showNotification(
  window: BrowserWindow,
  title: string,
  body: string,
  data?: any
) {
  const focused = window.isFocused();
  const minimized = window.isMinimized();
  const visible = window.isVisible();
  console.log(`[Notifications] State: focused=${focused}, minimized=${minimized}, visible=${visible}`);

  // Don't show notification if window is truly focused and visible
  // (isFocused can be unreliable on Wayland — a minimized window may still
  // report as focused in some KWin versions)
  if (focused && !minimized) {
    return;
  }

  if (!Notification.isSupported()) {
    console.warn('[Notifications] Notification.isSupported() returned false');
    return;
  }

  if (shouldDrop(data)) {
    console.log('[Notifications] Throttled (dedupe/floor) — skipping native pop');
    return;
  }

  // Replace any previous notification reference
  activeNotification = null;

  const notification = new Notification({
    title,
    body,
    silent: false,
    icon: getNotificationIcon(),
  });

  // Hold a strong reference until the notification is dismissed or clicked
  activeNotification = notification;

  const cleanup = () => {
    if (activeNotification === notification) {
      activeNotification = null;
    }
  };

  // When notification is clicked, show window and navigate
  notification.on('click', () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();

    if (data) {
      window.webContents.send('notification-clicked', data);
    }
    cleanup();
  });

  notification.on('close', cleanup);
  notification.on('failed', (_, error) => {
    console.error('[Notifications] Notification failed:', error);
  });
  notification.on('show', () => {
    console.log('[Notifications] Notification displayed successfully');
  });

  // Defer the actual .show() call to the next tick. On Linux this is the
  // critical fix: notification.show() synchronously dispatches a D-Bus call
  // which can block the main-process event loop for hundreds of ms if the
  // notification daemon is slow. By yielding via setImmediate, any queued
  // IPC requests (e.g. ipcMain.handle('is-focused') from the renderer's
  // SignalR handler) get serviced before we block on D-Bus.
  console.log('[Notifications] Scheduling notification.show()');
  const scheduledAt = performance.now();
  setImmediate(() => {
    const start = performance.now();
    try {
      notification.show();
    } catch (err) {
      console.error('[Notifications] notification.show() threw:', err);
      cleanup();
      return;
    }
    const elapsed = performance.now() - start;
    if (elapsed > 500) {
      const queueDelay = start - scheduledAt;
      console.warn(`[Notifications] notification.show() blocked main loop for ${elapsed.toFixed(0)}ms (queue delay ${queueDelay.toFixed(0)}ms) — likely a slow notification daemon`);
    }
  });
}
