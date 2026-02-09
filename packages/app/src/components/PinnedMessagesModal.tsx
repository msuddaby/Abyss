import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, type ViewStyle, type TextStyle } from 'react-native';
import {
  api,
  getApiBase,
  useAuthStore,
  useDmStore,
  useMessageStore,
  useServerStore,
  hasPermission,
  Permission,
  formatDate,
  formatTime,
} from '@abyss/shared';
import type { Message, PinnedMessage } from '@abyss/shared';
import Modal from './Modal';
import Avatar from './Avatar';
import { colors, spacing, fontSize, borderRadius } from '../theme/tokens';
import { useUiStore } from '../stores/uiStore';

export default function PinnedMessagesModal({ channelId }: { channelId: string }) {
  const pinnedByChannel = useMessageStore((s) => s.pinnedByChannel);
  const pinnedLoading = useMessageStore((s) => s.pinnedLoading);
  const fetchPinnedMessages = useMessageStore((s) => s.fetchPinnedMessages);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);
  const setHighlightedMessageId = useMessageStore((s) => s.setHighlightedMessageId);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const members = useServerStore((s) => s.members);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const closeModal = useUiStore((s) => s.closeModal);

  const currentMember = members.find((m) => m.userId === currentUserId);
  const canManageMessages = currentMember ? hasPermission(currentMember, Permission.ManageMessages) : false;
  const canUnpin = isDmMode || canManageMessages;
  const pins = pinnedByChannel[channelId] || [];

  useEffect(() => {
    fetchPinnedMessages(channelId).catch(() => {});
  }, [channelId, fetchPinnedMessages]);

  const jumpToMessage = async (pinned: PinnedMessage) => {
    try {
      const res = await api.get(`/channels/${channelId}/messages/around/${pinned.message.id}`);
      const messages: Message[] = res.data;
      useMessageStore.setState({
        messages,
        currentChannelId: channelId,
        hasMore: true,
        hasNewer: true,
        loading: false,
      });
      setHighlightedMessageId(pinned.message.id);
      closeModal();
    } catch (e) {
      console.error('Failed to jump to message', e);
      useMessageStore.getState().fetchMessages(channelId).catch(() => {});
    }
  };

  return (
    <Modal title="Pinned Messages">
      <View style={styles.list}>
        {pinnedLoading && (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Text style={styles.loadingText}>Loading pins...</Text>
          </View>
        )}
        {!pinnedLoading && pins.length === 0 && (
          <Text style={styles.emptyText}>No pinned messages yet.</Text>
        )}
        {pins.map((p) => {
          const avatarUri = p.message.author.avatarUrl
            ? (p.message.author.avatarUrl.startsWith('http')
              ? p.message.author.avatarUrl
              : `${getApiBase()}${p.message.author.avatarUrl}`)
            : undefined;
          const excerpt = p.message.content
            ? p.message.content
            : (p.message.attachments.length > 0 ? '[Attachment]' : '[No content]');
          return (
            <View key={p.message.id} style={styles.card}>
              <View style={styles.cardMeta}>
                <Avatar uri={avatarUri} name={p.message.author.displayName} size={32} />
                <View style={styles.cardInfo}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardAuthor}>{p.message.author.displayName}</Text>
                    <Text style={styles.cardTime}>
                      {formatDate(p.message.createdAt)} {formatTime(p.message.createdAt)}
                    </Text>
                  </View>
                  <Text style={styles.cardExcerpt} numberOfLines={2}>
                    {excerpt}
                  </Text>
                </View>
              </View>
              <View style={styles.cardActions}>
                <Pressable style={styles.jumpButton} onPress={() => jumpToMessage(p)}>
                  <Text style={styles.jumpButtonText}>Jump</Text>
                </Pressable>
                {canUnpin && (
                  <Pressable style={styles.unpinButton} onPress={() => unpinMessage(p.message.id)}>
                    <Text style={styles.unpinButtonText}>Unpin</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.md,
  } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  } as TextStyle,
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,
  cardMeta: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  cardInfo: {
    flex: 1,
  } as ViewStyle,
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: 2,
  } as ViewStyle,
  cardAuthor: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
    flex: 1,
  } as TextStyle,
  cardTime: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  cardExcerpt: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  } as TextStyle,
  cardActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  jumpButton: {
    backgroundColor: colors.bgModifierHover,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  jumpButtonText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  unpinButton: {
    backgroundColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  unpinButtonText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
});
