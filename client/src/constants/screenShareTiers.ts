import type { ScreenShareQuality } from '@abyss/shared';

/**
 * User-facing labels for the screen-share quality tiers. The encode settings
 * behind each tier live in SCREEN_SHARE_QUALITY_CONSTRAINTS (hooks/useWebRTC.ts).
 */
export const SCREEN_OPTIONS: { value: ScreenShareQuality; label: string; detail: string }[] = [
  { value: '720p30', label: '720p', detail: '30fps · 3 Mbps' },
  { value: '1080p30', label: '1080p', detail: '30fps · 5 Mbps' },
  { value: '1080p60', label: '1080p', detail: '60fps · 8 Mbps' },
  { value: '1440p30', label: '1440p', detail: '30fps · 8 Mbps' },
];
