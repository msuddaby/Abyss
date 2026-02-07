import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import {
  FlatList, View, Text, ActivityIndicator, StyleSheet,
  type ViewStyle, type TextStyle,
} from 'react-native';
import {
  useAuthStore, useMessageStore, getConnection, shouldGroupMessage,
} from '@abyss/shared';
import type { Message, Reaction } from '@abyss/shared';
import MessageItem from './MessageItem';
import { colors, spacing, fontSize } from '../theme/tokens';

interface Props {
  onPickReactionEmoji?: (messageId: string) => void;
}

export default function MessageList({ onPickReactionEmoji }: Props) {
  const messages = useMessageStore((s) => s.messages);
  const loading = useMessageStore((s) => s.loading);
  const hasMore = useMessageStore((s) => s.hasMore);
  const loadMore = useMessageStore((s) => s.loadMore);
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const highlightedMessageId = useMessageStore((s) => s.highlightedMessageId);
  const setHighlightedMessageId = useMessageStore((s) => s.setHighlightedMessageId);
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const flatListRef = useRef<FlatList<Message>>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

  const displayMessages = useMemo(() => {
    // Reverse so newest is first in data; inverted list flips it back visually
    return [...messages].reverse();
  }, [messages]);

  // SignalR listeners
  useEffect(() => {
    const conn = getConnection();
    const onMsg = (msg: Message) => addMessage(msg);
    const onEdit = (id: string, content: string, editedAt: string) => updateMessage(id, content, editedAt);
    const onDel = (id: string) => markDeleted(id);
    const onReactAdd = (r: Reaction) => addReaction(r);
    const onReactRm = (msgId: string, userId: string, emoji: string) => removeReaction(msgId, userId, emoji);

    conn.on('ReceiveMessage', onMsg);
    conn.on('MessageEdited', onEdit);
    conn.on('MessageDeleted', onDel);
    conn.on('ReactionAdded', onReactAdd);
    conn.on('ReactionRemoved', onReactRm);
    return () => {
      conn.off('ReceiveMessage', onMsg);
      conn.off('MessageEdited', onEdit);
      conn.off('MessageDeleted', onDel);
      conn.off('ReactionAdded', onReactAdd);
      conn.off('ReactionRemoved', onReactRm);
    };
  }, [addMessage, updateMessage, markDeleted, addReaction, removeReaction]);

  // Scroll to highlighted message from search
  useEffect(() => {
    if (highlightedMessageId && displayMessages.length > 0) {
      const idx = displayMessages.findIndex((m) => m.id === highlightedMessageId);
      if (idx !== -1) {
        // Wait for messages to render before scrolling
        setTimeout(() => {
          flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
          setHighlightId(highlightedMessageId);
          setTimeout(() => {
            setHighlightId(null);
            setHighlightedMessageId(null);
          }, 1500);
        }, 300);
      }
    }
  }, [highlightedMessageId, messages]);

  const handleEndReached = useCallback(async () => {
    if (hasMore && !loading) {
      isLoadingMoreRef.current = true;
      try {
        await loadMore();
      } finally {
        isLoadingMoreRef.current = false;
      }
    }
  }, [hasMore, loading, loadMore]);

  const scrollToMessage = useCallback((id: string) => {
    const idx = displayMessages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 1500);
  }, [displayMessages]);

  const renderItem = useCallback(({ item, index }: { item: Message; index: number }) => {
    // Inverted list: visual previous message is next item in data array
    const prevVisual = index + 1 < displayMessages.length ? displayMessages[index + 1] : undefined;
    const grouped = shouldGroupMessage(item, prevVisual);
    return (
      <View style={highlightId === item.id ? styles.highlighted : undefined}>
        <MessageItem
          message={item}
          grouped={grouped}
          onScrollToMessage={scrollToMessage}
          onPickReactionEmoji={onPickReactionEmoji}
        />
      </View>
    );
  }, [displayMessages, highlightId, scrollToMessage, onPickReactionEmoji]);

  const keyExtractor = useCallback((m: Message) => m.id, []);

  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const newCount = messages.length;
    prevMessageCountRef.current = newCount;

    if (isLoadingMoreRef.current) return;

    if (newCount > prevCount) {
      const lastMessage = messages[newCount - 1];
      const isOwnMessage = !!currentUserId && lastMessage?.authorId === currentUserId;
      if (isOwnMessage) {
        setTimeout(() => {
          flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        }, 0);
      }
    }
  }, [messages, currentUserId]);

  return (
    <FlatList
      ref={flatListRef}
      data={displayMessages}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      inverted
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.2}
      maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      style={styles.list}
      contentContainerStyle={messages.length === 0 && !loading ? styles.emptyContainer : undefined}
      ListHeaderComponent={loading ? (
        <View style={styles.loadingHeader}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : null}
      ListEmptyComponent={!loading ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No messages yet</Text>
        </View>
      ) : null}
      onScrollToIndexFailed={(info) => {
        flatListRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  } as ViewStyle,
  emptyContainer: {
    flex: 1,
  } as ViewStyle,
  loadingHeader: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  } as ViewStyle,
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  } as TextStyle,
  highlighted: {
    backgroundColor: 'rgba(88, 101, 242, 0.15)',
  } as ViewStyle,
});
