import { useEffect, useRef, useCallback, useState } from 'react';
import { useWatchPartyStore, useMediaProviderStore, useServerStore, useVoiceStore, useAuthStore, getStorage } from '@abyss/shared';
import { getConnection } from '@abyss/shared';
import { PlexPlayerAdapter } from '../services/playerAdapters/PlexPlayerAdapter';
import { YouTubePlayerAdapter } from '../services/playerAdapters/YouTubePlayerAdapter';
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

export default function WatchPartyPlayer({ mini = false }: { mini?: boolean }) {
  const activeParty = useWatchPartyStore((s) => s.activeParty);
  const activeServer = useServerStore((s) => s.activeServer);
  const currentUser = useAuthStore((s) => s.user);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);

  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<PlayerAdapter | null>(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [isPiP, setIsPiP] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('wp-volume');
    return saved ? parseFloat(saved) : 1;
  });

  const isHost = activeParty?.hostUserId === currentUser?.id;
  const isYouTube = activeParty?.providerType === 'YouTube';

  // Fetch playback URL when party starts or item changes (skip for YouTube)
  useEffect(() => {
    if (!activeParty || !activeServer) return;
    if (isYouTube) {
      // For YouTube, the providerItemId IS the video ID — no playback URL fetch needed
      setPlaybackUrl(activeParty.providerItemId);
      return;
    }

    // Use the shared playback URL from the server if available (avoids duplicate Plex transcode sessions)
    if (activeParty.playbackUrl) {
      const token = getStorage().getItem('token');
      const separator = activeParty.playbackUrl.includes('?') ? '&' : '?';
      const apiBase = import.meta.env.VITE_API_URL || '';
      setPlaybackUrl(`${apiBase}${activeParty.playbackUrl}${token ? `${separator}token=${token}` : ''}`);
      return;
    }

    // Fallback: fetch individually (backwards compat)
    const fetchUrl = async () => {
      const info = await useMediaProviderStore.getState().getPlaybackInfo(
        activeServer.id,
        activeParty.mediaProviderConnectionId,
        activeParty.providerItemId,
      );
      if (info) setPlaybackUrl(info.url);
    };
    fetchUrl();
  }, [activeParty?.providerItemId, activeParty?.mediaProviderConnectionId, activeServer?.id, isYouTube, activeParty?.playbackUrl]);

  // Initialize player when URL is available
  useEffect(() => {
    if (!playbackUrl || !containerRef.current) return;

    // Destroy previous adapter
    adapterRef.current?.destroy();

    const adapter = isYouTube ? new YouTubePlayerAdapter() : new PlexPlayerAdapter();
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

    // PiP event listeners
    const videoEl = adapter.getVideoElement();
    if (videoEl) {
      const onEnterPiP = () => setIsPiP(true);
      const onLeavePiP = () => setIsPiP(false);
      videoEl.addEventListener('enterpictureinpicture', onEnterPiP);
      videoEl.addEventListener('leavepictureinpicture', onLeavePiP);

      return () => {
        videoEl.removeEventListener('enterpictureinpicture', onEnterPiP);
        videoEl.removeEventListener('leavepictureinpicture', onLeavePiP);
        adapter.destroy();
        adapterRef.current = null;
      };
    }

    return () => {
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [playbackUrl, isYouTube]);

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
      if (currentChannelId) {
        await useWatchPartyStore.getState().stopWatchParty(currentChannelId).catch(console.error);
      }
      return;
    }

    const nextItem = activeParty.queue[0];
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

  const pipSupported = !isYouTube && typeof document.exitPictureInPicture === 'function';

  const handlePiP = useCallback(async () => {
    const videoEl = adapterRef.current?.getVideoElement();
    if (!videoEl || !('requestPictureInPicture' in videoEl)) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await (videoEl as any).requestPictureInPicture();
      }
    } catch (err) {
      console.warn('PiP failed:', err);
    }
  }, []);

  const handleFullscreen = useCallback(() => {
    const el = playerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.warn);
    } else {
      el.requestFullscreen().catch(console.warn);
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement && document.fullscreenElement === playerRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const handleTuneOut = useCallback(() => {
    useWatchPartyStore.getState().setTunedIn(false);
  }, []);

  const handleGoToChannel = useCallback(() => {
    if (!currentChannelId) return;
    const channel = useServerStore.getState().channels.find((c) => c.id === currentChannelId);
    if (channel) useServerStore.getState().setActiveChannel(channel);
  }, [currentChannelId]);

  // Hide queue panel when switching to mini mode
  useEffect(() => {
    if (mini) setShowQueue(false);
  }, [mini]);

  if (!activeParty) return null;

  return (
    <div ref={playerRef} className={`wp-player-persistent ${mini ? 'wp-mini' : 'wp-full'}`}>
      <div className={mini ? 'wp-mini-video-wrap' : 'wp-container'}>
        <div className={mini ? undefined : 'wp-main'}>
          <div
            className={mini ? 'wp-mini-video' : 'wp-video-wrapper'}
            ref={containerRef}
            onClick={mini ? handleGoToChannel : undefined}
          >
            {isPiP && <div className="wp-pip-indicator">Picture-in-Picture</div>}
            {!mini && !isPlaying && playbackUrl && !isPiP && (
              <div className="wp-pause-overlay">
                <svg className="wp-pause-icon" viewBox="0 0 24 24" fill="currentColor" width="64" height="64">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
                {!isHost && <span className="wp-pause-label">Host paused playback</span>}
              </div>
            )}
          </div>
          {mini ? (
            <div className="wp-mini-info">
              <div className="wp-mini-title" title={activeParty.itemTitle}>{activeParty.itemTitle}</div>
              <div className="wp-mini-controls">
                {isHost ? (
                  <button className="wp-ctrl-btn" onClick={isPlaying ? handlePause : handlePlay} title={isPlaying ? 'Pause' : 'Play'}>
                    {isPlaying ? '⏸' : '▶'}
                  </button>
                ) : (
                  <span className="wp-sync-badge">SYNCED</span>
                )}
                <span className="wp-mini-time">{formatTime(currentTime)}</span>
                <div className="wp-mini-spacer" />
                {pipSupported && (
                  <button className={`wp-ctrl-btn wp-pip-btn${isPiP ? ' active' : ''}`} onClick={handlePiP} title="Picture-in-Picture">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                      <path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>
                    </svg>
                  </button>
                )}
                <button className="wp-ctrl-btn" onClick={handleGoToChannel} title="Go to channel">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
                  </svg>
                </button>
              </div>
            </div>
          ) : (
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
              onPiP={pipSupported ? handlePiP : undefined}
              isPiP={isPiP}
              onTuneOut={handleTuneOut}
              onFullscreen={handleFullscreen}
              isFullscreen={isFullscreen}
            />
          )}
        </div>
        {!mini && showQueue && (
          <WatchPartyQueue
            queue={activeParty.queue}
            isHost={isHost}
            channelId={currentChannelId!}
            onClose={() => setShowQueue(false)}
          />
        )}
      </div>
    </div>
  );
}
