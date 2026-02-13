import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

/**
 * On Linux AppImage, install/update a .desktop file and icon so the app
 * appears in the application menu with a stable entry, even when the
 * AppImage filename changes across updates.
 */
export function installDesktopEntry(): void {
  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return;

  try {
    const applicationsDir = path.join(app.getPath('home'), '.local', 'share', 'applications');
    const iconsDir = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor', '256x256', 'apps');

    fs.mkdirSync(applicationsDir, { recursive: true });
    fs.mkdirSync(iconsDir, { recursive: true });

    // Copy icon to a stable location
    const iconSource = path.join(process.resourcesPath, 'icon.png');
    const iconDest = path.join(iconsDir, 'abyss-desktop.png');
    if (fs.existsSync(iconSource)) {
      fs.copyFileSync(iconSource, iconDest);
    }

    const desktopEntry = `[Desktop Entry]
Name=Abyss
Comment=Voice and text chat
Exec="${appImagePath}" %U
Icon=abyss-desktop
Terminal=false
Type=Application
Categories=Network;InstantMessaging;
MimeType=x-scheme-handler/abyss;
StartupWMClass=abyss-desktop
X-AppImage-Version=${app.getVersion()}
`;

    const desktopFilePath = path.join(applicationsDir, 'abyss-desktop.desktop');
    fs.writeFileSync(desktopFilePath, desktopEntry, { mode: 0o755 });

    log.info(`Desktop entry installed: ${desktopFilePath} -> ${appImagePath}`);
  } catch (error) {
    log.error('Failed to install desktop entry:', error);
  }
}
