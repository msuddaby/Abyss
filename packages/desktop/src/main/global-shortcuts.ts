import { BrowserWindow, systemPreferences } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';

/**
 * Global shortcut manager for PTT functionality using uiohook-napi.
 *
 * Uses native OS-level keyboard/mouse hooks to detect both key press AND release,
 * enabling true hold-to-talk PTT (hold key = mic on, release key = mic off).
 * Also supports mouse button PTT bindings.
 */
export class GlobalShortcutManager {
  private window: BrowserWindow;
  private currentKey: string | null = null;
  private targetKeyCode: number | null = null;
  private targetMouseButton: number | null = null;
  private isPttActive = false;
  private started = false;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.checkAccessibilityPermissions();
  }

  /**
   * Check if accessibility permissions are granted (macOS only).
   * Returns true if permissions are granted or not required (non-macOS).
   */
  hasAccessibilityPermissions(): boolean {
    if (process.platform !== 'darwin') {
      return true;
    }
    return systemPreferences.isTrustedAccessibilityClient(false);
  }

  /**
   * Prompt user to grant accessibility permissions (macOS only).
   * This will show the system dialog asking for permissions.
   */
  requestAccessibilityPermissions(): void {
    if (process.platform === 'darwin') {
      systemPreferences.isTrustedAccessibilityClient(true);
    }
  }

  private checkAccessibilityPermissions(): void {
    if (process.platform === 'darwin') {
      const hasAccess = this.hasAccessibilityPermissions();
      if (!hasAccess) {
        console.warn('[GlobalShortcuts] Accessibility permissions not granted.');
        console.warn('[GlobalShortcuts] Call requestAccessibilityPermissions() to prompt user.');
      }
    }

    uIOhook.on('keydown', (e) => {
      console.log('[GlobalShortcuts] keydown event:', {
        keycode: e.keycode,
        targetKeyCode: this.targetKeyCode,
        isPttActive: this.isPttActive,
        platform: process.platform
      });

      if (this.targetKeyCode !== null && e.keycode === this.targetKeyCode) {
        // On macOS, force-reset if already active (stuck state protection)
        if (this.isPttActive && process.platform === 'darwin') {
          console.warn('[GlobalShortcuts] PTT was stuck active, resetting before new press');
          this.isPttActive = false;
          this.window.webContents.send('global-ptt-release');
        }

        if (!this.isPttActive) {
          this.isPttActive = true;
          console.log('[GlobalShortcuts] PTT activated');
          this.window.webContents.send('global-ptt-press');
        }
      }
    });

    uIOhook.on('keyup', (e) => {
      console.log('[GlobalShortcuts] keyup event:', {
        keycode: e.keycode,
        targetKeyCode: this.targetKeyCode,
        isPttActive: this.isPttActive,
        platform: process.platform
      });

      if (this.targetKeyCode !== null && e.keycode === this.targetKeyCode && this.isPttActive) {
        this.isPttActive = false;
        console.log('[GlobalShortcuts] PTT deactivated');
        this.window.webContents.send('global-ptt-release');
      }
    });

    // Debug: log ALL mouse events (even non-target buttons)
    if (process.platform === 'darwin') {
      uIOhook.on('mousedown', (e) => {
        console.log('[GlobalShortcuts] [DEBUG] Any mousedown:', e.button);
      });
      uIOhook.on('mouseup', (e) => {
        console.log('[GlobalShortcuts] [DEBUG] Any mouseup:', e.button);
      });
    }

    uIOhook.on('mousedown', (e) => {
      const button = e.button as number;
      console.log('[GlobalShortcuts] ========== MOUSEDOWN ==========');
      console.log('[GlobalShortcuts] Raw event:', JSON.stringify(e, null, 2));
      console.log('[GlobalShortcuts] Button:', button);
      console.log('[GlobalShortcuts] Target button:', this.targetMouseButton);
      console.log('[GlobalShortcuts] PTT active:', this.isPttActive);
      console.log('[GlobalShortcuts] Window focused:', this.window.isFocused());
      console.log('[GlobalShortcuts] ================================');

      if (this.targetMouseButton !== null && button === this.targetMouseButton) {
        // On macOS, force-reset if already active (stuck state protection)
        if (this.isPttActive && process.platform === 'darwin') {
          console.warn('[GlobalShortcuts] PTT was stuck active, resetting before new press');
          this.isPttActive = false;
          this.window.webContents.send('global-ptt-release');
        }

        if (!this.isPttActive) {
          this.isPttActive = true;
          console.log('[GlobalShortcuts] ✓ PTT ACTIVATED (mouse)');
          this.window.webContents.send('global-ptt-press');
        }
      }
    });

    uIOhook.on('mouseup', (e) => {
      const button = e.button as number;
      console.log('[GlobalShortcuts] ========== MOUSEUP ==========');
      console.log('[GlobalShortcuts] Raw event:', JSON.stringify(e, null, 2));
      console.log('[GlobalShortcuts] Button:', button);
      console.log('[GlobalShortcuts] Target button:', this.targetMouseButton);
      console.log('[GlobalShortcuts] PTT active:', this.isPttActive);
      console.log('[GlobalShortcuts] Window focused:', this.window.isFocused());
      console.log('[GlobalShortcuts] Match:', this.targetMouseButton !== null && button === this.targetMouseButton);
      console.log('[GlobalShortcuts] ================================');

      if (this.targetMouseButton !== null && button === this.targetMouseButton && this.isPttActive) {
        this.isPttActive = false;
        console.log('[GlobalShortcuts] ✓ PTT DEACTIVATED (mouse)');
        this.window.webContents.send('global-ptt-release');
      } else if (this.targetMouseButton !== null && button === this.targetMouseButton && !this.isPttActive) {
        console.warn('[GlobalShortcuts] ⚠️  MOUSEUP received but PTT was not active!');
      }
    });

    // Safety timeout to detect stuck PTT (macOS issue workaround)
    // If PTT stays active for more than 10 seconds, likely stuck
    if (process.platform === 'darwin') {
      let pttActivatedAt = 0;

      uIOhook.on('keydown', () => {
        if (this.isPttActive) pttActivatedAt = Date.now();
      });

      uIOhook.on('mousedown', () => {
        if (this.isPttActive) pttActivatedAt = Date.now();
      });

      setInterval(() => {
        if (this.isPttActive && pttActivatedAt > 0) {
          const elapsed = Date.now() - pttActivatedAt;
          if (elapsed > 10000) {
            console.warn('[GlobalShortcuts] PTT stuck for 10+ seconds, force-releasing');
            this.isPttActive = false;
            pttActivatedAt = 0;
            this.window.webContents.send('global-ptt-release');
          }
        }
      }, 1000);
    }
  }

  private ensureStarted(): void {
    if (!this.started) {
      // Check for accessibility permissions on macOS
      if (process.platform === 'darwin') {
        const hasAccess = systemPreferences.isTrustedAccessibilityClient(false);
        const isDev = process.env.NODE_ENV === 'development';

        if (!hasAccess) {
          console.warn('[GlobalShortcuts] Accessibility permissions not granted.');

          if (isDev) {
            console.warn('[GlobalShortcuts] Running in dev mode - attempting to start uIOhook anyway...');
            console.warn('[GlobalShortcuts] If PTT does not work, you may need to grant permissions to:');
            console.warn('[GlobalShortcuts]   - Electron.app in node_modules/electron/dist/');
            console.warn('[GlobalShortcuts]   - Or use: npm run package to create a dev build');
          } else {
            console.warn('[GlobalShortcuts] Please grant accessibility permissions in System Settings.');
            return;
          }
        }
      }

      try {
        uIOhook.start();
        this.started = true;
        console.log('[GlobalShortcuts] uIOhook started successfully');
      } catch (error) {
        console.error('[GlobalShortcuts] Failed to start uIOhook:', error);
        this.started = false;
      }
    }
  }

  /**
   * Register a PTT key for hold-to-talk.
   * @param key Key in web format (e.g., "`", "Space", "Mouse3")
   */
  registerPttKey(key: string): boolean {
    console.log('[GlobalShortcuts] ========================================');
    console.log('[GlobalShortcuts] Registering PTT key:', key);
    console.log('[GlobalShortcuts] Platform:', process.platform);

    this.unregisterPttKey();

    if (key.startsWith('Mouse')) {
      const webButton = parseInt(key.slice(5), 10);
      const uiButton = this.webMouseToUiohook(webButton);
      console.log('[GlobalShortcuts] Mouse button mapping:');
      console.log('[GlobalShortcuts]   Input key string:', key);
      console.log('[GlobalShortcuts]   Parsed web button:', webButton);
      console.log('[GlobalShortcuts]   Mapped uiohook button:', uiButton);
      console.log('[GlobalShortcuts]   Web button meanings:');
      console.log('[GlobalShortcuts]     0=left, 1=middle, 2=right, 3=back, 4=forward');
      console.log('[GlobalShortcuts]   uIOhook button meanings:');
      console.log('[GlobalShortcuts]     1=left, 2=right, 3=middle, 4=back, 5=forward');

      if (uiButton === null) {
        console.error('[GlobalShortcuts] Unsupported mouse button:', key);
        return false;
      }
      this.targetMouseButton = uiButton;
      this.targetKeyCode = null;
      this.currentKey = key;
      this.ensureStarted();
      console.log('[GlobalShortcuts] ✓ Registered mouse button successfully');
      console.log('[GlobalShortcuts] ========================================');
      return true;
    }

    const keyCode = this.webKeyToUiohook(key);
    if (keyCode === null) {
      console.error('[GlobalShortcuts] Unknown key format:', key);
      return false;
    }

    this.targetKeyCode = keyCode;
    this.targetMouseButton = null;
    this.currentKey = key;
    this.ensureStarted();
    console.log('[GlobalShortcuts] Registered PTT key:', key, '(keycode:', keyCode, ')');
    return true;
  }

  unregisterPttKey(): void {
    if (!this.currentKey) return;
    console.log('[GlobalShortcuts] Unregistering PTT key:', this.currentKey);
    this.currentKey = null;
    this.targetKeyCode = null;
    this.targetMouseButton = null;
    this.isPttActive = false;
  }

  /**
   * Force-release PTT if it gets stuck.
   * Useful for recovering from macOS keyup event issues.
   */
  forceReleasePtt(): void {
    if (this.isPttActive) {
      console.log('[GlobalShortcuts] Force-releasing stuck PTT');
      this.isPttActive = false;
      this.window.webContents.send('global-ptt-release');
    }
  }

  /**
   * Map web MouseEvent.button to uiohook mouse button number.
   * Web: 0=left, 1=middle, 2=right, 3=back, 4=forward
   * uiohook: 1=left, 2=right, 3=middle, 4=extra1(back), 5=extra2(forward)
   */
  private webMouseToUiohook(webButton: number): number | null {
    const map: Record<number, number> = {
      0: 1,
      1: 3,
      2: 2,
      3: 4,
      4: 5,
    };
    return map[webButton] ?? null;
  }

  /**
   * Map web KeyboardEvent.key value to uiohook keycode.
   */
  private webKeyToUiohook(key: string): number | null {
    // Direct mappings for special keys
    const keyMap: Record<string, number> = {
      '`': UiohookKey.Backquote,
      'Backquote': UiohookKey.Backquote,
      ' ': UiohookKey.Space,
      'Space': UiohookKey.Space,
      'Enter': UiohookKey.Enter,
      'Escape': UiohookKey.Escape,
      'Tab': UiohookKey.Tab,
      'CapsLock': UiohookKey.CapsLock,
      'Backspace': UiohookKey.Backspace,
      'Delete': UiohookKey.Delete,
      'Insert': UiohookKey.Insert,
      'Home': UiohookKey.Home,
      'End': UiohookKey.End,
      'PageUp': UiohookKey.PageUp,
      'PageDown': UiohookKey.PageDown,
      'ArrowUp': UiohookKey.ArrowUp,
      'ArrowDown': UiohookKey.ArrowDown,
      'ArrowLeft': UiohookKey.ArrowLeft,
      'ArrowRight': UiohookKey.ArrowRight,
      // Modifier keys (left variants)
      'Shift': UiohookKey.Shift,
      'Control': UiohookKey.Ctrl,
      'Alt': UiohookKey.Alt,
      'Meta': UiohookKey.Meta,
      // Punctuation / symbols
      '-': UiohookKey.Minus,
      '=': UiohookKey.Equal,
      '[': UiohookKey.BracketLeft,
      ']': UiohookKey.BracketRight,
      '\\': UiohookKey.Backslash,
      ';': UiohookKey.Semicolon,
      "'": UiohookKey.Quote,
      ',': UiohookKey.Comma,
      '.': UiohookKey.Period,
      '/': UiohookKey.Slash,
    };

    if (keyMap[key] !== undefined) {
      return keyMap[key];
    }

    // Single letter keys (a-z)
    if (key.length === 1 && /[a-zA-Z]/.test(key)) {
      const upper = key.toUpperCase() as keyof typeof UiohookKey;
      if (UiohookKey[upper] !== undefined) {
        return UiohookKey[upper] as number;
      }
    }

    // Number keys (0-9) from e.key
    if (key.length === 1 && /[0-9]/.test(key)) {
      const num = key as keyof typeof UiohookKey;
      if (UiohookKey[num] !== undefined) {
        return UiohookKey[num] as number;
      }
    }

    // F1-F24 function keys
    const fMatch = key.match(/^F(\d+)$/);
    if (fMatch) {
      const fKey = key as keyof typeof UiohookKey;
      if (UiohookKey[fKey] !== undefined) {
        return UiohookKey[fKey] as number;
      }
    }

    console.warn('[GlobalShortcuts] Unknown key format:', key);
    return null;
  }

  cleanup(): void {
    this.unregisterPttKey();
    if (this.started) {
      uIOhook.stop();
      this.started = false;
    }
  }
}
