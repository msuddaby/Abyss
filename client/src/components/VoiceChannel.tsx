import { useServerStore } from '../stores/serverStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { Channel } from '../types';

interface Props {
  channel: Channel;
  isActive: boolean;
  isConnected: boolean;
  onSelect: () => void;
  onJoin: () => void;
  onLeave: () => void;
}

export default function VoiceChannel({ channel, isActive, isConnected, onSelect, onJoin, onLeave }: Props) {
  const voiceChannelUsers = useServerStore((s) => s.voiceChannelUsers);
  const voiceChannelSharers = useServerStore((s) => s.voiceChannelSharers);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  const channelUsers = voiceChannelUsers.get(channel.id);
  const channelSharers = voiceChannelSharers.get(channel.id);
  const participants = channelUsers ? Array.from(channelUsers.entries()) : [];

  return (
    <div className={`channel-item voice ${isActive ? 'active' : ''}`}>
      <button className="channel-item-btn" onClick={onSelect}>
        <span className="channel-voice-icon">🔊</span>
        {channel.name}
      </button>
      {isConnected ? (
        <button className="voice-action-btn leave" onClick={onLeave} title="Disconnect">
          ✕
        </button>
      ) : (
        <button className="voice-action-btn join" onClick={onJoin} title="Join Voice">
          →
        </button>
      )}
      {participants.length > 0 && (
        <div className="voice-participants">
          {participants.map(([userId, displayName]) => (
            <div key={userId} className="voice-participant">
              <span className={`participant-avatar${speakingUsers.has(userId) ? ' speaking' : ''}`}>{displayName.charAt(0).toUpperCase()}</span>
              <span className="participant-name">{displayName}</span>
              {channelSharers?.has(userId) && <span className="live-badge">LIVE</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
