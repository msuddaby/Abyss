import { useEffect, useRef, useCallback, useState } from 'react';
import { useWatchPartyStore, useMediaProviderStore, useServerStore, useVoiceStore, useAuthStore } from '@abyss/shared';
import { getConnection } from '@abyss/shared';
import { PlexPlayerAdapter } from '../services/playerAdapters/PlexPlayerAdapter';
import type { PlayerAdapter } from '../services/playerAdapters/PlayerAdapter';
import WatchPartyControls from './WatchPartyControls';
import WatchPartyQueue from './WatchPartyQueue';

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function WatchPartyPlayer() {
  const activeParty = useWatchPartyStore((s) => s.activeParty);
  const activeServer = useServerStore((s) => s.activeServer);
  const currentUser = useAuthStore((s) => s.user);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);

  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<PlayerAdapter | null>(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCommandTimeRef = useRef<number>(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('wp-volume');
    return saved ? parseFloat(saved) : 1;
  });

  const isHost = activeParty?.hostUserId === currentUser?.id;

  // Fetch playback URL when party starts or item changes
  useEffect(() => {
    if (!activeParty || !activeServer) return;

    const fetchUrl = async () => {
      const info = await useMediaProviderStore.getState().getPlaybackInfo(
        activeServer.id,
        activeParty.mediaProviderConnectionId,
        activeParty.providerItemId,
      );
      if (info) setPlaybackUrl(info.url);
    };
    fetchUrl();
  }, [activeParty?.providerItemId, activeParty?.mediaProviderConnectionId, activeServer?.id]);

  // Initialize player when URL is available
  useEffect(() => {
    if (!playbackUrl || !containerRef.current) return;

    // Destroy previous adapter
    adapterRef.current?.destroy();

    const adapter = new PlexPlayerAdapter();
    adapter.initialize(containerRef.current, playbackUrl);
    adapterRef.current = adapter;

    adapter.onTimeUpdate((timeMs) => {
      setCurrentTime(timeMs);
      setDuration(adapter.getDuration());
    });

    adapter.onPlaying(() => setIsPlaying(true));
    adapter.onPause(() => setIsPlaying(false));

    adapter.onEnded(() => {
      if (isHost) handleNextInQueue();
    });

    // Apply saved volume
    adapter.setVolume(volume);

    // Auto-play and sync to current position
    if (activeParty) {
      adapter.seek(activeParty.currentTimeMs);
      if (activeParty.isPlaying) adapter.play();
    }

    return () => {
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [playbackUrl]);

  // Host: report position every 2 seconds
  useEffect(() => {
    if (!isHost || !currentChannelId) return;

    syncIntervalRef.current = setInterval(() => {
      const adapter = adapterRef.current;
      if (!adapter) return;

      const conn = getConnection();
      if (conn.state === 'Connected') {
        conn.invoke('ReportPlaybackPosition', currentChannelId, adapter.getCurrentTime(), !adapter.isPaused())
          .catch(console.error);
      }
    }, 2000);

    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, [isHost, currentChannelId]);

  // Viewer: sync to store updates (from SyncPosition/PlaybackCommand events)
  useEffect(() => {
    if (isHost || !activeParty || !adapterRef.current) return;

    const adapter = adapterRef.current;
    const timeDrift = Math.abs(adapter.getCurrentTime() - activeParty.currentTimeMs);

    // Only correct if drift is > 1.5 seconds to avoid jitter
    if (timeDrift > 1500) {
      adapter.seek(activeParty.currentTimeMs);
    }

    if (activeParty.isPlaying && adapter.isPaused()) {
      adapter.play();
    } else if (!activeParty.isPlaying && !adapter.isPaused()) {
      adapter.pause();
    }
  }, [activeParty?.currentTimeMs, activeParty?.isPlaying, isHost]);

  // Host: send playback commands
  const handlePlay = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter || !currentChannelId) return;
    adapter.play();
    const conn = getConnection();
    conn.invoke('NotifyPlaybackCommand', currentChannelId, 'play', adapter.getCurrentTime()).catch(console.error);
  }, [currentChannelId]);

  const handlePause = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter || !currentChannelId) return;
    adapter.pause();
    const conn = getConnection();
    conn.invoke('NotifyPlaybackCommand', currentChannelId, 'pause', adapter.getCurrentTime()).catch(console.error);
  }, [currentChannelId]);

  const handleSeek = useCallback((timeMs: number) => {
    const adapter = adapterRef.current;
    if (!adapter || !currentChannelId) return;
    adapter.seek(timeMs);
    const conn = getConnection();
    conn.invoke('NotifyPlaybackCommand', currentChannelId, 'seek', timeMs).catch(console.error);
  }, [currentChannelId]);

  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
    localStorage.setItem('wp-volume', String(newVolume));
    adapterRef.current?.setVolume(newVolume);
  }, []);

  const handleNextInQueue = useCallback(async () => {
    if (!activeParty || !currentChannelId || activeParty.queue.length === 0) {
      // No more items, stop the party
      if (currentChannelId) {
        await useWatchPartyStore.getState().stopWatchParty(currentChannelId).catch(console.error);
      }
      return;
    }

    const nextItem = activeParty.queue[0];
    // Remove from queue then start new item
    await useWatchPartyStore.getState().removeFromQueue(currentChannelId, 0).catch(console.error);
    await useWatchPartyStore.getState().stopWatchParty(currentChannelId).catch(console.error);
    await useWatchPartyStore.getState().startWatchParty(currentChannelId, {
      mediaProviderConnectionId: activeParty.mediaProviderConnectionId,
      providerItemId: nextItem.providerItemId,
      itemTitle: nextItem.title,
      itemThumbnail: nextItem.thumbnail,
      itemDurationMs: nextItem.durationMs,
    }).catch(console.error);
  }, [activeParty, currentChannelId]);

  if (!activeParty) return null;

  return (
    <div className="wp-container">
      <div className="wp-main">
        <div className="wp-video-wrapper" ref={containerRef}>
          {!isPlaying && playbackUrl && (
            <div className="wp-pause-overlay">
              <svg className="wp-pause-icon" viewBox="0 0 24 24" fill="currentColor" width="64" height="64">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
              {!isHost && <span className="wp-pause-label">Host paused playback</span>}
            </div>
          )}
        </div>
        <WatchPartyControls
          isHost={isHost}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration || (activeParty.itemDurationMs ?? 0)}
          title={activeParty.itemTitle}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeek={handleSeek}
          onStop={() => currentChannelId && useWatchPartyStore.getState().stopWatchParty(currentChannelId)}
          onToggleQueue={() => setShowQueue(!showQueue)}
          hasQueue={activeParty.queue.length > 0}
          formatTime={formatTime}
          volume={volume}
          onVolumeChange={handleVolumeChange}
        />
      </div>
      {showQueue && (
        <WatchPartyQueue
          queue={activeParty.queue}
          isHost={isHost}
          channelId={currentChannelId!}
          onClose={() => setShowQueue(false)}
        />
      )}
    </div>
  );
}
