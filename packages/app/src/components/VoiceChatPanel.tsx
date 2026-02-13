import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  Modal,
  Dimensions,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  useVoiceChatStore,
  useVoiceStore,
  getApiBase,
  formatTime,
} from '@abyss/shared';
import type { Message } from '@abyss/shared';
import Avatar from './Avatar';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

const SCREEN_HEIGHT = Dimensions.get('window').height;

export default function VoiceChatPanel() {
  const messages = useVoiceChatStore((s) => s.messages);
  const channelId = useVoiceChatStore((s) => s.channelId);
  const loading = useVoiceChatStore((s) => s.loading);
  const hasMore = useVoiceChatStore((s) => s.hasMore);
  const sendMessage = useVoiceChatStore((s) => s.sendMessage);
  const loadMore = useVoiceChatStore((s) => s.loadMore);
  const clearUnread = useVoiceChatStore((s) => s.clearUnread);
  const setChannel = useVoiceChatStore((s) => s.setChannel);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const setVoiceChatOpen = useVoiceStore((s) => s.setVoiceChatOpen);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    clearUnread();
    if (!channelId && currentChannelId) {
      setChannel(currentChannelId, true);
    }
  }, [channelId, currentChannelId, clearUnread, setChannel]);

  const closeModal = useUiStore((s) => s.closeModal);

  const handleClose = () => {
    setVoiceChatOpen(false);
    closeModal();
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendMessage(trimmed);
      setText('');
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  const handleLoadMore = () => {
    if (hasMore && !loading) {
      loadMore().catch(() => {});
    }
  };

  const getAvatarUri = (avatarUrl?: string): string | undefined => {
    if (!avatarUrl) return undefined;
    return avatarUrl.startsWith('http') ? avatarUrl : `${getApiBase()}${avatarUrl}`;
  };

  const renderMessage = ({ item }: { item: Message }) => {
    if (item.isDeleted) {
      return (
        <View style={styles.messageRow}>
          <View style={styles.deletedAvatarSlot} />
          <View style={styles.messageBubble}>
            <Text style={styles.deletedText}>Message deleted</Text>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.messageRow}>
        <Avatar
          uri={getAvatarUri(item.author.avatarUrl)}
          name={item.author.displayName}
          size={32}
        />
        <View style={styles.messageBubble}>
          <View style={styles.messageHeader}>
            <Text style={styles.authorName} numberOfLines={1}>
              {item.author.displayName}
            </Text>
            <Text style={styles.timestamp}>{formatTime(item.createdAt)}</Text>
          </View>
          {item.content ? (
            <Text style={styles.messageContent}>{item.content}</Text>
          ) : null}
          {item.attachments.length > 0 && (
            <Text style={styles.attachmentText}>
              {item.attachments.length} attachment{item.attachments.length > 1 ? 's' : ''}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={styles.panel} onPress={() => {}}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.handleBar} />
            <View style={styles.headerRow}>
              <Text style={styles.headerTitle}>Voice Chat</Text>
              <Pressable onPress={handleClose} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </Pressable>
            </View>
          </View>

          {/* Messages */}
          <FlatList
            ref={listRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            inverted
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.3}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>
                  {loading ? 'Loading messages...' : 'No messages yet. Say something!'}
                </Text>
              </View>
            }
          />

          {/* Input */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Message voice chat..."
              placeholderTextColor={colors.textMuted}
              value={text}
              onChangeText={setText}
              multiline
              maxLength={2000}
            />
            <Pressable
              style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!text.trim() || sending}
            >
              <Text style={styles.sendBtnText}>Send</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  } as ViewStyle,
  panel: {
    height: SCREEN_HEIGHT * 0.6,
    backgroundColor: colors.bgPrimary,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
  } as ViewStyle,
  header: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  } as ViewStyle,
  headerTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '700',
  } as TextStyle,
  closeBtn: {
    padding: spacing.xs,
  } as ViewStyle,
  closeBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.xl,
  } as TextStyle,
  listContent: {
    padding: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,
  messageRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  deletedAvatarSlot: {
    width: 32,
    height: 32,
  } as ViewStyle,
  messageBubble: {
    flex: 1,
  } as ViewStyle,
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: 2,
  } as ViewStyle,
  authorName: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    flexShrink: 1,
  } as TextStyle,
  timestamp: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  messageContent: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.4,
  } as TextStyle,
  attachmentText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
    marginTop: 2,
  } as TextStyle,
  deletedText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
  } as TextStyle,
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  } as ViewStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    textAlign: 'center',
  } as TextStyle,
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
  } as ViewStyle,
  input: {
    flex: 1,
    backgroundColor: colors.channelTextArea,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    maxHeight: 100,
  } as TextStyle,
  sendBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
  } as ViewStyle,
  sendBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,
  sendBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
});
