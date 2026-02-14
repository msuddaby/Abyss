import type { PlayerAdapter } from './PlayerAdapter';

// Global singleton: load YouTube IFrame API script once
let apiReady = false;
let apiLoading = false;
const apiReadyCallbacks: (() => void)[] = [];

function ensureYouTubeAPI(): Promise<void> {
  if (apiReady) return Promise.resolve();
  return new Promise((resolve) => {
    apiReadyCallbacks.push(resolve);
    if (apiLoading) return;
    apiLoading = true;

    window.onYouTubeIframeAPIReady = () => {
      apiReady = true;
      apiReadyCallbacks.forEach((cb) => cb());
      apiReadyCallbacks.length = 0;
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
}

export class YouTubePlayerAdapter implements PlayerAdapter {
  private player: YT.Player | null = null;
  private ready = false;
  private pendingActions: (() => void)[] = [];
  private pollId: ReturnType<typeof setInterval> | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private endedCb: (() => void) | null = null;
  private timeUpdateCb: ((timeMs: number) => void) | null = null;
  private playingCb: (() => void) | null = null;
  private pauseCb: (() => void) | null = null;
  private seekedCb: (() => void) | null = null;
  private errorCb: ((message: string) => void) | null = null;
  private lastState: number = -1;

  initialize(container: HTMLElement, videoId: string): void {
    // Build the iframe ourselves instead of letting YT.Player auto-generate it.
    // The IFrame API auto-appends origin=window.location.origin to the embed URL,
    // which YouTube rejects in non-HTTP contexts (Electron app://, file://).
    // By creating the iframe manually without the origin param, YouTube falls back
    // to '*' for postMessage targeting (still works) and has no non-HTTP origin
    // to reject.
    const params = new URLSearchParams({
      enablejsapi: '1',
      autoplay: '1',
      controls: '0',
      modestbranding: '1',
      rel: '0',
      playsinline: '1',
      disablekb: '1',
    });

    this.iframe = document.createElement('iframe');
    this.iframe.id = `yt-player-${Date.now()}`;
    this.iframe.className = 'wp-yt-player';
    this.iframe.width = '100%';
    this.iframe.height = '100%';
    this.iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    this.iframe.allowFullscreen = true;
    this.iframe.setAttribute('frameborder', '0');
    this.iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
    container.appendChild(this.iframe);

    // Attach the YT API to the existing iframe (doesn't recreate or modify src)
    ensureYouTubeAPI().then(() => {
      if (!this.iframe?.isConnected) return;

      this.player = new YT.Player(this.iframe.id, {
        events: {
          onReady: () => {
            this.ready = true;
            this.pendingActions.forEach((fn) => fn());
            this.pendingActions = [];
            this.startPolling();
          },
          onStateChange: (event) => {
            this.handleStateChange(event.data);
          },
          onError: (event) => {
            const code = event.data;
            if (code === 101 || code === 150 || code === 153) {
              console.warn('YouTube: video embedding disabled by owner (error', code, ')');
              this.errorCb?.('This video cannot be embedded — the owner has disabled external playback.');
            } else if (code === 100) {
              console.warn('YouTube: video not found (error', code, ')');
              this.errorCb?.('Video not found — it may have been removed.');
            } else {
              console.error('YouTube player error:', code);
              this.errorCb?.(`YouTube playback error (code ${code}).`);
            }
          },
        },
      });
    });
  }

  private handleStateChange(state: number): void {
    if (state === YT.PlayerState.PLAYING) {
      this.playingCb?.();
      if (this.lastState === YT.PlayerState.PAUSED || this.lastState === YT.PlayerState.BUFFERING) {
        this.seekedCb?.();
      }
    } else if (state === YT.PlayerState.PAUSED) {
      this.pauseCb?.();
    } else if (state === YT.PlayerState.ENDED) {
      this.endedCb?.();
    }
    this.lastState = state;
  }

  private startPolling(): void {
    this.pollId = setInterval(() => {
      if (!this.player) return;
      try {
        const timeMs = this.player.getCurrentTime() * 1000;
        this.timeUpdateCb?.(timeMs);
      } catch {
        // player may be destroyed
      }
    }, 250);
  }

  private whenReady(fn: () => void): void {
    if (this.ready && this.player) {
      fn();
    } else {
      this.pendingActions.push(fn);
    }
  }

  play(): void {
    this.whenReady(() => this.player!.playVideo());
  }

  pause(): void {
    this.whenReady(() => this.player!.pauseVideo());
  }

  seek(timeMs: number): void {
    this.whenReady(() => this.player!.seekTo(timeMs / 1000, true));
  }

  getCurrentTime(): number {
    try {
      return this.player ? this.player.getCurrentTime() * 1000 : 0;
    } catch {
      return 0;
    }
  }

  getDuration(): number {
    try {
      return this.player ? (this.player.getDuration() || 0) * 1000 : 0;
    } catch {
      return 0;
    }
  }

  isPaused(): boolean {
    try {
      if (!this.player) return true;
      const state = this.player.getPlayerState();
      return state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING;
    } catch {
      return true;
    }
  }

  setVolume(volume: number): void {
    if (!this.player) return;
    // PlayerAdapter volume: 0-1, YouTube volume: 0-100
    this.player.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100));
  }

  onEnded(cb: () => void): void { this.endedCb = cb; }
  onTimeUpdate(cb: (timeMs: number) => void): void { this.timeUpdateCb = cb; }
  onPlaying(cb: () => void): void { this.playingCb = cb; }
  onPause(cb: () => void): void { this.pauseCb = cb; }
  onSeeked(cb: () => void): void { this.seekedCb = cb; }
  onError(cb: (message: string) => void): void { this.errorCb = cb; }

  getVideoElement(): HTMLVideoElement | null {
    // Cross-origin iframe — no direct video element access
    return null;
  }

  destroy(): void {
    if (this.pollId) {
      clearInterval(this.pollId);
      this.pollId = null;
    }
    try {
      this.player?.destroy();
    } catch {
      // ignore
    }
    this.player = null;
    this.ready = false;
    this.pendingActions = [];
    if (this.iframe) {
      this.iframe.remove();
    }
    this.iframe = null;
  }
}
