import { useEffect } from 'react';
import { useVoiceStore, useServerStore, hasChannelPermission, Permission } from '@abyss/shared';
import { useWebRTC, attemptAudioUnlock } from '../hooks/useWebRTC';

export default function VoiceControls() {
  const { currentChannelId, isScreenSharing, voiceMode, isPttActive, pttKey, setVoiceMode, needsAudioUnlock } = useVoiceStore();
  const channels = useServerStore((s) => s.channels);
  const { leaveVoice, startScreenShare, stopScreenShare } = useWebRTC();

  const channel = channels.find((c) => c.id === currentChannelId);
  const isPtt = voiceMode === 'push-to-talk';
  const canStream = channel ? hasChannelPermission(channel.permissions, Permission.Stream) : false;

  useEffect(() => {
    if (!canStream && isScreenSharing) {
      stopScreenShare();
    }
  }, [canStream, isScreenSharing, stopScreenShare]);

  if (!currentChannelId) return null;

  return (
    <div className="voice-controls">
      <div className="voice-controls-info">
        <span className="voice-connected-label">Voice Connected</span>
        {channel && <span className="voice-channel-name">🔊 {channel.name}</span>}
      </div>
      <div className="voice-controls-buttons">
        {needsAudioUnlock && (
          <button
            className="voice-ctrl-btn audio-unlock"
            onClick={() => attemptAudioUnlock()}
            title="Enable audio playback"
          >
            Enable Audio
          </button>
        )}
        <button
          className={`voice-ctrl-btn voice-mode-toggle`}
          onClick={() => setVoiceMode(isPtt ? 'voice-activity' : 'push-to-talk')}
          title={isPtt ? 'Switch to Voice Activity' : 'Switch to Push to Talk'}
        >
          {isPtt ? 'PTT' : 'VA'}
        </button>
        {isPtt && (
          <span className="ptt-hint">
            {isPttActive ? '🎤' : `[${pttKey.startsWith('Mouse') ? `M${pttKey.slice(5)}` : pttKey}]`}
          </span>
        )}
        {canStream && (
          <button
            className={`voice-ctrl-btn ${isScreenSharing ? 'active' : ''}`}
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
            title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          >
            🖥️
          </button>
        )}
        <button className="voice-ctrl-btn disconnect" onClick={leaveVoice} title="Disconnect">
          📞
        </button>
      </div>
    </div>
  );
}
