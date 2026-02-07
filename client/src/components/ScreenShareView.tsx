import { useEffect, useRef } from 'react';
import { useVoiceStore, useAuthStore } from '@abyss/shared';
import { getScreenVideoStream, getLocalScreenStream, requestWatch, stopWatching } from '../hooks/useWebRTC';

export default function ScreenShareView() {
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const screenStreamVersion = useVoiceStore((s) => s.screenStreamVersion);
  const currentUser = useAuthStore((s) => s.user);
  const videoRef = useRef<HTMLVideoElement>(null);

  const isWatching = watchingUserId !== null;
  const isWatchingSelf = watchingUserId === currentUser?.id;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !watchingUserId) return;

    let stream: MediaStream | null | undefined;
    if (isWatchingSelf) {
      stream = getLocalScreenStream();
    } else {
      stream = getScreenVideoStream(watchingUserId);
    }

    if (stream) {
      video.srcObject = stream;
      video.play().catch((err) => console.error('Screen share video play failed:', err));
    }

    return () => {
      video.srcObject = null;
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
      <div className="screen-share-container">
        <div className="screen-share-header">
          <span>{isWatchingSelf ? 'Your Screen' : `${watchingName}'s Screen`}</span>
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
        <div className="screen-share-video-wrapper">
          <video
            ref={videoRef}
            className="screen-share-video"
            autoPlay
            playsInline
            muted={isWatchingSelf}
          />
        </div>
        {otherSharers.length > 0 && (
          <div className="other-sharers-bar">
            {otherSharers.map(([userId, displayName]) => (
              <button
                key={userId}
                className="other-sharer-chip"
                onClick={async () => {
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
                }}
              >
                🖥️ {displayName}
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
