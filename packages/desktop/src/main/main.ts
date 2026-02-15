import { app, BrowserWindow, desktopCapturer, ipcMain, net, powerMonitor, protocol, session, shell } from 'electron';
import * as path from 'path';
import { setupIpcHandlers } from './ipc-handlers';
import { GlobalShortcutManager } from './global-shortcuts';
import { setupTray } from './tray';
import { setupAppMenu } from './app-menu';
import { UpdateManager } from './update-manager';
import { AutoLaunchManager } from './auto-launch';
import { installDesktopEntry } from './linux-desktop-integration';
import Store from 'electron-store';

// Legacy Squirrel.Windows handler — only relevant if the app was installed via
// the old Squirrel-based installer. Safe to leave: it simply checks for
// Squirrel CLI flags and exits early when found.
try {
  if (require('electron-squirrel-startup')) {
    app.quit();
  }
} catch {
  // electron-squirrel-startup not installed (NSIS builds); nothing to do.
}

// Register custom scheme before app is ready — gives the renderer a real
// origin (app://abyss) instead of file://, which fixes YouTube embedding
// (error 150/153) and other web APIs that reject null/file:// origins.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  }
}]);

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let shortcutManager: GlobalShortcutManager | null = null;
let updateManager: UpdateManager | null = null;
let autoLaunchManager: AutoLaunchManager | null = null;
let isQuitting = false;

function setupScreenShareHandler(win: BrowserWindow) {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });

      const serialized = sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
        isScreen: source.id.startsWith('screen:'),
      }));

      win.webContents.send('screen-share-sources', serialized);

      // Wait for renderer to pick a source (or cancel)
      const sourceId = await new Promise<string | null>((resolve) => {
        const handler = (_event: any, id: string | null) => {
          resolve(id);
        };
        ipcMain.once('screen-share-selected', handler);
      });

      if (sourceId) {
        const selected = sources.find((s) => s.id === sourceId);
        if (selected) {
          callback({ video: selected, audio: 'loopback' });
          return;
        }
      }

      // Cancel — rejects getDisplayMedia, caught by existing catch block
      callback({});
    } catch {
      callback({});
    }
  });
}

function createWindow() {
  // Serve production app files via custom 'app://' protocol so the renderer
  // gets a real origin (app://abyss) instead of file://. This gives us a
  // proper secure context and avoids null-origin CORS issues.
  if (process.env.NODE_ENV !== 'development') {
    const clientDir = app.isPackaged
      ? path.join(process.resourcesPath, 'dist')
      : path.join(__dirname, '../../../../client/dist');

    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let filePath = path.normalize(path.join(clientDir, decodeURIComponent(url.pathname)));

      // Prevent directory traversal
      if (!filePath.startsWith(clientDir)) {
        return new Response('Forbidden', { status: 403 });
      }

      // SPA fallback: serve index.html for routes without a file extension
      if (!path.extname(filePath)) {
        filePath = path.join(clientDir, 'index.html');
      }

      return net.fetch(`file://${filePath}`);
    });
  }

  // YouTube rejects embeds from non-HTTP(S) origins and also blocks self-referral
  // (Referer containing "youtube"). From app://, the browser sends no Referer at
  // all, so we always set a valid non-YouTube HTTPS Referer.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.youtube.com/*', 'https://*.youtube-nocookie.com/*'] },
    (details, callback) => {
      const ref = details.requestHeaders['Referer'];
      if (!ref || !ref.startsWith('https://') || ref.includes('youtube')) {
        details.requestHeaders['Referer'] = 'https://abyss-player.app/';
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Set Content Security Policy (only for our own pages, not third-party iframes)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isOwnPage =
      details.url.startsWith('app://') ||
      details.url.startsWith('file://') ||
      details.url.startsWith('http://localhost');

    if (!isOwnPage) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const csp = [
      "default-src 'self'",
      process.env.NODE_ENV === 'development'
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com"
        : "script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' http: https: ws: wss:",
      "img-src 'self' data: blob: http: https:",
      "media-src 'self' blob: mediastream: http: https:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
    ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // Restore window state
  const windowBounds = store.get('windowBounds', {
    width: 1200,
    height: 800,
  }) as { width: number; height: number; x?: number; y?: number };

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../resources/icon.png');

  mainWindow = new BrowserWindow({
    ...windowBounds,
    icon: iconPath,
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

  // Open external links in the default browser instead of in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Prevent the main window from navigating away from the app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigins = ['http://localhost:5173', 'app://', 'file://'];
    if (!appOrigins.some((origin) => url.startsWith(origin))) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('app://abyss/');
  }

  // Initialize global shortcut manager
  shortcutManager = new GlobalShortcutManager(mainWindow);

  // Initialize update manager (only in production)
  if (app.isPackaged) {
    updateManager = new UpdateManager(mainWindow);
  }

  // Initialize auto-launch manager
  autoLaunchManager = new AutoLaunchManager();

  // Setup screen share handler (intercepts getDisplayMedia)
  // On Linux, the renderer uses getUserMedia with chromeMediaSource instead of
  // getDisplayMedia to avoid the PipeWire double-dialog issue
  if (process.platform !== 'linux') {
    setupScreenShareHandler(mainWindow);
  }

  // Setup IPC handlers
  setupIpcHandlers(mainWindow, shortcutManager, autoLaunchManager, updateManager ?? undefined);

  // Setup system tray
  setupTray(mainWindow, updateManager ?? undefined);

  // Setup macOS application menu (top-left menu bar with Check for Updates)
  setupAppMenu(mainWindow, updateManager ?? undefined);

  // Handle window close (minimize to tray instead of quit)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Send focus/blur events to renderer for animation pausing
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-changed', true);
  });

  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-changed', false);
  });

  // Forward screen lock/unlock events to renderer for idle detection.
  // The renderer's setInterval-based polling gets throttled by macOS when
  // the screen is locked, so this ensures away status is set immediately.
  powerMonitor.on('lock-screen', () => {
    mainWindow?.webContents.send('screen-lock-changed', true);
  });
  powerMonitor.on('unlock-screen', () => {
    mainWindow?.webContents.send('screen-lock-changed', false);
  });
}

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  if (process.platform === 'linux') {
    installDesktopEntry();
  }
  createWindow();
});

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
