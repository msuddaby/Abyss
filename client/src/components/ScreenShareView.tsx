import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { getScreenVideoStream, getLocalScreenStream } from '../hooks/useWebRTC';

export default function ScreenShareView() {
  const screenSharerUserId = useVoiceStore((s) => s.screenSharerUserId);
  const screenSharerDisplayName = useVoiceStore((s) => s.screenSharerDisplayName);
  const screenStreamVersion = useVoiceStore((s) => s.screenStreamVersion);
  const currentUser = useAuthStore((s) => s.user);
  const videoRef = useRef<HTMLVideoElement>(null);

  const isLocalSharing = screenSharerUserId === currentUser?.id;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !screenSharerUserId) return;

    let stream: MediaStream | null | undefined;
    if (isLocalSharing) {
      stream = getLocalScreenStream();
    } else {
      stream = getScreenVideoStream(screenSharerUserId);
    }

    if (stream) {
      video.srcObject = stream;
      video.play().catch((err) => console.error('Screen share video play failed:', err));
    }

    return () => {
      video.srcObject = null;
    };
  }, [screenSharerUserId, isLocalSharing, screenStreamVersion]);

  if (!screenSharerUserId) {
    return <p>Voice Channel</p>;
  }

  return (
    <div className="screen-share-container">
      <div className="screen-share-header">
        {screenSharerDisplayName} is sharing their screen
      </div>
      <div className="screen-share-video-wrapper">
        <video
          ref={videoRef}
          className="screen-share-video"
          autoPlay
          playsInline
          muted={isLocalSharing}
        />
      </div>
    </div>
  );
}
