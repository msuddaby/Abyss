import { BrowserWindow } from 'electron';
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

    uIOhook.on('keydown', (e) => {
      if (this.targetKeyCode !== null && e.keycode === this.targetKeyCode && !this.isPttActive) {
        this.isPttActive = true;
        this.window.webContents.send('global-ptt-press');
      }
    });

    uIOhook.on('keyup', (e) => {
      if (this.targetKeyCode !== null && e.keycode === this.targetKeyCode && this.isPttActive) {
        this.isPttActive = false;
        this.window.webContents.send('global-ptt-release');
      }
    });

    uIOhook.on('mousedown', (e) => {
      const button = e.button as number;
      if (this.targetMouseButton !== null && button === this.targetMouseButton && !this.isPttActive) {
        this.isPttActive = true;
        this.window.webContents.send('global-ptt-press');
      }
    });

    uIOhook.on('mouseup', (e) => {
      const button = e.button as number;
      if (this.targetMouseButton !== null && button === this.targetMouseButton && this.isPttActive) {
        this.isPttActive = false;
        this.window.webContents.send('global-ptt-release');
      }
    });
  }

  private ensureStarted(): void {
    if (!this.started) {
      uIOhook.start();
      this.started = true;
    }
  }

  /**
   * Register a PTT key for hold-to-talk.
   * @param key Key in web format (e.g., "`", "Space", "Mouse3")
   */
  registerPttKey(key: string): boolean {
    console.log('[GlobalShortcuts] Registering PTT key:', key);

    this.unregisterPttKey();

    if (key.startsWith('Mouse')) {
      const webButton = parseInt(key.slice(5), 10);
      const uiButton = this.webMouseToUiohook(webButton);
      if (uiButton === null) {
        console.error('[GlobalShortcuts] Unsupported mouse button:', key);
        return false;
      }
      this.targetMouseButton = uiButton;
      this.targetKeyCode = null;
      this.currentKey = key;
      this.ensureStarted();
      console.log('[GlobalShortcuts] Registered mouse button:', key, '(uiohook button:', uiButton, ')');
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
