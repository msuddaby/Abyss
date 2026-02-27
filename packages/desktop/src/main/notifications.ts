import { BrowserWindow, Notification } from 'electron';

// Keep a reference to the active notification so it doesn't get garbage
// collected before the user clicks it (macOS drops the click handler otherwise).
let activeNotification: Notification | null = null;

export function showNotification(
  window: BrowserWindow,
  title: string,
  body: string,
  data?: any
) {
  // Don't show notification if window is focused
  if (window.isFocused()) {
    return;
  }

  // Replace any previous notification reference
  activeNotification = null;

  const notification = new Notification({
    title,
    body,
    silent: false,
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

  notification.show();
}
