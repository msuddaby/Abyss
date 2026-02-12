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
  private pollId: ReturnType<typeof setInterval> | null = null;
  private container: HTMLElement | null = null;
  private playerDiv: HTMLDivElement | null = null;
  private endedCb: (() => void) | null = null;
  private timeUpdateCb: ((timeMs: number) => void) | null = null;
  private playingCb: (() => void) | null = null;
  private pauseCb: (() => void) | null = null;
  private seekedCb: (() => void) | null = null;
  private lastState: number = -1;

  initialize(container: HTMLElement, videoId: string): void {
    this.container = container;

    this.playerDiv = document.createElement('div');
    this.playerDiv.className = 'wp-yt-player';
    container.appendChild(this.playerDiv);

    ensureYouTubeAPI().then(() => {
      if (!this.playerDiv) return;

      this.player = new YT.Player(this.playerDiv, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          disablekb: 1,
        },
        events: {
          onReady: () => {
            this.startPolling();
          },
          onStateChange: (event) => {
            this.handleStateChange(event.data);
          },
          onError: (event) => {
            const code = event.data;
            if (code === 101 || code === 150) {
              console.warn('YouTube: video embedding disabled by owner (error', code, ')');
            } else {
              console.error('YouTube player error:', code);
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

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  seek(timeMs: number): void {
    this.player?.seekTo(timeMs / 1000, true);
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
    // The YT.Player replaces our div with an iframe, so clean up the container
    if (this.container) {
      const iframe = this.container.querySelector('iframe');
      iframe?.remove();
    }
    this.playerDiv = null;
    this.container = null;
  }
}
