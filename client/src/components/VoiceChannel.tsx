import { useServerStore, useVoiceStore, useVoiceChatStore, useAuthStore, getApiBase, hasPermission, hasChannelPermission, Permission, canActOn, ensureConnected } from '@abyss/shared';
import type { Channel } from '@abyss/shared';
import { useContextMenuStore } from '../stores/contextMenuStore';

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
  const voiceChannelCameras = useServerStore((s) => s.voiceChannelCameras);
  const voiceChannelWatchParties = useServerStore((s) => s.voiceChannelWatchParties);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const setFocusedUserId = useVoiceStore((s) => s.setFocusedUserId);
  const canConnect = hasChannelPermission(channel.permissions, Permission.Connect);
  const ttsUsers = useVoiceChatStore((s) => s.ttsUsers);
  const openContextMenu = useContextMenuStore((s) => s.open);

  const channelUsers = voiceChannelUsers.get(channel.id);
  const channelSharers = voiceChannelSharers.get(channel.id);
  const channelCameras = voiceChannelCameras.get(channel.id);
  const watchPartyTitle = voiceChannelWatchParties.get(channel.id);
  const participants = channelUsers ? Array.from(channelUsers.entries()) : [];
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canModerateVoice = currentMember ? hasPermission(currentMember, Permission.MuteMembers) : false;

  const handleParticipantContextMenu = (userId: string, e: React.MouseEvent) => {
    if (userId === currentUser?.id) return;
    e.preventDefault();
    e.stopPropagation();
    const member = members.find((m) => m.userId === userId);
    openContextMenu(e.clientX, e.clientY, {
      user: member?.user ?? { id: userId, username: '', displayName: channelUsers?.get(userId)?.displayName ?? userId, status: '', bio: '' },
      member,
    });
  };

  const handleModerate = async (targetUserId: string, isMuted: boolean, isDeafened: boolean) => {
    try {
      const conn = await ensureConnected();
      await conn.invoke('ModerateVoiceState', targetUserId, isMuted, isDeafened);
    } catch (err) {
      console.warn('Failed to moderate voice state', err);
    }
  };

  return (
    <div className={`channel-item voice ${isActive ? 'active' : ''}`}>
      <button className="channel-item-btn" onClick={onSelect}>
        <span className="channel-voice-icon">🔊</span>
        {channel.name}
        {watchPartyTitle && <span className="vcv-watch-badge">WATCH</span>}
      </button>
      {isConnected ? (
        <button className="voice-action-btn leave" onClick={onLeave} title="Disconnect">
          ✕
        </button>
      ) : canConnect ? (
        <button className="voice-action-btn join" onClick={onJoin} title="Join Voice">
          →
        </button>
      ) : (
        <span className="voice-action-lock" title="No permission to connect">🔒</span>
      )}
      {participants.length > 0 && (
        <div className="voice-participants">
          {participants.map(([userId, state]) => {
            const targetMember = members.find((m) => m.userId === userId);
            const canActOnMember = !!(currentMember && targetMember && canActOn(currentMember, targetMember));
            const showModeration = canModerateVoice && canActOnMember;
            const avatarUrl = targetMember?.user?.avatarUrl
              ? (targetMember.user.avatarUrl.startsWith('http') ? targetMember.user.avatarUrl : `${getApiBase()}${targetMember.user.avatarUrl}`)
              : null;

            return (
              <div
                key={userId}
                className="voice-participant"
                onClick={() => {
                  onSelect();
                  setFocusedUserId(userId);
                }}
                onContextMenu={(e) => handleParticipantContextMenu(userId, e)}
                style={{ cursor: 'pointer' }}
              >
                <span className={`participant-avatar${speakingUsers.has(userId) ? ' speaking' : ''}`}>
                  {avatarUrl ? <img src={avatarUrl} alt={state.displayName} /> : state.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="participant-name">{state.displayName}</span>
                <div className="voice-participant-right">
                  {ttsUsers.has(userId) && <span className="tts-badge">TTS</span>}
                  {channelCameras?.has(userId) && <span className="camera-badge">CAM</span>}
                  {channelSharers?.has(userId) && <span className="live-badge">LIVE</span>}
                  {showModeration && (
                    <div className="voice-participant-actions">
                      <button
                        className={`voice-participant-action-btn ${state.isMuted ? 'active' : ''}`}
                        onClick={() => handleModerate(userId, !state.isMuted, state.isDeafened)}
                        title={state.isMuted ? 'Unmute User' : 'Mute User'}
                      >
                        🔇
                      </button>
                      <button
                        className={`voice-participant-action-btn ${state.isDeafened ? 'active' : ''}`}
                        onClick={() => handleModerate(userId, state.isMuted, !state.isDeafened)}
                        title={state.isDeafened ? 'Undeafen User' : 'Deafen User'}
                      >
                        🎧
                      </button>
                    </div>
                  )}
                  {(state.isMuted || state.isDeafened) && (
                    <span className="voice-status-icons">
                      {state.isMuted && (
                        <span
                          className={`voice-status-icon${state.isServerMuted ? ' locked' : ''}`}
                          title={state.isServerMuted ? 'Server muted' : 'Muted'}
                        >
                          🔇
                        </span>
                      )}
                      {state.isDeafened && (
                        <span
                          className={`voice-status-icon${state.isServerDeafened ? ' locked' : ''}`}
                          title={state.isServerDeafened ? 'Server deafened' : 'Deafened'}
                        >
                          🎧
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
