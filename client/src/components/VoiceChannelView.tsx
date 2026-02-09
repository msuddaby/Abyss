import { useServerStore, useVoiceStore, useAuthStore, getApiBase, hasChannelPermission, Permission } from '@abyss/shared';
import ScreenShareView from './ScreenShareView';
import { useWebRTC } from '../hooks/useWebRTC';

export default function VoiceChannelView() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const voiceChannelUsers = useServerStore((s) => s.voiceChannelUsers);
  const voiceChannelSharers = useServerStore((s) => s.voiceChannelSharers);
  const members = useServerStore((s) => s.members);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const participants = useVoiceStore((s) => s.participants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const currentUser = useAuthStore((s) => s.user);
  const { joinVoice } = useWebRTC();

  const isConnected = !!activeChannel && currentChannelId === activeChannel.id;
  const isWatching = isConnected && watchingUserId !== null;
  const channelUsers = activeChannel ? voiceChannelUsers.get(activeChannel.id) : undefined;
  const channelSharers = activeChannel ? voiceChannelSharers.get(activeChannel.id) : undefined;
  const canConnect = activeChannel ? hasChannelPermission(activeChannel.permissions, Permission.Connect) : false;

  const participantEntries = isConnected
    ? Array.from(participants.entries()).map(([userId, displayName]) => {
        const state = channelUsers?.get(userId) ?? { displayName, isMuted: false, isDeafened: false, isServerMuted: false, isServerDeafened: false };
        return [userId, state] as const;
      })
    : Array.from((channelUsers || new Map()).entries());

  const getMemberAvatar = (userId: string): string | null => {
    const member = members.find((m) => m.userId === userId);
    if (!member?.user?.avatarUrl) return null;
    return member.user.avatarUrl.startsWith('http') ? member.user.avatarUrl : `${getApiBase()}${member.user.avatarUrl}`;
  };

  return (
    <div className="vcv-container">
      {isWatching ? (
        <div className="vcv-screen-share-fullscreen">
          <ScreenShareView />
        </div>
      ) : (
        <div className="vcv-scroll-area">
          {isConnected && activeSharers.size > 0 && (
            <div className="vcv-screen-share-section">
              <ScreenShareView />
            </div>
          )}

          {!isConnected && (
            <div className="vcv-not-connected">Not connected</div>
          )}

          <div className="vcv-grid">
            {participantEntries.map(([userId, state]) => {
              const isSpeaking = isConnected && speakingUsers.has(userId);
              const isSelf = userId === currentUser?.id;
              const memberIsMuted = isSelf ? isMuted : state.isMuted;
              const memberIsDeafened = isSelf ? isDeafened : state.isDeafened;
              const isSharer = isConnected
                ? activeSharers.has(userId)
                : !!channelSharers?.has(userId);
              const avatarUrl = getMemberAvatar(userId);

              return (
                <div key={userId} className="vcv-card">
                  <div className={`vcv-avatar-ring${isSpeaking ? ' speaking' : ''}`}>
                    <div className="vcv-avatar">
                      {avatarUrl
                        ? <img src={avatarUrl} alt={state.displayName} />
                        : state.displayName.charAt(0).toUpperCase()
                      }
                    </div>
                  </div>
                  {(memberIsMuted || memberIsDeafened) && (
                    <div className="vcv-mute-overlay">
                      {memberIsMuted && <span>🔇</span>}
                      {memberIsDeafened && <span>🎧</span>}
                    </div>
                  )}
                  {isSharer && (
                    <div className="vcv-live-badge">LIVE</div>
                  )}
                  <span className="vcv-name">{state.displayName}</span>
                </div>
              );
            })}
          </div>

          {participantEntries.length === 0 && (
            <div className="vcv-empty">No one in voice yet</div>
          )}
        </div>
      )}

      {!isConnected && canConnect && activeChannel && (
        <div className="vcv-connect-bar">
          <button
            className="vcv-connect-btn"
            onClick={() => joinVoice(activeChannel.id)}
          >
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
