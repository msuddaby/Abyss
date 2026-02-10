import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { setupIpcHandlers } from './ipc-handlers';
import { GlobalShortcutManager } from './global-shortcuts';
import { setupTray } from './tray';
import { UpdateManager } from './update-manager';
import Store from 'electron-store';

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require('electron-squirrel-startup')) {
  app.quit();
}

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let shortcutManager: GlobalShortcutManager | null = null;
let updateManager: UpdateManager | null = null;
let isQuitting = false;

function createWindow() {
  // Restore window state
  const windowBounds = store.get('windowBounds', {
    width: 1200,
    height: 800,
  }) as { width: number; height: number; x?: number; y?: number };

  mainWindow = new BrowserWindow({
    ...windowBounds,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for iohook
      backgroundThrottling: false, // Keep renderer active when hidden to tray
    },
    show: false, // Don't show until ready
  });

  // Save window bounds on resize/move
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Production: load from built client
    const clientPath = app.isPackaged
      ? path.join(process.resourcesPath, 'dist/index.html')
      : path.join(__dirname, '../../../../client/dist/index.html');

    mainWindow.loadFile(clientPath);
  }

  // Initialize global shortcut manager
  shortcutManager = new GlobalShortcutManager(mainWindow);

  // Initialize update manager (only in production)
  if (app.isPackaged) {
    updateManager = new UpdateManager(mainWindow);
  }

  // Setup IPC handlers
  setupIpcHandlers(mainWindow, shortcutManager, updateManager ?? undefined);

  // Setup system tray
  setupTray(mainWindow, updateManager ?? undefined);

  // Handle window close (minimize to tray instead of quit)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

// This method will be called when Electron has finished initialization
app.whenReady().then(createWindow);

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked and no windows open
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
  }
});

// Clean up global shortcuts and update manager on quit
app.on('will-quit', () => {
  shortcutManager?.cleanup();
  updateManager?.cleanup();
});

// Handle quit event from tray
app.on('before-quit', () => {
  isQuitting = true;
});
