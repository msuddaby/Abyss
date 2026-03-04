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

  console.log('[Notifications] Calling notification.show()');
  notification.show();
}
