import { useEffect, useRef, useCallback, useState } from 'react';
import {
  FlatList, View, Text, ActivityIndicator, StyleSheet,
  type ViewStyle, type TextStyle, type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import {
  useMessageStore, getConnection, shouldGroupMessage,
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
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);

  const flatListRef = useRef<FlatList<Message>>(null);
  const prevChannelRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const contentHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const listHeightRef = useRef(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);

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

  // Scroll to bottom on channel switch
  useEffect(() => {
    if (currentChannelId !== prevChannelRef.current) {
      prevChannelRef.current = currentChannelId;
      prevMessageCountRef.current = 0;
    }
  }, [currentChannelId]);

  // Scroll to bottom when messages load or new message arrives near bottom
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const newCount = messages.length;
    prevMessageCountRef.current = newCount;

    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      return;
    }

    // Channel switch: initial load
    if (prevCount === 0 && newCount > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
      return;
    }

    // New message: scroll only if near bottom
    if (newCount > prevCount && prevCount > 0) {
      const distFromBottom = contentHeightRef.current - scrollOffsetRef.current - listHeightRef.current;
      if (distFromBottom < 150) {
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
      }
    }
  }, [messages]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollOffsetRef.current = contentOffset.y;
    contentHeightRef.current = contentSize.height;
    listHeightRef.current = layoutMeasurement.height;

    // Load more when near top
    if (contentOffset.y < 100 && hasMore && !loading) {
      isLoadingMoreRef.current = true;
      loadMore();
    }
  }, [hasMore, loading, loadMore]);

  const scrollToMessage = useCallback((id: string) => {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 1500);
  }, [messages]);

  const renderItem = useCallback(({ item, index }: { item: Message; index: number }) => {
    const prev = index > 0 ? messages[index - 1] : undefined;
    const grouped = shouldGroupMessage(item, prev);
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
  }, [messages, highlightId, scrollToMessage, onPickReactionEmoji]);

  const keyExtractor = useCallback((m: Message) => m.id, []);

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      onScroll={handleScroll}
      scrollEventThrottle={16}
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
