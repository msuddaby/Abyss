# Abyss Desktop

Electron wrapper for the Abyss web client, providing native desktop functionality.

## Features

- **Global Push-to-Talk (PTT)**: Works system-wide, even when the app is not focused
  - **Note**: Uses toggle mode (press once to activate, press again to deactivate) due to Electron API limitations
  - **Limitation**: Mouse buttons not supported; keyboard keys only
- **Desktop Notifications**: OS-level notifications for DMs and mentions
- **System Tray**: Minimize to tray, keep app running in background
- **Window State Persistence**: Remembers window size and position
- **Auto-Updates**: Automatic update checking and installation via electron-updater (production builds only)

## Development

### Prerequisites

1. Install dependencies from the root:
   ```bash
   npm install
   ```

2. Build the web client:
   ```bash
   cd client
   npm run build
   ```

### Running in Development Mode

1. Start the Vite dev server (from root):
   ```bash
   cd client
   npm run dev
   ```

2. In a separate terminal, start Electron:
   ```bash
   cd packages/desktop
   npm run dev
   ```

The Electron app will load the web client from `http://localhost:5173`.

## Building for Production

1. Build the web client:
   ```bash
   cd client
   ELECTRON=true npm run build
   ```

2. Package the Electron app:
   ```bash
   cd packages/desktop
   npm run make
   ```

Distributable packages will be in `packages/desktop/out/`.

## Platform Support

- **macOS**: Requires Accessibility permissions for global PTT
- **Windows**: Full support
- **Linux**: Full support (Debian/Ubuntu and RPM-based distributions)

## Icons

Replace the placeholder icons in `resources/` with actual app icons:

- `icon.png` - Base icon (512x512 recommended)
- `icon.icns` - macOS icon
- `icon.ico` - Windows icon

## Auto-Updates

### Overview

The auto-update system uses:
- **electron-updater** for update logic and download management
- **GitHub Releases** for distribution and hosting update manifests
- **UpdateManager** service in main process to handle update lifecycle
- **IPC bridge** to expose update controls to renderer process
- **Tray menu** integration for user-facing update controls

### Update Flow

1. **Check for updates**
   - On startup (5-minute delay)
   - Every 6 hours automatically
   - Manually via tray menu "Check for Updates"

2. **Update available**
   - Desktop notification shown
   - Tray menu shows "Update available (vX.X.X)"
   - User clicks to download

3. **Downloading**
   - Progress shown in tray menu (0-100%)
   - Download happens in background

4. **Update downloaded**
   - Desktop notification shown
   - Tray menu shows "Restart to install vX.X.X"
   - User clicks to quit and install
   - App restarts and applies update

### Code Signing

#### macOS

**Required for auto-updates to work.** macOS Gatekeeper will block unsigned or improperly signed updates.

**Environment variables** (create `packages/desktop/.env`):

```bash
APPLE_ID=your-apple-id@example.com
APPLE_ID_PASSWORD=app-specific-password
APPLE_TEAM_ID=TEAM123456
APPLE_IDENTITY="Developer ID Application: Your Name (TEAM123456)"
MACOS_CERTIFICATE=base64-encoded-p12
MACOS_CERTIFICATE_PWD=p12-password
```

**Getting credentials:**
- **APPLE_ID**: Your Apple ID email
- **APPLE_ID_PASSWORD**: Generate at [appleid.apple.com](https://appleid.apple.com) → Security → App-Specific Passwords
- **APPLE_TEAM_ID**: 10-character ID from [Apple Developer Portal](https://developer.apple.com/account/)
- **APPLE_IDENTITY**: Full identity string from certificate (found in Keychain Access)
- **MACOS_CERTIFICATE**: Export certificate as .p12, convert with `base64 -i certificate.p12 | pbcopy`

Add the same variables as GitHub Secrets for CI/CD builds.

#### Windows

**Deferred to v1.1** - Without code signing, users see SmartScreen warning on first install. Auto-updates still work after initial install.

### Release Process

1. **Update version** in `packages/desktop/package.json`
2. **Commit and tag**:
   ```bash
   git commit -m "Release desktop v1.0.1"
   git tag v1.0.1
   git push && git push --tags
   ```
3. **GitHub Actions builds automatically** and creates draft release
4. **Review and publish** the release on GitHub

### Testing Auto-Updates

See full documentation in the plan for local testing setup with mock update server and staged rollout strategy.

## Project Structure

```
packages/desktop/
├── src/
│   ├── main/              # Main process (Node.js)
│   │   ├── main.ts        # Entry point
│   │   ├── update-manager.ts  # Auto-update service
│   │   ├── ipc-handlers.ts    # IPC handlers
│   │   ├── tray.ts        # System tray menu
│   │   ├── global-shortcuts.ts  # PTT hotkeys
│   │   └── notifications.ts    # Desktop notifications
│   └── preload/           # Preload scripts (IPC bridge)
│       └── preload.ts
├── resources/             # App icons and assets
├── dist/                  # Compiled TypeScript
├── out/                   # Built packages (git-ignored)
├── entitlements.plist     # macOS hardened runtime permissions
├── forge.config.js        # Electron Forge configuration
├── package.json
└── tsconfig.json
```

## Troubleshooting

### Build Errors

**"Command failed: npm rebuild"**
- Native modules need rebuilding for Electron
- Run: `npm run rebuild`

**"Executable doesn't exist at path"** (macOS)
- Client not built before desktop
- Run: `cd ../../client && npm run build`

### Code Signing Issues

**"No identity found"** (macOS)
- Certificate not in Keychain
- Import `.p12` file via Keychain Access

**Notarization fails**
- Check Apple ID app-specific password is valid
- Ensure Team ID matches certificate

### Auto-Update Issues

**Updates not detected**
- Check GitHub Release is published (not draft)
- Verify update manifests exist in release assets
- Ensure app is packaged (`app.isPackaged === true`)

**Download fails**
- Check network connectivity
- Verify manifest SHA-512 hash matches file

**App won't install update**
- macOS: Verify code signature with `codesign -dv /Applications/Abyss.app`
- Windows: Ensure user has admin rights

## Notes

- iohook requires native compilation and may need rebuilding for Electron's Node.js version
- On first launch, macOS users will be prompted to grant Accessibility permissions for global shortcuts
- Auto-updater only works in packaged production builds, not in development mode
