import { useEffect } from 'react';
import { getConnection, startConnection, onReconnected } from '../services/signalr.js';
import { useServerStore } from '../stores/serverStore.js';
import { useAuthStore } from '../stores/authStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUnreadStore } from '../stores/unreadStore.js';
import { useDmStore } from '../stores/dmStore.js';
import { useFriendStore } from '../stores/friendStore.js';
import { useMessageStore } from '../stores/messageStore.js';
import { useSearchStore } from '../stores/searchStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useVoiceChatStore } from '../stores/voiceChatStore.js';
import { useToastStore } from '../stores/toastStore.js';
import { useAppConfigStore } from '../stores/appConfigStore.js';
import { useNotificationSettingsStore } from '../stores/notificationSettingsStore.js';
import { useUserPreferencesStore } from '../stores/userPreferencesStore.js';
import { useWatchPartyStore } from '../stores/watchPartyStore.js';
import { useMediaProviderStore } from '../stores/mediaProviderStore.js';
import { useSoundboardStore } from '../stores/soundboardStore.js';
import { showDesktopNotification, isElectron } from '../services/electronNotifications.js';
import { getApiBase } from '../services/api.js';
import type { HubConnection } from '@microsoft/signalr';
import type { Server, ServerMember, ServerRole, CustomEmoji, SoundboardClip, DmChannel, ServerNotifSettings, UserPreferences, Message, Reaction, WatchParty, QueueItem, MediaProviderConnection, FriendRequest, Friendship, EquippedCosmetics } from '../types/index.js';

// Sound playback cache and helper (uses `any` to avoid DOM lib dependency in shared package)
const soundCache = new Map<string, any>();
const normalizedVolumeCache = new Map<string, number>();
const pendingAnalysis = new Map<string, Promise<number>>();
const TARGET_RMS = 0.05; // target perceived loudness level (~-26 dB)
let analysisCtx: any = null;

function getNormalizedVolume(url: string): Promise<number> {
  const cached = normalizedVolumeCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = pendingAnalysis.get(url);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
      if (!AudioCtx) return TARGET_RMS;
      if (!analysisCtx) analysisCtx = new AudioCtx();
      if (analysisCtx.state === 'suspended') await analysisCtx.resume();

      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = await analysisCtx.decodeAudioData(arrayBuffer);

      let peak = 0;
      let sumSquares = 0;
      let totalSamples = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
          sumSquares += data[i] * data[i];
          totalSamples++;
        }
      }
      const rms = totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;

      // Normalize based on RMS (perceived loudness), with peak clamp to prevent clipping
      const volume = rms > 0
        ? Math.min(TARGET_RMS / rms, 1.0 / peak, 1.0)
        : TARGET_RMS;
      normalizedVolumeCache.set(url, volume);
      return volume;
    } catch {
      return TARGET_RMS;
    } finally {
      pendingAnalysis.delete(url);
    }
  })();

  pendingAnalysis.set(url, promise);
  return promise;
}

function playVoiceSound(url: string | null | undefined, fallbackPath: string) {
  if (typeof (globalThis as any).Audio === 'undefined') return;
  const soundUrl = url
    ? (url.startsWith('http') ? url : `${getApiBase()}${url}`)
    : fallbackPath;
  let audio = soundCache.get(soundUrl);
  if (!audio) {
    audio = new (globalThis as any).Audio(soundUrl);
    audio.preload = 'auto';
    soundCache.set(soundUrl, audio);
  }
  audio.currentTime = 0;

  if (url) {
    // Custom sound: normalize volume based on RMS loudness analysis
    getNormalizedVolume(soundUrl).then((vol) => {
      audio.volume = vol;
      audio.play().catch(() => {});
    });
  } else {
    // Default sound: fixed volume
    audio.volume = 0.5;
    audio.play().catch(() => {});
  }
}

export function fetchServerState(conn: HubConnection, serverId: string) {
  conn.invoke('GetServerVoiceUsers', serverId).then((data: Record<string, Record<string, { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }>>) => {
    useServerStore.getState().setVoiceChannelUsers(data);
  }).catch(console.error);

  conn.invoke('GetServerVoiceSharers', serverId).then((data: Record<string, string[]>) => {
    useServerStore.getState().setVoiceChannelSharers(data);
  }).catch(console.error);

  conn.invoke('GetServerVoiceCameras', serverId).then((data: Record<string, string[]>) => {
    useServerStore.getState().setVoiceChannelCameras(data);
  }).catch(console.error);

  conn.invoke('GetServerWatchParties', serverId).then((data: Record<string, string>) => {
    useServerStore.getState().setVoiceChannelWatchParties(data);
  }).catch(console.error);

  conn.invoke('GetOnlineUsers', serverId).then((userIds: string[]) => {
    usePresenceStore.getState().setOnlineUsers(userIds);
  }).catch(console.error);

  useMediaProviderStore.getState().fetchConnections(serverId);

  conn.invoke('GetUnreadState', serverId).then((unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => {
    useUnreadStore.getState().setChannelUnreads(serverId, unreads);
  }).catch(console.error);

  useNotificationSettingsStore.getState().fetchSettings(serverId);

  useSoundboardStore.getState().fetchClips(serverId);
}

export function refreshSignalRState(conn: HubConnection) {
  conn.invoke('GetAllServerUnreads').then((unreads: { serverId: string; hasUnread: boolean; mentionCount: number }[]) => {
    useUnreadStore.getState().setServerUnreads(unreads);
  }).catch(console.error);

  conn.invoke('GetDmChannels', 0, 50).then((dms: DmChannel[]) => {
    useDmStore.setState({ dmChannels: dms });
  }).catch(console.error);

  conn.invoke('GetDmUnreads').then((unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => {
    useUnreadStore.getState().setDmUnreads(unreads);
  }).catch(console.error);

  // Fetch user preferences from server (source of truth)
  useUserPreferencesStore.getState().fetchPreferences();

  useFriendStore.getState().fetchFriends().catch(console.error);
  useFriendStore.getState().fetchRequests().catch(console.error);

  const server = useServerStore.getState().activeServer;
  if (server) {
    fetchServerState(conn, server.id);
  }
}

export async function rejoinActiveChannel(conn: HubConnection) {
  const { isDmMode, activeDmChannel } = useDmStore.getState();
  const { activeChannel } = useServerStore.getState();
  const channelId = isDmMode ? activeDmChannel?.id : (activeChannel?.type === 'Text' ? activeChannel.id : null);
  if (!channelId) return;
  try {
    await conn.invoke('JoinChannel', channelId);
    useMessageStore.getState().fetchMessages(channelId);
  } catch (err) {
    console.error('Failed to rejoin channel:', err);
  }
}

export function useSignalRListeners() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const activeServer = useServerStore((s) => s.activeServer);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);

  // Connect + register all handlers
  useEffect(() => {
    startConnection().then(() => {
      const conn = getConnection();

      const events = [
        'UserOnline', 'UserOffline', 'UserIsTyping',
        'VoiceUserJoinedChannel', 'VoiceUserLeftChannel', 'VoiceUserStateUpdated',
        'ScreenShareStartedInChannel', 'ScreenShareStoppedInChannel',
        'CameraStartedInChannel', 'CameraStoppedInChannel',
        'UserProfileUpdated', 'MemberJoined', 'MemberRolesUpdated', 'MemberKicked', 'MemberBanned', 'MemberUnbanned',
        'RoleCreated', 'RoleUpdated', 'RoleDeleted',
        'EmojiCreated', 'EmojiUpdated', 'EmojiDeleted',
        'ChannelCreated', 'ChannelUpdated', 'ChannelDeleted', 'ChannelsReordered', 'ChannelPermissionsUpdated',
        'ServerDeleted', 'ServerUpdated',
        'NewUnreadMessage', 'MentionReceived',
        'DmChannelCreated',
        'FriendRequestReceived', 'FriendRequestAccepted', 'FriendRemoved',
        'Error', 'ConfigUpdated',
        'ServerDefaultNotificationLevelChanged', 'NotificationSettingsChanged', 'UserPreferencesChanged',
        'WatchPartyStarted', 'WatchPartyStopped', 'WatchPartyActive',
        'PlaybackCommand', 'SyncPosition', 'QueueUpdated', 'WatchPartyHostChanged',
        'WatchPartyStartedInChannel', 'WatchPartyStoppedInChannel',
        'MediaProviderLinked', 'MediaProviderUnlinked',
        'SoundboardClipPlayed', 'SoundboardClipAdded', 'SoundboardClipUpdated', 'SoundboardClipRemoved',
      ];
      for (const e of events) conn.off(e);

      conn.on('UserOnline', (userId: string) => {
        usePresenceStore.getState().setUserOnline(userId);
      });

      conn.on('UserOffline', (userId: string) => {
        usePresenceStore.getState().setUserOffline(userId);
      });

      conn.on('UserIsTyping', (userId: string, displayName: string) => {
        const channelId = usePresenceStore.getState().typingChannelId;
        if (channelId) {
          usePresenceStore.getState().addTypingUser(channelId, userId, displayName);
        }
      });

      conn.on('VoiceUserJoinedChannel', (channelId: string, userId: string, state: { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }, joinSoundUrl?: string) => {
        useServerStore.getState().voiceUserJoined(channelId, userId, state);
        const currentUser = useAuthStore.getState().user;
        const voiceState = useVoiceStore.getState();
        const isSelf = currentUser?.id === userId;
        // Self: always hear own join sound (just joined this channel)
        // Others: only if in the same voice channel and not deafened
        if (currentUser && !voiceState.isDeafened && (isSelf || voiceState.currentChannelId === channelId)) {
          playVoiceSound(joinSoundUrl, '/sounds/voice-join.mp3');
        }
      });

      conn.on('VoiceUserLeftChannel', (channelId: string, userId: string, leaveSoundUrl?: string) => {
        useServerStore.getState().voiceUserLeft(channelId, userId);
        const currentUser = useAuthStore.getState().user;
        const voiceState = useVoiceStore.getState();
        const isSelf = currentUser?.id === userId;
        if (currentUser && !voiceState.isDeafened && (isSelf || voiceState.currentChannelId === channelId)) {
          playVoiceSound(leaveSoundUrl, '/sounds/voice-leave.mp3');
        }
      });

      conn.on('VoiceUserStateUpdated', (channelId: string, userId: string, state: { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }) => {
        useServerStore.getState().voiceUserStateUpdated(channelId, userId, state);
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          useVoiceStore.getState().setMuteDeafen(state.isMuted, state.isDeafened);
        }
      });

      conn.on('ScreenShareStartedInChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceSharerStarted(channelId, userId);
      });

      conn.on('ScreenShareStoppedInChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceSharerStopped(channelId, userId);
      });

      conn.on('CameraStartedInChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceCameraStarted(channelId, userId);
      });

      conn.on('CameraStoppedInChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceCameraStopped(channelId, userId);
      });

      conn.on('UserProfileUpdated', () => {
        const server = useServerStore.getState().activeServer;
        if (server) {
          useServerStore.getState().fetchMembers(server.id);
        }
      });

      conn.on('MemberJoined', (serverId: string, member: ServerMember) => {
        const activeServer = useServerStore.getState().activeServer;
        if (activeServer?.id === serverId) {
          useServerStore.getState().addMemberLocal(member);
        }
      });

      conn.on('MemberRolesUpdated', (_serverId: string, userId: string, roles: ServerRole[]) => {
        useServerStore.getState().updateMemberRolesLocal(userId, roles);
      });

      conn.on('UserCosmeticsChanged', (userId: string, cosmetics: EquippedCosmetics | null) => {
        useServerStore.getState().updateMemberCosmetics(userId, cosmetics);
        useMessageStore.getState().updateAuthorCosmetics(userId, cosmetics);
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          const updatedUser = { ...currentUser, cosmetics };
          useAuthStore.setState({ user: updatedUser });
        }
      });

      conn.on('MemberKicked', (serverId: string, userId: string) => {
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          useServerStore.getState().removeServer(serverId);
        } else {
          useServerStore.getState().removeMember(userId);
        }
      });

      conn.on('MemberBanned', (serverId: string, userId: string) => {
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          useServerStore.getState().removeServer(serverId);
        } else {
          useServerStore.getState().removeMember(userId);
        }
      });

      conn.on('MemberUnbanned', (_serverId: string, userId: string) => {
        useServerStore.getState().removeBanLocal(userId);
      });

      conn.on('RoleCreated', (_serverId: string, role: ServerRole) => {
        useServerStore.getState().addRoleLocal(role);
      });

      conn.on('RoleUpdated', (_serverId: string, role: ServerRole) => {
        useServerStore.getState().updateRoleLocal(role);
      });

      conn.on('RoleDeleted', (_serverId: string, roleId: string) => {
        useServerStore.getState().removeRoleLocal(roleId);
      });

      conn.on('EmojiCreated', (_serverId: string, emoji: CustomEmoji) => {
        useServerStore.getState().addEmojiLocal(emoji);
      });

      conn.on('EmojiUpdated', (_serverId: string, emoji: CustomEmoji) => {
        useServerStore.getState().updateEmojiLocal(emoji);
      });

      conn.on('EmojiDeleted', (_serverId: string, emojiId: string) => {
        useServerStore.getState().removeEmojiLocal(emojiId);
      });

      const refreshChannels = async (serverId: string) => {
        const activeServer = useServerStore.getState().activeServer;
        if (activeServer?.id !== serverId) return;
        await useServerStore.getState().fetchChannels(serverId);
      };

      conn.on('ChannelCreated', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelUpdated', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelDeleted', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelsReordered', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelPermissionsUpdated', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ServerDeleted', (serverId: string) => {
        useServerStore.getState().removeServer(serverId);
      });

      conn.on('ServerUpdated', (_serverId: string, server: Server) => {
        useServerStore.getState().updateServerLocal(server);
      });

      conn.on('DmChannelCreated', (dm: DmChannel) => {
        useDmStore.getState().addDmChannelLocal(dm);
      });

      conn.on('FriendRequestReceived', (request: FriendRequest) => {
        useFriendStore.getState().addRequestLocal(request);
      });

      conn.on('FriendRequestAccepted', (friendship: Friendship) => {
        useFriendStore.getState().acceptRequestLocal(friendship);
      });

      conn.on('FriendRemoved', (friendshipId: string) => {
        useFriendStore.getState().removeFriendLocal(friendshipId);
      });

      conn.on('NewUnreadMessage', (channelId: string, serverId: string | null) => {
        if (!serverId) {
          const activeDm = useDmStore.getState().activeDmChannel;
          if (activeDm?.id === channelId) {
            conn.invoke('MarkChannelRead', channelId).catch(console.error);
          } else {
            useUnreadStore.getState().handleNewDmUnread(channelId);
          }
          useDmStore.getState().moveDmToTop(channelId);
        } else {
          const activeChannel = useServerStore.getState().activeChannel;
          if (activeChannel?.id === channelId && activeChannel.type === 'Text') {
            conn.invoke('MarkChannelRead', channelId).catch(console.error);
          } else {
            useUnreadStore.getState().handleNewUnreadMessage(channelId, serverId);
          }
        }
      });

      conn.on('MentionReceived', async (notification: { id: string; messageId: string; channelId: string; serverId: string | null; type: string; createdAt: string }) => {
        const isCurrentChannel = notification.serverId
          ? (useServerStore.getState().activeChannel?.id === notification.channelId && useServerStore.getState().activeChannel?.type === 'Text')
          : (useDmStore.getState().activeDmChannel?.id === notification.channelId);

        if (!notification.serverId) {
          const activeDm = useDmStore.getState().activeDmChannel;
          if (activeDm?.id === notification.channelId) {
            conn.invoke('MarkChannelRead', notification.channelId).catch(console.error);
          } else {
            useUnreadStore.getState().incrementDmMention(notification.channelId);
          }
        } else {
          const activeChannel = useServerStore.getState().activeChannel;
          if (activeChannel?.id === notification.channelId && activeChannel.type === 'Text') {
            conn.invoke('MarkChannelRead', notification.channelId).catch(console.error);
          } else {
            useUnreadStore.getState().incrementMention(notification.channelId, notification.serverId);
          }
        }

        // Show desktop notification for mentions if not in current channel
        // In Electron, also notify for the current channel when window is hidden/unfocused
        const isWindowHidden = isElectron()
          ? !(await (window as any).electron.isFocused())
          : false;
        if (!isCurrentChannel || isWindowHidden) {
          const channelName = notification.serverId
            ? useServerStore.getState().channels.find(c => c.id === notification.channelId)?.name || 'a channel'
            : 'a DM';
          const serverName = notification.serverId
            ? useServerStore.getState().servers.find(s => s.id === notification.serverId)?.name
            : null;

          const title = serverName
            ? `You were mentioned in #${channelName} (${serverName})`
            : `You were mentioned in ${channelName}`;

          await showDesktopNotification(
            title,
            'Click to view',
            { channelId: notification.channelId, messageId: notification.messageId, serverId: notification.serverId }
          );
        }
      });

      conn.on('Error', (message: string) => {
        if (message) {
          useToastStore.getState().addToast(message, 'error');
        }
      });

      conn.on('ConfigUpdated', (payload: { maxMessageLength: number } | number) => {
        const value = typeof payload === 'number' ? payload : payload?.maxMessageLength;
        if (typeof value === 'number' && value > 0) {
          useAppConfigStore.getState().setMaxMessageLength(value);
        }
      });

      conn.on('ServerDefaultNotificationLevelChanged', (serverId: string, level: number) => {
        useServerStore.getState().updateServerLocal({ ...useServerStore.getState().servers.find(s => s.id === serverId)!, defaultNotificationLevel: level });
      });

      conn.on('NotificationSettingsChanged', (serverId: string, settings: ServerNotifSettings) => {
        useNotificationSettingsStore.getState().setServerSetting(serverId, settings);
      });

      conn.on('UserPreferencesChanged', (prefs: UserPreferences) => {
        useUserPreferencesStore.getState().applyToVoiceStore(prefs);
        useUserPreferencesStore.setState({ preferences: prefs });
      });

      // Voice chat message handlers — dispatches to voiceChatStore
      // (separate from MessageList's handlers which dispatch to messageStore)
      const vcStore = useVoiceChatStore.getState;
      conn.on('ReceiveMessage', (message: Message) => {
        vcStore().addMessage(message);
      });
      conn.on('MessageEdited', (messageId: string, content: string, editedAt: string) => {
        vcStore().updateMessage(messageId, content, editedAt);
      });
      conn.on('MessageDeleted', (messageId: string) => {
        vcStore().markDeleted(messageId);
      });
      conn.on('ReactionAdded', (reaction: Reaction) => {
        vcStore().addReaction(reaction);
      });
      conn.on('ReactionRemoved', (messageId: string, userId: string, emoji: string) => {
        vcStore().removeReaction(messageId, userId, emoji);
      });

      // Watch party event handlers
      conn.on('WatchPartyStarted', (party: WatchParty) => {
        useWatchPartyStore.getState().setActiveParty(party);
      });

      conn.on('WatchPartyStopped', (_channelId: string) => {
        useWatchPartyStore.getState().setActiveParty(null);
      });

      conn.on('WatchPartyActive', (party: WatchParty) => {
        useWatchPartyStore.getState().setActiveParty(party);
      });

      conn.on('PlaybackCommand', (command: string, timeMs: number) => {
        useWatchPartyStore.getState().updatePlaybackState(timeMs, command !== 'pause');
      });

      conn.on('SyncPosition', (timeMs: number, isPlaying: boolean) => {
        useWatchPartyStore.getState().updatePlaybackState(timeMs, isPlaying);
      });

      conn.on('QueueUpdated', (queue: QueueItem[]) => {
        useWatchPartyStore.getState().setQueue(queue);
      });

      conn.on('WatchPartyHostChanged', (newHostUserId: string) => {
        useWatchPartyStore.getState().updateHost(newHostUserId);
      });

      conn.on('WatchPartyStartedInChannel', (channelId: string, itemTitle: string) => {
        useServerStore.getState().watchPartyStartedInChannel(channelId, itemTitle);
      });

      conn.on('WatchPartyStoppedInChannel', (channelId: string) => {
        useServerStore.getState().watchPartyStoppedInChannel(channelId);
      });

      conn.on('MediaProviderLinked', (connection: MediaProviderConnection) => {
        useMediaProviderStore.getState().addConnection(connection);
      });

      conn.on('MediaProviderUnlinked', (connectionId: string) => {
        useMediaProviderStore.getState().removeConnection(connectionId);
      });

      // Soundboard event handlers
      conn.on('SoundboardClipPlayed', (_channelId: string, clipUrl: string, _clipName: string, _userId: string) => {
        const voiceState = useVoiceStore.getState();
        if (voiceState.currentChannelId && !voiceState.isDeafened) {
          playVoiceSound(clipUrl, '');
        }
      });

      conn.on('SoundboardClipAdded', (_serverId: string, clip: SoundboardClip) => {
        useSoundboardStore.getState().addClipLocal(clip);
      });

      conn.on('SoundboardClipUpdated', (_serverId: string, clip: SoundboardClip) => {
        useSoundboardStore.getState().updateClipLocal(clip);
      });

      conn.on('SoundboardClipRemoved', (_serverId: string, clipId: string) => {
        useSoundboardStore.getState().removeClipLocal(clipId);
      });

      refreshSignalRState(conn);
    }).catch(console.error);
  }, []);

  // Re-join channel group after any reconnection (auto-reconnect OR manual fallback)
  useEffect(() => {
    return onReconnected(() => {
      const conn = getConnection();
      rejoinActiveChannel(conn);
      refreshSignalRState(conn);
    });
  }, []);

  // Fetch voice channel users when switching servers + periodic reconciliation
  useEffect(() => {
    if (!activeServer) return;
    useSearchStore.getState().closeSearch();
    const conn = getConnection();
    if (conn.state === 'Connected') {
      fetchServerState(conn, activeServer.id);
    }

    // Periodic reconciliation: re-fetch voice state every 30s to self-heal
    // any stale state from missed signals or race conditions
    const interval = setInterval(() => {
      const c = getConnection();
      if (c.state === 'Connected') {
        c.invoke('GetServerVoiceUsers', activeServer.id).then((data: Record<string, Record<string, { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }>>) => {
          useServerStore.getState().mergeVoiceChannelUsers(data);
        }).catch(console.error);
        c.invoke('GetServerVoiceSharers', activeServer.id).then((data: Record<string, string[]>) => {
          useServerStore.getState().setVoiceChannelSharers(data);

          // Also reconcile voiceStore.activeSharers for the current voice channel
          const vs = useVoiceStore.getState();
          const channelId = vs.currentChannelId;
          if (channelId) {
            const serverSharerIds = new Set(data[channelId] ?? []);
            const localSharerIds = new Set(vs.activeSharers.keys());
            const drifted =
              serverSharerIds.size !== localSharerIds.size ||
              [...serverSharerIds].some((id) => !localSharerIds.has(id));
            if (drifted) {
              const reconciled = new Map<string, string>();
              for (const uid of serverSharerIds) {
                reconciled.set(uid, vs.participants.get(uid) ?? uid);
              }
              vs.setActiveSharers(reconciled);
            }
          }
        }).catch(console.error);
        c.invoke('GetServerVoiceCameras', activeServer.id).then((data: Record<string, string[]>) => {
          useServerStore.getState().setVoiceChannelCameras(data);

          // Reconcile voiceStore.activeCameras for the current voice channel
          const vs = useVoiceStore.getState();
          const channelId = vs.currentChannelId;
          if (channelId) {
            const serverCamIds = new Set(data[channelId] ?? []);
            const localCamIds = new Set(vs.activeCameras.keys());
            const drifted =
              serverCamIds.size !== localCamIds.size ||
              [...serverCamIds].some((id) => !localCamIds.has(id));
            if (drifted) {
              const reconciled = new Map<string, string>();
              for (const uid of serverCamIds) {
                reconciled.set(uid, vs.participants.get(uid) ?? uid);
              }
              vs.setActiveCameras(reconciled);
            }
          }
        }).catch(console.error);
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [activeServer]);

  // Track which channel is active for typing indicators
  useEffect(() => {
    if (isDmMode && activeDmChannel) {
      usePresenceStore.getState().setTypingChannel(activeDmChannel.id);
    } else if (activeChannel?.type === 'Text') {
      usePresenceStore.getState().setTypingChannel(activeChannel.id);
    } else {
      usePresenceStore.getState().setTypingChannel(null);
    }
  }, [activeChannel, isDmMode, activeDmChannel]);

  // Auto-mark channel as read when switching to a text channel
  useEffect(() => {
    if (activeChannel?.type === 'Text' && activeServer) {
      const conn = getConnection();
      if (conn.state === 'Connected') {
        conn.invoke('MarkChannelRead', activeChannel.id).catch(console.error);
      }
      useUnreadStore.getState().markChannelRead(activeChannel.id, activeServer.id);
    }
  }, [activeChannel, activeServer]);

  // Auto-mark DM channel as read when switching
  useEffect(() => {
    if (isDmMode && activeDmChannel) {
      const conn = getConnection();
      if (conn.state === 'Connected') {
        conn.invoke('MarkChannelRead', activeDmChannel.id).catch(console.error);
      }
      useUnreadStore.getState().markDmChannelRead(activeDmChannel.id);
    }
  }, [isDmMode, activeDmChannel]);
}
