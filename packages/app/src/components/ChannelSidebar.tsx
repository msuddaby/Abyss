import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import {
  useServerStore, useMessageStore, useVoiceStore, useAuthStore,
  useUnreadStore, useDmStore, usePresenceStore, useFriendStore,
  getApiBase, hasPermission, Permission, canViewChannel,
} from '@abyss/shared';
import type { Channel, DmChannel } from '@abyss/shared';
import {
  NestableDraggableFlatList,
  NestableScrollContainer,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ChannelItem from './ChannelItem';
import VoiceChannelItem from './VoiceChannelItem';
import VoiceControls from './VoiceControls';
import UserBar from './UserBar';
import Avatar from './Avatar';
import Badge from './Badge';
import { useWebRTC } from '../hooks/useWebRTC';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function ChannelSidebar() {
  const activeServer = useServerStore((s) => s.activeServer);
  const channels = useServerStore((s) => s.channels);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const members = useServerStore((s) => s.members);
  const joinChannel = useMessageStore((s) => s.joinChannel);
  const leaveChannel = useMessageStore((s) => s.leaveChannel);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const voiceChannelId = useVoiceStore((s) => s.currentChannelId);
  const user = useAuthStore((s) => s.user);
  const channelUnreads = useUnreadStore((s) => s.channelUnreads);
  const dmUnreads = useUnreadStore((s) => s.dmUnreads);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const dmChannels = useDmStore((s) => s.dmChannels);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);
  const setActiveDmChannel = useDmStore((s) => s.setActiveDmChannel);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const { joinVoice, leaveVoice } = useWebRTC();
  const closeLeftDrawer = useUiStore((s) => s.closeLeftDrawer);
  const openModal = useUiStore((s) => s.openModal);

  const [editingText, setEditingText] = useState(false);
  const [editingVoice, setEditingVoice] = useState(false);

  const currentMember = members.find((m) => m.userId === user?.id);
  const canManageChannels = currentMember ? hasPermission(currentMember, Permission.ManageChannels) : false;
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;
  const canViewAuditLog = currentMember ? hasPermission(currentMember, Permission.ViewAuditLog) : false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;
  const canBanMembers = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const showServerSettingsBtn = canManageServer || canViewAuditLog || canManageRoles || canBanMembers || (currentMember?.isOwner ?? false);

  // Join + fetch messages when activeChannel changes
  useEffect(() => {
    if (activeChannel && activeChannel.type === 'Text' && currentChannelId !== activeChannel.id) {
      const join = async () => {
        if (currentChannelId) {
          await leaveChannel(currentChannelId);
        }
        await joinChannel(activeChannel.id);
      };
      join().catch(console.error);
      fetchMessages(activeChannel.id);
    }
  }, [activeChannel]);

  // Exit edit mode when server changes
  useEffect(() => {
    setEditingText(false);
    setEditingVoice(false);
  }, [activeServer?.id]);

  const friendRequests = useFriendStore((s) => s.requests);
  const incomingRequestCount = friendRequests.filter((r) => !r.isOutgoing).length;

  // All hooks must be above early returns to satisfy Rules of Hooks
  const visibleChannels = activeServer ? channels.filter((c) => canViewChannel(c)) : [];
  const textChannels = visibleChannels.filter((c) => c.type === 'Text');
  const voiceChannels = visibleChannels.filter((c) => c.type === 'Voice');

  const handleChannelPress = useCallback((channel: typeof channels[0]) => {
    setActiveChannel(channel);
    closeLeftDrawer();
  }, [setActiveChannel, closeLeftDrawer]);

  const handleVoiceJoin = useCallback(async (channelId: string) => {
    await joinVoice(channelId);
    const voiceChannel = channels.find((c) => c.id === channelId);
    if (voiceChannel) setActiveChannel(voiceChannel);
    closeLeftDrawer();
  }, [channels, joinVoice, setActiveChannel, closeLeftDrawer]);

  const handleVoiceLeave = useCallback(async () => {
    await leaveVoice();
  }, [leaveVoice]);

  const handleTextDragEnd = useCallback(({ data }: { data: Channel[] }) => {
    const channelIds = data.map((c) => c.id);
    useServerStore.getState().reorderChannels(activeServer?.id ?? '', 'Text', channelIds);
  }, [activeServer?.id]);

  const handleVoiceDragEnd = useCallback(({ data }: { data: Channel[] }) => {
    const channelIds = data.map((c) => c.id);
    useServerStore.getState().reorderChannels(activeServer?.id ?? '', 'Voice', channelIds);
  }, [activeServer?.id]);

  const renderDraggableTextChannel = useCallback(({ item: channel, drag, isActive: isDragging }: RenderItemParams<Channel>) => {
    const unread = channelUnreads.get(channel.id);
    const hasUnread = !!(unread?.hasUnread && activeChannel?.id !== channel.id);
    const mentionCount = unread?.mentionCount || 0;
    return (
      <View style={[styles.draggableRow, isDragging && styles.draggableRowActive]}>
        <Pressable onLongPress={drag} style={styles.dragHandle}>
          <Text style={styles.dragHandleText}>{'\u2261'}</Text>
        </Pressable>
        <View style={styles.draggableItemContent}>
          <ChannelItem
            name={channel.name}
            isActive={activeChannel?.id === channel.id}
            hasUnread={hasUnread}
            mentionCount={mentionCount}
            onPress={() => handleChannelPress(channel)}
            onLongPress={() => openModal('channelNotifications', { channelId: channel.id, channelName: channel.name })}
          />
        </View>
      </View>
    );
  }, [activeChannel?.id, channelUnreads, handleChannelPress, openModal]);

  const renderDraggableVoiceChannel = useCallback(({ item: channel, drag, isActive: isDragging }: RenderItemParams<Channel>) => {
    return (
      <View style={[styles.draggableRow, isDragging && styles.draggableRowActive]}>
        <Pressable onLongPress={drag} style={styles.dragHandle}>
          <Text style={styles.dragHandleText}>{'\u2261'}</Text>
        </Pressable>
        <View style={styles.draggableItemContent}>
          <VoiceChannelItem
            channel={channel}
            isActive={activeChannel?.id === channel.id}
            isConnected={voiceChannelId === channel.id}
            onSelect={() => handleChannelPress(channel)}
            onJoin={() => handleVoiceJoin(channel.id)}
            onLeave={handleVoiceLeave}
          />
        </View>
      </View>
    );
  }, [activeChannel?.id, voiceChannelId, handleChannelPress, handleVoiceJoin, handleVoiceLeave]);

  const keyExtractor = useCallback((item: Channel) => item.id, []);

  const isEditing = editingText || editingVoice;

  // ── DM Mode ──
  if (isDmMode) {
    const handleDmPress = async (dm: DmChannel) => {
      if (currentChannelId) {
        await leaveChannel(currentChannelId).catch(console.error);
      }
      setActiveDmChannel(dm);
      await joinChannel(dm.id).catch(console.error);
      fetchMessages(dm.id);
      closeLeftDrawer();
    };

    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.serverName}>Direct Messages</Text>
          <Pressable onPress={() => openModal('friends')}>
            <Text style={styles.headerBtn}>{'👥'}</Text>
          </Pressable>
        </View>
        {/* Friends button */}
        <Pressable
          style={styles.friendsButton}
          onPress={() => openModal('friends')}
        >
          <Text style={styles.friendsButtonText}>Friends</Text>
          {incomingRequestCount > 0 && (
            <Badge count={incomingRequestCount} />
          )}
        </Pressable>
        <ScrollView style={styles.channelList} showsVerticalScrollIndicator={false}>
          {dmChannels.length === 0 && (
            <Text style={styles.emptyText}>No conversations yet.</Text>
          )}
          {dmChannels.map((dm) => {
            const unread = dmUnreads.get(dm.id);
            const hasUnread = !!(unread?.hasUnread && activeDmChannel?.id !== dm.id);
            const mentionCount = unread?.mentionCount || 0;
            const isOnline = onlineUsers.has(dm.otherUser.id);
            const isActive = activeDmChannel?.id === dm.id;
            const avatarUri = dm.otherUser.avatarUrl
              ? (dm.otherUser.avatarUrl.startsWith('http') ? dm.otherUser.avatarUrl : `${getApiBase()}${dm.otherUser.avatarUrl}`)
              : undefined;

            return (
              <Pressable
                key={dm.id}
                style={[styles.dmItem, isActive && styles.dmItemActive]}
                onPress={() => handleDmPress(dm)}
              >
                <Avatar uri={avatarUri} name={dm.otherUser.displayName} size={32} online={isOnline} />
                <Text style={[styles.dmName, hasUnread && styles.dmNameUnread]} numberOfLines={1}>
                  {dm.otherUser.displayName}
                </Text>
                {mentionCount > 0 && !isActive && <Badge count={mentionCount} />}
                {hasUnread && mentionCount === 0 && <Badge dot />}
              </Pressable>
            );
          })}
        </ScrollView>
        <VoiceControls />
        <UserBar />
      </View>
    );
  }

  // ── No Server Selected ──
  if (!activeServer) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.serverName}>Select a server</Text>
        </View>
        <View style={{ flex: 1 }} />
        <VoiceControls />
        <UserBar />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.serverName} numberOfLines={1}>{activeServer.name}</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={() => openModal('search')}>
            <Text style={styles.headerBtn}>{'🔍'}</Text>
          </Pressable>
          {showServerSettingsBtn && (
            <Pressable onPress={() => openModal('serverSettings')}>
              <Text style={styles.headerBtn}>{'⚙'}</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={styles.actionBtn}
          onPress={() => openModal('invite')}
        >
          <Text style={styles.actionBtnText}>Invite</Text>
        </Pressable>
        {canManageChannels && (
          <Pressable
            style={styles.actionBtn}
            onPress={() => openModal('createChannel')}
          >
            <Text style={styles.actionBtnText}>+ Channel</Text>
          </Pressable>
        )}
      </View>

      {isEditing ? (
        <NestableScrollContainer style={styles.channelList} showsVerticalScrollIndicator={false}>
          {textChannels.length > 0 && (
            <View style={styles.category}>
              <View style={styles.categoryHeader}>
                <Text style={styles.categoryLabel}>TEXT CHANNELS</Text>
                {canManageChannels && (
                  editingText ? (
                    <Pressable
                      style={styles.editToggle}
                      onPress={() => setEditingText(false)}
                    >
                      <Text style={styles.editToggleDone}>Done</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={styles.editToggle}
                      onPress={() => setEditingText(true)}
                    >
                      <Text style={styles.editToggleText}>Edit</Text>
                    </Pressable>
                  )
                )}
              </View>
              {editingText ? (
                <NestableDraggableFlatList
                  data={textChannels}
                  keyExtractor={keyExtractor}
                  renderItem={renderDraggableTextChannel}
                  onDragEnd={handleTextDragEnd}
                />
              ) : (
                <>
                  {textChannels.map((channel) => {
                    const unread = channelUnreads.get(channel.id);
                    const hasUnread = !!(unread?.hasUnread && activeChannel?.id !== channel.id);
                    const mentionCount = unread?.mentionCount || 0;
                    return (
                      <ChannelItem
                        key={channel.id}
                        name={channel.name}
                        isActive={activeChannel?.id === channel.id}
                        hasUnread={hasUnread}
                        mentionCount={mentionCount}
                        onPress={() => handleChannelPress(channel)}
                        onLongPress={() => openModal('channelNotifications', { channelId: channel.id, channelName: channel.name })}
                      />
                    );
                  })}
                </>
              )}
            </View>
          )}
          {voiceChannels.length > 0 && (
            <View style={styles.category}>
              <View style={styles.categoryHeader}>
                <Text style={styles.categoryLabel}>VOICE CHANNELS</Text>
                {canManageChannels && (
                  editingVoice ? (
                    <Pressable
                      style={styles.editToggle}
                      onPress={() => setEditingVoice(false)}
                    >
                      <Text style={styles.editToggleDone}>Done</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={styles.editToggle}
                      onPress={() => setEditingVoice(true)}
                    >
                      <Text style={styles.editToggleText}>Edit</Text>
                    </Pressable>
                  )
                )}
              </View>
              {editingVoice ? (
                <NestableDraggableFlatList
                  data={voiceChannels}
                  keyExtractor={keyExtractor}
                  renderItem={renderDraggableVoiceChannel}
                  onDragEnd={handleVoiceDragEnd}
                />
              ) : (
                <>
                  {voiceChannels.map((channel) => (
                    <VoiceChannelItem
                      key={channel.id}
                      channel={channel}
                      isActive={activeChannel?.id === channel.id}
                      isConnected={voiceChannelId === channel.id}
                      onSelect={() => handleChannelPress(channel)}
                      onJoin={() => handleVoiceJoin(channel.id)}
                      onLeave={handleVoiceLeave}
                    />
                  ))}
                </>
              )}
            </View>
          )}
        </NestableScrollContainer>
      ) : (
        <ScrollView style={styles.channelList} showsVerticalScrollIndicator={false}>
          {textChannels.length > 0 && (
            <View style={styles.category}>
              <View style={styles.categoryHeader}>
                <Text style={styles.categoryLabel}>TEXT CHANNELS</Text>
                {canManageChannels && (
                  <Pressable
                    style={styles.editToggle}
                    onPress={() => setEditingText(true)}
                  >
                    <Text style={styles.editToggleText}>Edit</Text>
                  </Pressable>
                )}
              </View>
              {textChannels.map((channel) => {
                const unread = channelUnreads.get(channel.id);
                const hasUnread = !!(unread?.hasUnread && activeChannel?.id !== channel.id);
                const mentionCount = unread?.mentionCount || 0;
                return (
                  <ChannelItem
                    key={channel.id}
                    name={channel.name}
                    isActive={activeChannel?.id === channel.id}
                    hasUnread={hasUnread}
                    mentionCount={mentionCount}
                    onPress={() => handleChannelPress(channel)}
                    onLongPress={() => openModal('channelNotifications', { channelId: channel.id, channelName: channel.name })}
                  />
                );
              })}
            </View>
          )}
          {voiceChannels.length > 0 && (
            <View style={styles.category}>
              <View style={styles.categoryHeader}>
                <Text style={styles.categoryLabel}>VOICE CHANNELS</Text>
                {canManageChannels && (
                  <Pressable
                    style={styles.editToggle}
                    onPress={() => setEditingVoice(true)}
                  >
                    <Text style={styles.editToggleText}>Edit</Text>
                  </Pressable>
                )}
              </View>
              {voiceChannels.map((channel) => (
                <VoiceChannelItem
                  key={channel.id}
                  channel={channel}
                  isActive={activeChannel?.id === channel.id}
                  isConnected={voiceChannelId === channel.id}
                  onSelect={() => handleChannelPress(channel)}
                  onJoin={() => handleVoiceJoin(channel.id)}
                  onLeave={handleVoiceLeave}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}

      <VoiceControls />
      <UserBar />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: 240,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  serverName: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
    flex: 1,
  } as TextStyle,
  headerBtn: {
    color: colors.textSecondary,
    fontSize: 18,
    paddingLeft: spacing.sm,
  } as TextStyle,
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  } as ViewStyle,
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  } as ViewStyle,
  actionBtn: {
    backgroundColor: colors.bgModifierHover,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  actionBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  } as TextStyle,
  channelList: {
    flex: 1,
  } as ViewStyle,
  category: {
    paddingTop: spacing.lg,
  } as ViewStyle,
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
  } as ViewStyle,
  categoryLabel: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
  } as TextStyle,
  editToggle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  } as ViewStyle,
  editToggleText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
  editToggleDone: {
    color: colors.brandColor,
    fontSize: fontSize.xs,
    fontWeight: '700',
  } as TextStyle,
  draggableRow: {
    flexDirection: 'row',
    alignItems: 'center',
  } as ViewStyle,
  draggableRowActive: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    opacity: 0.9,
  } as ViewStyle,
  dragHandle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  } as ViewStyle,
  dragHandleText: {
    color: colors.textMuted,
    fontSize: 20,
    fontWeight: '700',
  } as TextStyle,
  draggableItemContent: {
    flex: 1,
  } as ViewStyle,
  dmItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    gap: spacing.sm,
  } as ViewStyle,
  dmItemActive: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  dmName: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    flex: 1,
  } as TextStyle,
  dmNameUnread: {
    color: colors.headerPrimary,
    fontWeight: '600',
  } as TextStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    padding: spacing.lg,
  } as TextStyle,
  friendsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.sm,
    marginTop: spacing.xs,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgModifierHover,
  } as ViewStyle,
  friendsButtonText: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
});
