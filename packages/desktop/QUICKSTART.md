# Abyss Desktop - Quick Start Guide

## First Time Setup

1. **Install dependencies** (from repository root):
   ```bash
   npm install
   ```

2. **Build the web client**:
   ```bash
   cd client
   npm run build
   ```

3. **Compile the desktop app**:
   ```bash
   cd ../packages/desktop
   npx tsc
   ```

## Running in Development

### Option 1: With Hot Reload (Recommended for development)

**Terminal 1** - Start Vite dev server:
```bash
cd client
npm run dev
```

**Terminal 2** - Start Electron:
```bash
cd packages/desktop
npm run dev
```

The Electron app will load the web client from `http://localhost:5173` with hot reload enabled.

### Option 2: Production-like Build

```bash
# Build web client
cd client
ELECTRON=true npm run build

# Run Electron
cd ../packages/desktop
npm start
```

## Building Distributables

### For Your Current Platform

```bash
# From packages/desktop/
npm run make
```

This will create distributable packages in `packages/desktop/out/`:
- **macOS**: `.zip` and `.dmg` files
- **Windows**: `.exe` installer
- **Linux**: `.deb` and `.rpm` packages

### For Specific Platforms

```bash
npm run make -- --platform=darwin  # macOS
npm run make -- --platform=win32   # Windows
npm run make -- --platform=linux   # Linux
```

## Platform-Specific Notes

### macOS

**Accessibility Permissions Required**

On first launch, macOS will prompt you to grant Accessibility permissions for global shortcuts to work.

To grant permissions manually:
1. Open **System Preferences** → **Security & Privacy**
2. Select **Privacy** tab
3. Select **Accessibility** from the left sidebar
4. Click the lock icon and authenticate
5. Add/enable **Abyss** in the list

**Code Signing** (for distribution)

For distributing to other users, you'll need to sign the app:
```bash
# Add to forge.config.js packagerConfig
{
  osxSign: {
    identity: 'Developer ID Application: Your Name (TEAM_ID)'
  },
  osxNotarize: {
    appleId: 'your-apple-id@email.com',
    appleIdPassword: '@keychain:AC_PASSWORD'
  }
}
```

### Windows

**Windows SmartScreen**

Unsigned apps will trigger SmartScreen warnings. To avoid this:
- Sign the app with a code signing certificate
- Or instruct users to click "More info" → "Run anyway"

### Linux

**Dependencies**

Linux builds require these system libraries:
- `libgtk-3-0`
- `libnotify4`
- `libnss3`
- `libxss1`
- `libxtst6`
- `xdg-utils`

On Ubuntu/Debian:
```bash
sudo apt-get install libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils
```

## Features Guide

### Global Push-to-Talk

1. Join a voice channel
2. Set PTT key in settings (Settings → Voice → Push to Talk Key)
3. Choose any keyboard key (e.g., backtick `, F1-F12, etc.)
4. Press the key once to activate mic (indicator turns on)
5. Press again to deactivate mic

**Note**: This uses toggle mode, not hold-to-talk. Mouse buttons are not supported in desktop version.

### Desktop Notifications

Notifications will appear for:
- Direct messages when app is not focused
- @mentions in channels when app is not focused

Clicking a notification will bring the app window to focus.

### System Tray

- Closing the window minimizes the app to system tray
- Voice connections remain active when minimized
- Click tray icon to restore window
- Right-click tray icon → "Quit" to fully close the app

## Troubleshooting

### "App not responding" on launch

Check if the Vite dev server is running on port 5173:
```bash
lsof -i :5173
```

If nothing is running, start it:
```bash
cd client
npm run dev
```

### Global shortcuts not working on macOS

Grant Accessibility permissions (see macOS section above).

### Black screen on launch

The web client might not be built. Run:
```bash
cd client
ELECTRON=true npm run build
```

### TypeScript compilation errors

Make sure TypeScript is compiled:
```bash
cd packages/desktop
npx tsc
```

### Changes not reflecting

- **In dev mode**: Vite should hot reload. Check the dev server is running.
- **In production mode**: Rebuild the web client with `ELECTRON=true npm run build`

## Development Tips

### Debug Main Process

Add this to `main.ts`:
```typescript
if (process.env.NODE_ENV === 'development') {
  require('electron-debug')();
}
```

### Debug Renderer Process

In development mode, DevTools are automatically opened. You can also:
- Press `Cmd+Option+I` (macOS) or `Ctrl+Shift+I` (Windows/Linux)
- Or add to main.ts: `mainWindow.webContents.openDevTools();`

### View IPC Messages

Add logging to `ipc-handlers.ts`:
```typescript
console.log('[IPC]', event, ...args);
```

### Test Notifications

Use the browser console:
```javascript
window.electron?.showNotification('Test', 'This is a test notification');
```

### Test Global Shortcuts

Check the console for registration logs:
```
[GlobalShortcuts] Registering PTT key: `
[GlobalShortcuts] Registered keyboard key: ` as Backquote
```

## Next Steps

1. **Replace placeholder icon** in `packages/desktop/resources/`
2. **Configure auto-updater** (optional) using `electron-updater`
3. **Set up CI/CD** to automatically build releases
4. **Create release notes** for version 1.0.0
5. **Test on all target platforms** before distributing

## Need Help?

- Check `IMPLEMENTATION.md` for architecture details
- Review `README.md` for feature overview
- File issues on GitHub for bugs or feature requests
