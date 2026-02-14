import { useEffect, useRef, useState, useCallback } from 'react';
import { useVoiceStore, useAuthStore } from '@abyss/shared';
import { getScreenVideoStream, getLocalScreenStream, requestWatch, stopWatching } from '../hooks/useWebRTC';

export default function ScreenShareView() {
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const screenStreamVersion = useVoiceStore((s) => s.screenStreamVersion);
  const currentUser = useAuthStore((s) => s.user);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const handleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.warn);
    } else {
      el.requestFullscreen().catch(console.warn);
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement && document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const isWatching = watchingUserId !== null;
  const isWatchingSelf = watchingUserId === currentUser?.id;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !watchingUserId) return;

    const stream = isWatchingSelf
      ? getLocalScreenStream()
      : getScreenVideoStream(watchingUserId);

    if (!stream) {
      video.srcObject = null;
      return;
    }

    video.srcObject = stream;

    const tryPlay = () => {
      // Check if stream and tracks are still active before playing
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState === 'ended') {
        console.log('Screen share track ended, skipping play');
        return;
      }

      // Check if video element is ready
      if (video.readyState < 2) {
        console.log('Video not ready yet, waiting for loadedmetadata');
        return;
      }

      video.play().catch((err) => {
        // Ignore abort errors - these happen when stream ends during play
        if (err.name === 'AbortError') {
          console.log('Screen share play aborted (stream likely ended)');
        } else {
          console.error('Screen share video play failed:', err);
        }
      });
    };

    // Play immediately (will skip if not ready and wait for loadedmetadata)
    tryPlay();

    // Retry on loadedmetadata in case the track wasn't producing frames yet
    video.addEventListener('loadedmetadata', tryPlay);

    // Handle track unmute — tracks may start muted during renegotiation
    const videoTrack = stream.getVideoTracks()[0];
    const onUnmute = () => tryPlay();
    if (videoTrack) {
      videoTrack.addEventListener('unmute', onUnmute);
    }

    return () => {
      video.removeEventListener('loadedmetadata', tryPlay);
      if (videoTrack) {
        videoTrack.removeEventListener('unmute', onUnmute);
      }
    };
  }, [watchingUserId, isWatchingSelf, screenStreamVersion]);

  // State 1: No sharers — show "Voice Channel"
  if (activeSharers.size === 0) {
    return <p>Voice Channel</p>;
  }

  // State 3: Watching someone — full video view
  if (isWatching) {
    const watchingName = activeSharers.get(watchingUserId!) || 'Unknown';
    const otherSharers = Array.from(activeSharers.entries()).filter(([id]) => id !== watchingUserId);

    return (
      <div className="screen-share-container" ref={containerRef}>
        <div className="screen-share-header">
          <span>{isWatchingSelf ? 'Your Screen' : `${watchingName}'s Screen`}</span>
          <div className="screen-share-header-actions">
            <button
              className={`screen-share-fullscreen-btn${isFullscreen ? ' active' : ''}`}
              onClick={handleFullscreen}
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                </svg>
              )}
            </button>
            <button
              className="stop-watching-btn"
              onClick={() => {
                if (!isWatchingSelf) {
                  stopWatching();
                } else {
                  useVoiceStore.getState().setWatching(null);
                }
              }}
            >
              Stop Watching
            </button>
          </div>
        </div>
        <div className="screen-share-video-wrapper">
          <video
            ref={videoRef}
            className="screen-share-video"
            autoPlay
            playsInline
            muted
          />
        </div>
        {otherSharers.length > 0 && (
          <div className="other-sharers-bar">
            {otherSharers.map(([userId, displayName]) => (
              <button
                key={userId}
                className={`other-sharer-chip${switchingTo === userId ? ' loading' : ''}`}
                disabled={switchingTo !== null}
                onClick={async () => {
                  setSwitchingTo(userId);
                  try {
                    // Stop watching current, switch to new
                    if (!isWatchingSelf) {
                      await stopWatching();
                    } else {
                      useVoiceStore.getState().setWatching(null);
                    }
                    if (userId === currentUser?.id) {
                      useVoiceStore.getState().setWatching(userId);
                    } else {
                      await requestWatch(userId);
                    }
                  } finally {
                    setSwitchingTo(null);
                  }
                }}
              >
                {switchingTo === userId ? '⏳' : '🖥️'} {displayName}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // State 2: Sharers exist, not watching — sharer picker cards
  const sharerEntries = Array.from(activeSharers.entries());

  return (
    <div className="screen-share-container">
      <div className="screen-share-picker">
        {sharerEntries.map(([userId, displayName]) => {
          const isSelf = userId === currentUser?.id;
          return (
            <div key={userId} className="sharer-card">
              <div className="sharer-card-icon">🖥️</div>
              <div className="sharer-card-name">{isSelf ? 'You' : displayName}</div>
              <div className="sharer-card-subtitle">is sharing their screen</div>
              <button
                className="watch-stream-btn"
                onClick={async () => {
                  if (isSelf) {
                    useVoiceStore.getState().setWatching(userId);
                  } else {
                    await requestWatch(userId);
                  }
                }}
              >
                {isSelf ? 'View Your Stream' : 'Watch Stream'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
