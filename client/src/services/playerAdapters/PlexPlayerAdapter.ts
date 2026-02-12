import Hls from 'hls.js';
import type { PlayerAdapter } from './PlayerAdapter';

export class PlexPlayerAdapter implements PlayerAdapter {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private endedCb: (() => void) | null = null;
  private timeUpdateCb: ((timeMs: number) => void) | null = null;
  private playingCb: (() => void) | null = null;
  private pauseCb: (() => void) | null = null;
  private seekedCb: (() => void) | null = null;

  initialize(container: HTMLElement, url: string): void {
    this.video = document.createElement('video');
    this.video.className = 'wp-video';
    this.video.playsInline = true;
    container.appendChild(this.video);

    this.video.addEventListener('ended', () => this.endedCb?.());
    this.video.addEventListener('timeupdate', () => {
      if (this.video) this.timeUpdateCb?.(this.video.currentTime * 1000);
    });
    this.video.addEventListener('playing', () => this.playingCb?.());
    this.video.addEventListener('pause', () => this.pauseCb?.());
    this.video.addEventListener('seeked', () => this.seekedCb?.());

    const isHls = url.includes('/hls?') || url.includes('.m3u8');

    if (isHls && Hls.isSupported()) {
      this.hls = new Hls({
        // hls.js calls xhrSetup after open() but before send() —
        // re-opening with the token-appended URL is valid per XHR spec
        xhrSetup: (xhr, reqUrl) => {
          // Extract JWT token from the original source URL
          const tokenMatch = url.match(/[?&]token=([^&]+)/);
          if (tokenMatch && !reqUrl.includes('token=')) {
            const sep = reqUrl.includes('?') ? '&' : '?';
            xhr.open('GET', `${reqUrl}${sep}token=${tokenMatch[1]}`, true);
          }
        },
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
    } else if (isHls && this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      this.video.src = url;
    } else {
      // Direct file playback
      this.video.src = url;
    }
  }

  play(): void { this.video?.play().catch(() => {}); }
  pause(): void { this.video?.pause(); }

  seek(timeMs: number): void {
    if (this.video) this.video.currentTime = timeMs / 1000;
  }

  getCurrentTime(): number {
    return this.video ? this.video.currentTime * 1000 : 0;
  }

  getDuration(): number {
    return this.video ? (this.video.duration || 0) * 1000 : 0;
  }

  isPaused(): boolean {
    return this.video ? this.video.paused : true;
  }

  setVolume(volume: number): void {
    if (this.video) this.video.volume = Math.max(0, Math.min(1, volume));
  }

  onEnded(cb: () => void): void { this.endedCb = cb; }
  onTimeUpdate(cb: (timeMs: number) => void): void { this.timeUpdateCb = cb; }
  onPlaying(cb: () => void): void { this.playingCb = cb; }
  onPause(cb: () => void): void { this.pauseCb = cb; }
  onSeeked(cb: () => void): void { this.seekedCb = cb; }

  getVideoElement(): HTMLVideoElement | null { return this.video; }

  destroy(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.src = '';
      this.video.remove();
      this.video = null;
    }
  }
}
