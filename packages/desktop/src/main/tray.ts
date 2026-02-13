import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from "electron";
import * as path from "path";
import { UpdateManager } from "./update-manager";

let tray: Tray | null = null;
let updateManager: UpdateManager | undefined;

export function setupTray(window: BrowserWindow, manager?: UpdateManager) {
  updateManager = manager;
  // Create tray icon
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "../../resources/icon.png");

  let icon = nativeImage.createFromPath(iconPath);

  // Resize icon for tray (different sizes for different platforms)
  if (process.platform === "darwin") {
    icon = icon.resize({ width: 16, height: 16 });
  } else if (process.platform === "win32") {
    icon = icon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(icon);
  tray.setToolTip("Abyss");

  // Build and set initial menu
  updateTrayMenu(window);

  // Listen for update status changes to update menu
  if (updateManager) {
    window.webContents.on("ipc-message", (event, channel) => {
      if (channel === "update-status-changed") {
        updateTrayMenu(window);
      }
    });
  }

  // Double-click to show window (Windows/Linux)
  tray.on("click", () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });

  // Single click to show window (macOS)
  if (process.platform === "darwin") {
    tray.on("click", () => {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    });
  }

  return tray;
}

function updateTrayMenu(window: BrowserWindow) {
  if (!tray) return;

  const updateMenuItems: Electron.MenuItemConstructorOptions[] = [];

  if (updateManager) {
    const manager = updateManager;
    const updateInfo = manager.getUpdateInfo();

    switch (updateInfo.status) {
      case "checking":
        updateMenuItems.push({
          label: "Checking for updates...",
          enabled: false,
        });
        break;
      case "available":
        updateMenuItems.push({
          label: `Update available (v${updateInfo.version})`,
          click: async () => {
            try {
              if (updateInfo.manualDownloadUrl) {
                shell.openExternal(updateInfo.manualDownloadUrl);
              } else {
                await manager.downloadUpdate();
              }
            } catch (error) {
              console.error("Failed to download update:", error);
            }
          },
        });
        break;
      case "downloading":
        updateMenuItems.push({
          label: `Downloading update... (${updateInfo.progress ?? 0}%)`,
          enabled: false,
        });
        break;
      case "downloaded":
        updateMenuItems.push({
          label: `Restart to install v${updateInfo.version}`,
          click: () => {
            manager.quitAndInstall();
          },
        });
        break;
      case "not-available":
        updateMenuItems.push({
          label: "Check for Updates",
          click: async () => {
            try {
              await manager.checkForUpdates(true);
            } catch (error) {
              console.error("Failed to check for updates:", error);
            }
          },
        });
        break;
      case "error":
        updateMenuItems.push({
          label: "Update check failed",
          enabled: false,
        });
        updateMenuItems.push({
          label: "Try again",
          click: async () => {
            try {
              await manager.checkForUpdates(true);
            } catch (error) {
              console.error("Failed to check for updates:", error);
            }
          },
        });
        break;
      default:
        updateMenuItems.push({
          label: "Check for Updates",
          click: async () => {
            try {
              await manager.checkForUpdates(true);
            } catch (error) {
              console.error("Failed to check for updates:", error);
            }
          },
        });
    }
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Abyss",
      click: () => {
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
      },
    },
    ...(updateMenuItems.length > 0
      ? [{ type: "separator" as const }, ...updateMenuItems]
      : []),
    {
      type: "separator",
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}
