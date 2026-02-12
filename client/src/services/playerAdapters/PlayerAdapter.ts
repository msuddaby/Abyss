export interface PlayerAdapter {
  initialize(container: HTMLElement, url: string, headers?: Record<string, string>): void;
  play(): void;
  pause(): void;
  seek(timeMs: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  setVolume(volume: number): void;
  onEnded(cb: () => void): void;
  onTimeUpdate(cb: (timeMs: number) => void): void;
  onPlaying(cb: () => void): void;
  onPause(cb: () => void): void;
  onSeeked(cb: () => void): void;
  getVideoElement(): HTMLVideoElement | null;
  destroy(): void;
}
