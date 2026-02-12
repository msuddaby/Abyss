import { Component, useRef, useEffect, useState } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { useServerStore, useVoiceStore, useAuthStore, useVoiceChatStore, useWatchPartyStore, getApiBase, hasChannelPermission, hasPermission, Permission, canActOn, ensureConnected } from '@abyss/shared';
import ScreenShareView from './ScreenShareView';
import WatchPartyPlayer from './WatchPartyPlayer';
import { useWebRTC, getCameraVideoStream, getLocalCameraStream, requestWatch } from '../hooks/useWebRTC';
import { useContextMenuStore } from '../stores/contextMenuStore';

class VoiceErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Voice UI error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="vcv-error-fallback">
          <p>Something went wrong in the voice UI.</p>
          <button onClick={() => this.setState({ hasError: false })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function VideoTile({ userId, isLocal, version }: { userId: string; isLocal: boolean; version: number }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const stream = isLocal ? getLocalCameraStream() : getCameraVideoStream(userId);
    if (stream) {
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }
      // Clear srcObject when the last video track ends (e.g. camera stopped remotely)
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const onEnded = () => { video.srcObject = null; };
        videoTrack.addEventListener('ended', onEnded);
        return () => videoTrack.removeEventListener('ended', onEnded);
      }
    } else {
      video.srcObject = null;
    }
  }, [userId, isLocal, version]);

  return (
    <video
      ref={ref}
      className="vcv-video"
      autoPlay
      playsInline
      muted={isLocal}
    />
  );
}

function VoiceChannelViewInner() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const voiceChannelUsers = useServerStore((s) => s.voiceChannelUsers);
  const voiceChannelSharers = useServerStore((s) => s.voiceChannelSharers);
  const members = useServerStore((s) => s.members);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const participants = useVoiceStore((s) => s.participants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const activeCameras = useVoiceStore((s) => s.activeCameras);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const focusedUserId = useVoiceStore((s) => s.focusedUserId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const cameraStreamVersion = useVoiceStore((s) => s.cameraStreamVersion);
  const currentUser = useAuthStore((s) => s.user);
  const { joinVoice } = useWebRTC();
  const setFocusedUserId = useVoiceStore((s) => s.setFocusedUserId);

  const connectionState = useVoiceStore((s) => s.connectionState);
  const isJoiningVoice = useVoiceStore((s) => s.isJoiningVoice);

  const ttsUsers = useVoiceChatStore((s) => s.ttsUsers);
  const openContextMenu = useContextMenuStore((s) => s.open);

  const handleContextMenu = (userId: string, e: React.MouseEvent) => {
    if (userId === currentUser?.id) return;
    e.preventDefault();
    const member = members.find((m) => m.userId === userId);
    const channelUser = channelUsers?.get(userId);
    openContextMenu(e.clientX, e.clientY, {
      user: member?.user ?? { id: userId, username: '', displayName: channelUser?.displayName ?? userId, status: '', bio: '' },
      member,
    });
  };

  // Moderator permissions for focused user controls
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canModerateVoice = currentMember ? hasPermission(currentMember, Permission.MuteMembers) : false;

  const handleModerate = async (targetUserId: string, newMuted: boolean, newDeafened: boolean) => {
    try {
      const conn = await ensureConnected();
      await conn.invoke('ModerateVoiceState', targetUserId, newMuted, newDeafened);
    } catch (err) {
      console.warn('Failed to moderate voice state', err);
    }
  };

  const activeParty = useWatchPartyStore((s) => s.activeParty);

  const isConnected = !!activeChannel && currentChannelId === activeChannel.id;
  const hasWatchParty = isConnected && activeParty !== null;
  const isWatching = isConnected && watchingUserId !== null && !hasWatchParty;
  const isFocused = isConnected && focusedUserId !== null && !isWatching && !hasWatchParty;
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

  const hasCamera = (userId: string): boolean => {
    if (userId === currentUser?.id) return isCameraOn;
    return activeCameras.has(userId);
  };

  const focusedEntry = isFocused ? participantEntries.find(([uid]) => uid === focusedUserId) : null;
  const [showParticipants, setShowParticipants] = useState(true);

  return (
    <div className="vcv-container">
      {isConnected && connectionState === 'reconnecting' && (
        <div className="vcv-reconnecting-banner">Connection lost — Reconnecting...</div>
      )}
      {hasWatchParty ? (
        <WatchPartyPlayer />
      ) : isWatching ? (
        <div className={`vcv-watching-layout${showParticipants ? ' panel-open' : ''}`}>
          <div className="vcv-watching-main">
            <ScreenShareView />
          </div>
          {showParticipants && (
            <div className="vcv-watching-panel">
              <div className="vcv-watching-panel-list">
                {participantEntries.map(([userId, state]) => {
                  const isSpeaking = speakingUsers.has(userId);
                  const avatarUrl = getMemberAvatar(userId);
                  const userHasCamera = hasCamera(userId);
                  const isSelf = userId === currentUser?.id;
                  return (
                    <div key={userId} className="vcv-watching-tile" onContextMenu={(e) => handleContextMenu(userId, e)}>
                      {userHasCamera ? (
                        <VideoTile userId={userId} isLocal={isSelf} version={cameraStreamVersion} />
                      ) : (
                        <div className={`vcv-watching-avatar-wrap${isSpeaking ? ' speaking' : ''}`}>
                          <div className="vcv-avatar">
                            {avatarUrl ? <img src={avatarUrl} alt={state.displayName} /> : state.displayName.charAt(0).toUpperCase()}
                          </div>
                        </div>
                      )}
                      {ttsUsers.has(userId) && (
                        <div className="vcv-tts-badge">TTS</div>
                      )}
                      <span className="vcv-watching-tile-name">{state.displayName}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <button
            className="vcv-toggle-panel"
            onClick={() => setShowParticipants(!showParticipants)}
            title={showParticipants ? 'Hide participants' : 'Show participants'}
          >
            {showParticipants ? '▶' : '◀'}
          </button>
        </div>
      ) : isFocused && focusedEntry ? (
        <div className="vcv-focused-container">
          <div className="vcv-focused-header">
            <span className="vcv-focused-name">{focusedEntry[1].displayName}</span>
            <div className="vcv-focused-actions">
              {(() => {
                const targetMember = members.find((m) => m.userId === focusedUserId);
                const canMod = canModerateVoice && focusedUserId !== currentUser?.id && currentMember && targetMember && canActOn(currentMember, targetMember);
                const userState = channelUsers?.get(focusedUserId!);
                return canMod && userState ? (
                  <>
                    <button
                      className={`vcv-focused-chip${userState.isMuted ? ' active' : ''}`}
                      onClick={() => handleModerate(focusedUserId!, !userState.isMuted, userState.isDeafened)}
                      title={userState.isMuted ? 'Unmute User' : 'Mute User'}
                    >
                      🔇
                    </button>
                    <button
                      className={`vcv-focused-chip${userState.isDeafened ? ' active' : ''}`}
                      onClick={() => handleModerate(focusedUserId!, userState.isMuted, !userState.isDeafened)}
                      title={userState.isDeafened ? 'Undeafen User' : 'Deafen User'}
                    >
                      🎧
                    </button>
                  </>
                ) : null;
              })()}
              {activeSharers.has(focusedUserId!) && (
                <button
                  className="vcv-focused-chip"
                  onClick={() => requestWatch(focusedUserId!)}
                >
                  Watch Screen
                </button>
              )}
              <button className="vcv-focused-close" onClick={() => setFocusedUserId(null)}>✕</button>
            </div>
          </div>
          <div className="vcv-focused-video-area">
            {hasCamera(focusedUserId!) ? (
              <VideoTile
                userId={focusedUserId!}
                isLocal={focusedUserId === currentUser?.id}
                version={cameraStreamVersion}
              />
            ) : (
              <div className="vcv-focused-avatar">
                {(() => {
                  const avatarUrl = getMemberAvatar(focusedUserId!);
                  return avatarUrl
                    ? <img src={avatarUrl} alt={focusedEntry[1].displayName} />
                    : <span>{focusedEntry[1].displayName.charAt(0).toUpperCase()}</span>;
                })()}
              </div>
            )}
          </div>
          <div className="vcv-participant-strip">
            {participantEntries.map(([userId, state]) => {
              const isSpeaking = speakingUsers.has(userId);
              const avatarUrl = getMemberAvatar(userId);
              const userHasCamera = hasCamera(userId);
              return (
                <div
                  key={userId}
                  className={`vcv-strip-card${userId === focusedUserId ? ' focused' : ''}`}
                  onClick={() => setFocusedUserId(userId)}
                  onContextMenu={(e) => handleContextMenu(userId, e)}
                >
                  {userHasCamera ? (
                    <VideoTile userId={userId} isLocal={userId === currentUser?.id} version={cameraStreamVersion} />
                  ) : (
                    <div className={`vcv-avatar-ring${isSpeaking ? ' speaking' : ''}`}>
                      <div className="vcv-avatar">
                        {avatarUrl ? <img src={avatarUrl} alt={state.displayName} /> : state.displayName.charAt(0).toUpperCase()}
                      </div>
                    </div>
                  )}
                  {ttsUsers.has(userId) && (
                    <div className="vcv-tts-badge">TTS</div>
                  )}
                  <span className="vcv-name">{state.displayName}</span>
                </div>
              );
            })}
          </div>
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
              const userHasCamera = isConnected && hasCamera(userId);

              return (
                <div
                  key={userId}
                  className={`vcv-card${userHasCamera ? ' has-video' : ''}`}
                  onClick={() => isConnected && setFocusedUserId(userId)}
                  onContextMenu={(e) => handleContextMenu(userId, e)}
                  style={{ cursor: isConnected ? 'pointer' : undefined }}
                >
                  {userHasCamera ? (
                    <VideoTile userId={userId} isLocal={isSelf} version={cameraStreamVersion} />
                  ) : (
                    <div className={`vcv-avatar-ring${isSpeaking ? ' speaking' : ''}`}>
                      <div className="vcv-avatar">
                        {avatarUrl
                          ? <img src={avatarUrl} alt={state.displayName} />
                          : state.displayName.charAt(0).toUpperCase()
                        }
                      </div>
                    </div>
                  )}
                  {(memberIsMuted || memberIsDeafened) && (
                    <div className="vcv-mute-overlay">
                      {memberIsMuted && <span>🔇</span>}
                      {memberIsDeafened && <span>🎧</span>}
                    </div>
                  )}
                  {isSharer && (
                    <div className="vcv-live-badge">LIVE</div>
                  )}
                  {ttsUsers.has(userId) && (
                    <div className="vcv-tts-badge">TTS</div>
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
            disabled={isJoiningVoice}
          >
            {isJoiningVoice ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function VoiceChannelView() {
  return (
    <VoiceErrorBoundary>
      <VoiceChannelViewInner />
    </VoiceErrorBoundary>
  );
}
