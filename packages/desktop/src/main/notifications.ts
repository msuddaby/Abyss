import { BrowserWindow, Notification } from 'electron';

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

  const notification = new Notification({
    title,
    body,
    silent: false,
  });

  // When notification is clicked, show window
  notification.on('click', () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();

    // If data contains message/channel info, we could send it to renderer
    // to navigate to the relevant conversation
    if (data) {
      window.webContents.send('notification-clicked', data);
    }
  });

  notification.show();
}
