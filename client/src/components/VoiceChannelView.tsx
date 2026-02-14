import { Component, useRef, useEffect, useState } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { useServerStore, useVoiceStore, useAuthStore, useVoiceChatStore, useWatchPartyStore, getApiBase, hasChannelPermission, hasPermission, Permission, canActOn, ensureConnected } from '@abyss/shared';
import ScreenShareView from './ScreenShareView';
import { useWebRTC, getCameraVideoStream, getLocalCameraStream, requestWatch } from '../hooks/useWebRTC';
import { useContextMenuStore } from '../stores/contextMenuStore';
import { isMobile } from '../stores/mobileStore';

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
  const isTunedIn = useWatchPartyStore((s) => s.isTunedIn);
  const setTunedIn = useWatchPartyStore((s) => s.setTunedIn);

  const isConnected = !!activeChannel && currentChannelId === activeChannel.id;
  const hasWatchParty = isConnected && activeParty !== null && isTunedIn;
  const isWatching = isConnected && watchingUserId !== null && !hasWatchParty;
  const isFocused = isConnected && focusedUserId !== null && !isWatching && !hasWatchParty;
  const channelUsers = activeChannel ? voiceChannelUsers.get(activeChannel.id) : undefined;
  const channelSharers = activeChannel ? voiceChannelSharers.get(activeChannel.id) : undefined;
  const canConnect = activeChannel ? hasChannelPermission(activeChannel.permissions, Permission.Connect) : false;
  const isFull = !!(activeChannel?.userLimit && channelUsers && channelUsers.size >= activeChannel.userLimit && !isConnected);

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
      {activeChannel?.userLimit ? (
        <div className="vcv-user-limit-bar">
          {participantEntries.length}/{activeChannel.userLimit} users
        </div>
      ) : null}
      {isConnected && connectionState === 'reconnecting' && (
        <div className="vcv-reconnecting-banner">Connection lost — Reconnecting...</div>
      )}
      {isWatching ? (
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
                        <div className="vcv-badges">
                          <span className="vcv-badge tts">TTS</span>
                        </div>
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
                    <div className="vcv-badges">
                      <span className="vcv-badge tts">TTS</span>
                    </div>
                  )}
                  <span className="vcv-name">{state.displayName}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="vcv-scroll-area">
          {isConnected && activeParty !== null && !isTunedIn && (
            <div className="wp-tune-in-bar">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12z"/>
              </svg>
              <span className="wp-tune-in-title">{activeParty.itemTitle}</span>
              <button className="wp-tune-in-btn" onClick={() => setTunedIn(true)}>Tune In</button>
            </div>
          )}
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
                  {(isSharer || userHasCamera || ttsUsers.has(userId)) && (
                    <div className="vcv-badges">
                      {isSharer && <span className="vcv-badge live">LIVE</span>}
                      {userHasCamera && <span className="vcv-badge cam">CAM</span>}
                      {ttsUsers.has(userId) && <span className="vcv-badge tts">TTS</span>}
                    </div>
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
            disabled={isJoiningVoice || isFull}
          >
            {isJoiningVoice ? 'Connecting...' : isFull ? 'Channel Full' : 'Connect'}
          </button>
        </div>
      )}

      {isConnected && isMobile() && <MobileVoiceBar />}
    </div>
  );
}

function MobileVoiceBar() {
  const { leaveVoice, startScreenShare, stopScreenShare, startCamera, stopCamera } = useWebRTC();
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const channels = useServerStore((s) => s.channels);
  const channel = channels.find((c) => c.id === currentChannelId);
  const canStream = channel ? hasChannelPermission(channel.permissions, Permission.Stream) : false;

  return (
    <div className="vcv-mobile-bar">
      <button className={`vcv-mobile-btn${isMuted ? ' active' : ''}`} onClick={toggleMute} title="Mute">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
          <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
        </svg>
        {isMuted && <div className="vcv-mobile-btn-slash" />}
      </button>
      <button className={`vcv-mobile-btn${isDeafened ? ' active' : ''}`} onClick={toggleDeafen} title="Deafen">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>
        </svg>
        {isDeafened && <div className="vcv-mobile-btn-slash" />}
      </button>
      {canStream && (
        <button className={`vcv-mobile-btn${isCameraOn ? ' active' : ''}`} onClick={isCameraOn ? stopCamera : startCamera} title="Camera">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
          </svg>
        </button>
      )}
      {canStream && (
        <button className={`vcv-mobile-btn${isScreenSharing ? ' active' : ''}`} onClick={isScreenSharing ? stopScreenShare : startScreenShare} title="Screen Share">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
          </svg>
        </button>
      )}
      <button className="vcv-mobile-btn disconnect" onClick={leaveVoice} title="Disconnect">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
        </svg>
      </button>
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
