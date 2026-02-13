import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import YoutubePlayer from 'react-native-youtube-iframe';
import { useWatchPartyStore, useVoiceStore, useServerStore, useAuthStore, getApiBase } from '@abyss/shared';
import Modal from './Modal';
import WatchPartyHostControls from './WatchPartyHostControls';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

/** Format milliseconds to MM:SS */
function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Extract a YouTube video ID from a providerItemId or a full YouTube URL.
 * Supports formats like:
 *   - "dQw4w9WgXcQ"  (bare ID)
 *   - "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *   - "https://youtu.be/dQw4w9WgXcQ"
 *   - "https://www.youtube.com/embed/dQw4w9WgXcQ"
 */
function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;

  // If it looks like a bare 11-character video ID already
  if (/^[\w-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    // youtube.com/watch?v=ID
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return v;
      // youtube.com/embed/ID
      const embedMatch = url.pathname.match(/\/embed\/([\w-]{11})/);
      if (embedMatch) return embedMatch[1];
    }
    // youtu.be/ID
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (id && /^[\w-]{11}$/.test(id)) return id;
    }
  } catch {
    // Not a URL — try regex extraction as fallback
    const match = input.match(/([\w-]{11})/);
    if (match) return match[1];
  }

  return null;
}

/** Determine whether the current party is YouTube content */
function isYouTubeParty(providerType?: string, playbackUrl?: string): boolean {
  if (providerType?.toLowerCase() === 'youtube') return true;
  if (playbackUrl && (playbackUrl.includes('youtube.com') || playbackUrl.includes('youtu.be'))) {
    return true;
  }
  return false;
}

interface WatchPartyViewerProps {
  onClose?: () => void;
}

export default function WatchPartyViewer({ onClose }: WatchPartyViewerProps) {
  const activeParty = useWatchPartyStore((s) => s.activeParty);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const members = useServerStore((s) => s.members);
  const userId = useAuthStore((s) => s.user?.id);

  // Resolve host display name from members list
  const hostName = React.useMemo(() => {
    if (!activeParty) return 'Unknown';
    const member = members.find((m) => m.userId === activeParty.hostUserId);
    return member?.user?.displayName ?? 'Unknown';
  }, [activeParty, members]);

  // No active party — show loading state
  if (!activeParty) {
    return (
      <Modal title="Watch Party" onClose={onClose}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.brandColor} />
          <Text style={styles.loadingText}>No active watch party</Text>
        </View>
      </Modal>
    );
  }

  const durationMs = activeParty.itemDurationMs ?? 0;
  const progressPercent =
    durationMs > 0
      ? Math.min(100, (activeParty.currentTimeMs / durationMs) * 100)
      : 0;

  const isYouTube = isYouTubeParty(activeParty.providerType, activeParty.playbackUrl);

  return (
    <Modal title="Watch Party" onClose={onClose} maxWidth={500}>
      {/* Video Player */}
      {isYouTube ? (
        <YouTubeVideoPlayer
          providerItemId={activeParty.providerItemId}
          playbackUrl={activeParty.playbackUrl}
          currentTimeMs={activeParty.currentTimeMs}
          isPlaying={activeParty.isPlaying}
        />
      ) : activeParty.playbackUrl ? (
        <HLSVideoPlayer
          playbackUrl={activeParty.playbackUrl}
          currentTimeMs={activeParty.currentTimeMs}
          isPlaying={activeParty.isPlaying}
          thumbnail={activeParty.itemThumbnail}
        />
      ) : (
        // No playback URL available — show thumbnail fallback
        activeParty.itemThumbnail ? (
          <View style={styles.playerWrapper}>
            <Image
              source={{ uri: activeParty.itemThumbnail }}
              style={styles.thumbnailImage}
              resizeMode="cover"
            />
            <View style={styles.playbackOverlay}>
              <Text style={styles.playbackIcon}>
                {activeParty.isPlaying ? '\u25B6' : '\u23F8'}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.playerPlaceholder}>
            <Text style={styles.placeholderIcon}>
              {activeParty.isPlaying ? '\u25B6' : '\u23F8'}
            </Text>
          </View>
        )
      )}

      {/* Title */}
      <Text style={styles.itemTitle} numberOfLines={2}>
        {activeParty.itemTitle}
      </Text>

      {/* Host */}
      <Text style={styles.hostLabel}>
        Hosted by <Text style={styles.hostName}>{hostName}</Text>
      </Text>

      {/* Playback status */}
      <View style={styles.playbackRow}>
        <Text style={styles.statusBadge}>
          {activeParty.isPlaying ? 'Playing' : 'Paused'}
        </Text>
        <Text style={styles.timeText}>
          {formatTime(activeParty.currentTimeMs)}
          {durationMs > 0 ? ` / ${formatTime(durationMs)}` : ''}
        </Text>
      </View>

      {/* Progress bar */}
      {durationMs > 0 && (
        <View style={styles.progressBarBg}>
          <View
            style={[styles.progressBarFill, { width: `${progressPercent}%` }]}
          />
        </View>
      )}

      {/* Host Controls */}
      {currentChannelId && (
        <WatchPartyHostControls
          channelId={currentChannelId}
          isHost={userId === activeParty.hostUserId}
          activeParty={activeParty}
        />
      )}

      {/* Provider info */}
      {activeParty.providerType && (
        <Text style={styles.providerText}>
          Provider: {activeParty.providerType}
        </Text>
      )}

      {/* Queue */}
      {activeParty.queue.length > 0 && (
        <View style={styles.queueSection}>
          <Text style={styles.queueTitle}>
            Queue ({activeParty.queue.length})
          </Text>
          <ScrollView
            style={styles.queueList}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            {activeParty.queue.map((item, index) => (
              <View key={`${item.providerItemId}-${index}`} style={styles.queueItem}>
                {item.thumbnail ? (
                  <Image
                    source={{ uri: item.thumbnail }}
                    style={styles.queueThumb}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.queueThumbPlaceholder}>
                    <Text style={styles.queueThumbText}>
                      {index + 1}
                    </Text>
                  </View>
                )}
                <View style={styles.queueItemInfo}>
                  <Text style={styles.queueItemTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.durationMs !== undefined && item.durationMs > 0 && (
                    <Text style={styles.queueItemDuration}>
                      {formatTime(item.durationMs)}
                    </Text>
                  )}
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// HLS / Plex Video Player (expo-av)
// ---------------------------------------------------------------------------

interface HLSVideoPlayerProps {
  playbackUrl: string;
  currentTimeMs: number;
  isPlaying: boolean;
  thumbnail?: string;
}

function HLSVideoPlayer({ playbackUrl, currentTimeMs, isPlaying, thumbnail }: HLSVideoPlayerProps) {
  const videoRef = useRef<Video>(null);
  const lastSyncRef = useRef<number>(0);
  const [isLoaded, setIsLoaded] = useState(false);

  // Sync play/pause state whenever isPlaying changes
  useEffect(() => {
    if (!videoRef.current || !isLoaded) return;

    if (isPlaying) {
      videoRef.current.playAsync();
    } else {
      videoRef.current.pauseAsync();
    }
  }, [isPlaying, isLoaded]);

  // Sync position when currentTimeMs changes significantly (>2s drift)
  useEffect(() => {
    if (!videoRef.current || !isLoaded) return;

    const now = Date.now();
    // Throttle seeks to at most once per second
    if (now - lastSyncRef.current < 1000) return;

    videoRef.current.getStatusAsync().then((status) => {
      if (!status.isLoaded) return;
      const drift = Math.abs((status.positionMillis ?? 0) - currentTimeMs);
      if (drift > 2000) {
        lastSyncRef.current = Date.now();
        videoRef.current?.setPositionAsync(currentTimeMs);
      }
    });
  }, [currentTimeMs, isLoaded]);

  const handlePlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (status.isLoaded && !isLoaded) {
      setIsLoaded(true);
    }
  }, [isLoaded]);

  return (
    <View style={styles.playerWrapper}>
      <Video
        ref={videoRef}
        source={{ uri: playbackUrl }}
        posterSource={thumbnail ? { uri: thumbnail } : undefined}
        usePoster={!!thumbnail}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay={isPlaying}
        positionMillis={currentTimeMs}
        style={styles.videoPlayer}
        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
        useNativeControls={false}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// YouTube Player (react-native-youtube-iframe)
// ---------------------------------------------------------------------------

interface YouTubeVideoPlayerProps {
  providerItemId: string;
  playbackUrl?: string;
  currentTimeMs: number;
  isPlaying: boolean;
}

function YouTubeVideoPlayer({
  providerItemId,
  playbackUrl,
  currentTimeMs,
  isPlaying,
}: YouTubeVideoPlayerProps) {
  const playerRef = useRef<any>(null);
  const lastSyncRef = useRef<number>(0);
  const [isReady, setIsReady] = useState(false);

  const videoId = React.useMemo(() => {
    // Try providerItemId first, then fall back to playbackUrl
    return extractYouTubeVideoId(providerItemId) ?? extractYouTubeVideoId(playbackUrl ?? '');
  }, [providerItemId, playbackUrl]);

  // Sync position when currentTimeMs changes significantly
  useEffect(() => {
    if (!playerRef.current || !isReady) return;

    const now = Date.now();
    if (now - lastSyncRef.current < 1000) return;

    playerRef.current.getCurrentTime?.().then((currentSec: number) => {
      const currentMs = currentSec * 1000;
      const drift = Math.abs(currentMs - currentTimeMs);
      if (drift > 2000) {
        lastSyncRef.current = Date.now();
        playerRef.current.seekTo?.(currentTimeMs / 1000, true);
      }
    }).catch(() => {
      // Player may not be ready yet
    });
  }, [currentTimeMs, isReady]);

  const onReady = useCallback(() => {
    setIsReady(true);
    // Seek to the correct position when the player becomes ready
    if (playerRef.current && currentTimeMs > 0) {
      playerRef.current.seekTo?.(currentTimeMs / 1000, true);
    }
  }, [currentTimeMs]);

  if (!videoId) {
    return (
      <View style={styles.playerPlaceholder}>
        <Text style={styles.placeholderErrorText}>Unable to load YouTube video</Text>
      </View>
    );
  }

  return (
    <View style={styles.playerWrapper}>
      <YoutubePlayer
        ref={playerRef}
        height={0}
        width={0}
        videoId={videoId}
        play={isPlaying}
        onReady={onReady}
        initialPlayerParams={{
          preventFullScreen: false,
          modestbranding: true,
          rel: false,
        }}
        webViewStyle={styles.youtubeWebView}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Loading
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.lg,
  } as ViewStyle,
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  } as TextStyle,

  // Video player wrapper (16:9)
  playerWrapper: {
    position: 'relative',
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: colors.bgTertiary,
    marginBottom: spacing.md,
  } as ViewStyle,
  videoPlayer: {
    width: '100%',
    height: '100%',
  } as ViewStyle,
  youtubeWebView: {
    width: '100%',
    height: '100%',
    borderRadius: borderRadius.md,
  } as ViewStyle,
  thumbnailImage: {
    width: '100%',
    height: '100%',
  } as ImageStyle,
  playbackOverlay: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  playbackIcon: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
  } as TextStyle,
  playerPlaceholder: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  } as ViewStyle,
  placeholderIcon: {
    fontSize: 40,
    color: colors.textMuted,
  } as TextStyle,
  placeholderErrorText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
  } as TextStyle,

  // Title & host
  itemTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginBottom: spacing.xs,
  } as TextStyle,
  hostLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  } as TextStyle,
  hostName: {
    color: colors.textPrimary,
    fontWeight: '600',
  } as TextStyle,

  // Playback row
  playbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,
  statusBadge: {
    color: colors.headerPrimary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    backgroundColor: colors.brandColor,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  } as TextStyle,
  timeText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontVariant: ['tabular-nums'],
  } as TextStyle,

  // Progress bar
  progressBarBg: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.bgTertiary,
    marginBottom: spacing.md,
    overflow: 'hidden',
  } as ViewStyle,
  progressBarFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.brandColor,
  } as ViewStyle,

  // Provider
  providerText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginBottom: spacing.sm,
  } as TextStyle,

  // Queue
  queueSection: {
    marginTop: spacing.xs,
  } as ViewStyle,
  queueTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  } as TextStyle,
  queueList: {
    maxHeight: 200,
  } as ViewStyle,
  queueItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  queueThumb: {
    width: 48,
    height: 36,
    borderRadius: borderRadius.sm,
  } as ImageStyle,
  queueThumbPlaceholder: {
    width: 48,
    height: 36,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  queueThumbText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  queueItemInfo: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  queueItemTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  } as TextStyle,
  queueItemDuration: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
});
