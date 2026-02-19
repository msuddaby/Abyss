import { useEffect, useRef, useState, useCallback } from 'react';
import { useVoiceStore, useAuthStore } from '@abyss/shared';
import { getScreenVideoStream, getLocalScreenStream, requestWatch, stopWatching, setScreenAudioVolume } from '../hooks/useWebRTC';

export default function ScreenShareView() {
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const screenStreamVersion = useVoiceStore((s) => s.screenStreamVersion);
  const currentUser = useAuthStore((s) => s.user);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('ss-volume');
    return saved ? parseFloat(saved) : 1;
  });
  const [premuteVolume, setPremuteVolume] = useState(1);

  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const isWatching = watchingUserId !== null;
  const isWatchingSelf = watchingUserId === currentUser?.id;

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

  const handleVolumeChange = useCallback((newVol: number) => {
    setVolume(newVol);
    localStorage.setItem('ss-volume', String(newVol));
    const video = videoRef.current;
    if (video) {
      video.volume = newVol;
      video.muted = newVol === 0;
    }
    if (watchingUserId && !isWatchingSelf) {
      setScreenAudioVolume(watchingUserId, newVol);
    }
  }, [watchingUserId, isWatchingSelf]);

  const handleMuteToggle = useCallback(() => {
    if (volume > 0) {
      setPremuteVolume(volume);
      handleVolumeChange(0);
    } else {
      handleVolumeChange(premuteVolume || 1);
    }
  }, [volume, premuteVolume, handleVolumeChange]);

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

    // Apply volume (unmute after autoplay succeeds)
    if (!isWatchingSelf) {
      video.volume = volume;
      video.muted = volume === 0;
      setScreenAudioVolume(watchingUserId, volume);
    }

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
            {!isWatchingSelf && (
              <div className="ss-volume" onMouseEnter={() => setShowVolume(true)} onMouseLeave={() => setShowVolume(false)}>
                <button className="screen-share-fullscreen-btn" onClick={handleMuteToggle} title={volume === 0 ? 'Unmute' : 'Mute'}>
                  {volume === 0 ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                      <path d="M3.63 3.63a.996.996 0 000 1.41L7.29 8.7 7 9H4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91-.36.15-.58.53-.58.92 0 .72.73 1.18 1.39.91.8-.33 1.55-.77 2.22-1.31l1.34 1.34a.996.996 0 101.41-1.41L5.05 3.63c-.39-.39-1.02-.39-1.42 0zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-3.83-2.4-7.11-5.78-8.4-.59-.23-1.22.23-1.22.86v.19c0 .38.25.71.61.85C17.18 6.54 19 9.06 19 12zm-8.71-6.29l-.17.17L12 7.76V6.41c0-.89-1.08-1.33-1.71-.7zM16.5 12A4.5 4.5 0 0014 7.97v1.79l2.48 2.48c.01-.08.02-.16.02-.24z"/>
                    </svg>
                  ) : volume < 0.5 ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                      <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                  )}
                </button>
                {showVolume && (
                  <input
                    type="range"
                    className="ss-volume-slider"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  />
                )}
              </div>
            )}
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
            muted={isWatchingSelf || volume === 0}
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
