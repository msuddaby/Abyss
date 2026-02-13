import { Audio } from 'expo-av';

/**
 * Mobile audio polyfill using expo-av.
 *
 * The shared `playVoiceSound` helper (in @abyss/shared) uses the web
 * `new Audio(url)` API.  On React-Native that constructor does not
 * exist, so `playVoiceSound` bails out early when it detects
 * `typeof globalThis.Audio === 'undefined'`.
 *
 * This module provides a lightweight shim that satisfies the same
 * surface area the shared code relies on:
 *   - `new Audio(url)` constructor
 *   - `.preload` (no-op)
 *   - `.currentTime = 0` (seeks to start)
 *   - `.volume = n` (0-1)
 *   - `.play()` returning a Promise
 *
 * Sound objects are cached per-URL and properly unloaded before
 * reloading to avoid leaking native resources.
 */

class MobileAudio {
  private _url: string;
  private _sound: Audio.Sound | null = null;
  private _loaded = false;
  private _volume = 1;

  /** Compatibility stub -- ignored on mobile. */
  preload: string = 'auto';

  constructor(url: string) {
    this._url = url;
  }

  /** Seek support.  Only `0` is used by the shared code today. */
  set currentTime(value: number) {
    if (this._sound && this._loaded) {
      this._sound.setPositionAsync(value * 1000).catch(() => {});
    }
  }

  /** Volume 0-1, matching the web Audio element API. */
  set volume(value: number) {
    this._volume = value;
    if (this._sound && this._loaded) {
      this._sound.setVolumeAsync(value).catch(() => {});
    }
  }

  get volume(): number {
    return this._volume;
  }

  /**
   * Load (or reload) the sound and play it.
   * Returns a Promise so callers can `.catch(() => {})` like the web API.
   */
  async play(): Promise<void> {
    try {
      if (!this._sound) {
        this._sound = new Audio.Sound();
      }

      // Unload any previously loaded audio before loading a fresh copy.
      // This is important for replaying the same sound multiple times.
      if (this._loaded) {
        await this._sound.unloadAsync();
        this._loaded = false;
      }

      await this._sound.loadAsync(
        { uri: this._url },
        { shouldPlay: true, volume: this._volume, positionMillis: 0 },
      );
      this._loaded = true;
    } catch {
      // Silently swallow -- mirrors `audio.play().catch(() => {})`.
    }
  }
}

/**
 * Install the `globalThis.Audio` polyfill so the shared
 * `playVoiceSound` function works transparently on React-Native.
 *
 * Call this once, at the module level of the root layout, **before**
 * `useSignalRListeners` runs.
 */
export function initMobileAudio(): void {
  if (typeof (globalThis as any).Audio !== 'undefined') {
    // Already available (e.g. web or already initialised) -- nothing to do.
    return;
  }

  // Configure expo-av for background / silent-mode playback.
  Audio.setAudioModeAsync({
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
  }).catch(() => {});

  (globalThis as any).Audio = MobileAudio;
}
