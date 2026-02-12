import { app, BrowserWindow, Menu, shell } from 'electron';
import { UpdateManager } from './update-manager';

let updateManager: UpdateManager | undefined;
let mainWindow: BrowserWindow | undefined;

export function setupAppMenu(window: BrowserWindow, manager?: UpdateManager) {
  if (process.platform !== 'darwin') return;

  mainWindow = window;
  updateManager = manager;

  buildMenu();

  // Rebuild menu when update status changes so the label stays current
  if (updateManager) {
    window.webContents.on('ipc-message', (_event, channel) => {
      if (channel === 'update-status-changed') {
        buildMenu();
      }
    });
  }
}

function buildMenu() {
  const updateItems = getUpdateMenuItems();

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...updateItems,
        ...(updateItems.length > 0 ? [{ type: 'separator' as const }] : []),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getUpdateMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (!updateManager) return [];

  const manager = updateManager;
  const info = manager.getUpdateInfo();

  switch (info.status) {
    case 'checking':
      return [{ label: 'Checking for Updates...', enabled: false }];

    case 'available':
      return [{
        label: `Update Available (v${info.version})`,
        click: async () => {
          if (info.manualDownloadUrl) {
            shell.openExternal(info.manualDownloadUrl);
          } else {
            await manager.downloadUpdate();
          }
        },
      }];

    case 'downloading':
      return [{ label: `Downloading Update... (${info.progress ?? 0}%)`, enabled: false }];

    case 'downloaded':
      return [{
        label: `Restart to Install v${info.version}`,
        click: () => manager.quitAndInstall(),
      }];

    case 'error':
      return [
        { label: 'Update Check Failed', enabled: false },
        {
          label: 'Try Again',
          click: () => manager.checkForUpdates(true),
        },
      ];

    default:
      return [{
        label: 'Check for Updates...',
        click: () => manager.checkForUpdates(true),
      }];
  }
}
