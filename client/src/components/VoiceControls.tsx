import { useVoiceStore } from '../stores/voiceStore';
import { useServerStore } from '../stores/serverStore';
import { useWebRTC } from '../hooks/useWebRTC';

export default function VoiceControls() {
  const { currentChannelId, isMuted, isDeafened, isScreenSharing, screenSharerUserId, voiceMode, isPttActive, pttKey, toggleMute, toggleDeafen, setVoiceMode } = useVoiceStore();
  const channels = useServerStore((s) => s.channels);
  const { leaveVoice, startScreenShare, stopScreenShare } = useWebRTC();

  const channel = channels.find((c) => c.id === currentChannelId);
  const someoneElseSharing = screenSharerUserId !== null && !isScreenSharing;
  const isPtt = voiceMode === 'push-to-talk';

  if (!currentChannelId) return null;

  return (
    <div className="voice-controls">
      <div className="voice-controls-info">
        <span className="voice-connected-label">Voice Connected</span>
        {channel && <span className="voice-channel-name">🔊 {channel.name}</span>}
      </div>
      <div className="voice-controls-buttons">
        {isPtt ? (
          <button
            className={`voice-ctrl-btn ${isPttActive && !isMuted ? 'ptt-active' : ''} ${isMuted ? 'active' : ''}`}
            onClick={toggleMute}
            title={isMuted ? 'Unmute' : `PTT: hold [${pttKey.startsWith('Mouse') ? `Mouse Button ${pttKey.slice(5)}` : pttKey}] to talk`}
          >
            {isMuted ? '🔇' : isPttActive ? '🎤' : '🎙️'}
          </button>
        ) : (
          <button
            className={`voice-ctrl-btn ${isMuted ? 'active' : ''}`}
            onClick={toggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🎤'}
          </button>
        )}
        <button
          className={`voice-ctrl-btn voice-mode-toggle`}
          onClick={() => setVoiceMode(isPtt ? 'voice-activity' : 'push-to-talk')}
          title={isPtt ? 'Switch to Voice Activity' : 'Switch to Push to Talk'}
        >
          {isPtt ? 'PTT' : 'VA'}
        </button>
        <button
          className={`voice-ctrl-btn ${isDeafened ? 'active' : ''}`}
          onClick={toggleDeafen}
          title={isDeafened ? 'Undeafen' : 'Deafen'}
        >
          {isDeafened ? '🔇' : '🎧'}
        </button>
        <button
          className={`voice-ctrl-btn ${isScreenSharing ? 'active' : ''}`}
          onClick={isScreenSharing ? stopScreenShare : startScreenShare}
          disabled={someoneElseSharing}
          title={
            someoneElseSharing
              ? 'Someone else is sharing'
              : isScreenSharing
                ? 'Stop Sharing'
                : 'Share Screen'
          }
        >
          🖥️
        </button>
        <button className="voice-ctrl-btn disconnect" onClick={leaveVoice} title="Disconnect">
          📞
        </button>
      </div>
    </div>
  );
}
