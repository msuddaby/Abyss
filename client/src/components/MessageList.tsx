import { useEffect, useRef, useState } from 'react';
import { useMessageStore } from '../stores/messageStore';
import { getConnection } from '../services/signalr';
import MessageItem from './MessageItem';
import type { Message, Reaction } from '../types';

export default function MessageList() {
  const { messages, loading, hasMore, loadMore } = useMessageStore();
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [contextMenuMessageId, setContextMenuMessageId] = useState<string | null>(null);
  const prevChannelRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);

  useEffect(() => {
    const conn = getConnection();
    const handler = (message: Message) => {
      addMessage(message);
    };
    const editHandler = (messageId: string, content: string, editedAt: string) => {
      updateMessage(messageId, content, editedAt);
    };
    const deleteHandler = (messageId: string) => {
      markDeleted(messageId);
    };
    const reactionAddedHandler = (reaction: Reaction) => {
      addReaction(reaction);
    };
    const reactionRemovedHandler = (messageId: string, userId: string, emoji: string) => {
      removeReaction(messageId, userId, emoji);
    };
    conn.on('ReceiveMessage', handler);
    conn.on('MessageEdited', editHandler);
    conn.on('MessageDeleted', deleteHandler);
    conn.on('ReactionAdded', reactionAddedHandler);
    conn.on('ReactionRemoved', reactionRemovedHandler);
    return () => {
      conn.off('ReceiveMessage', handler);
      conn.off('MessageEdited', editHandler);
      conn.off('MessageDeleted', deleteHandler);
      conn.off('ReactionAdded', reactionAddedHandler);
      conn.off('ReactionRemoved', reactionRemovedHandler);
    };
  }, [addMessage, updateMessage, markDeleted, addReaction, removeReaction]);

  // Scroll to bottom on channel switch
  useEffect(() => {
    if (currentChannelId !== prevChannelRef.current) {
      prevChannelRef.current = currentChannelId;
      // Wait for messages to render then scroll
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView();
      });
    }
  }, [currentChannelId, messages]);

  // Scroll to bottom on new messages (only if near bottom), preserve position on loadMore
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prevCount = prevMessageCountRef.current;
    const newCount = messages.length;
    prevMessageCountRef.current = newCount;

    if (isLoadingMoreRef.current) {
      // Preserve scroll position after prepending older messages
      isLoadingMoreRef.current = false;
      return;
    }

    if (newCount > prevCount && prevCount > 0) {
      // New message arrived — scroll to bottom only if user is near the bottom
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (distanceFromBottom < 150) {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        });
      }
    }
  }, [messages]);

  const handleScroll = () => {
    if (listRef.current && listRef.current.scrollTop === 0 && hasMore && !loading) {
      const list = listRef.current;
      const prevScrollHeight = list.scrollHeight;
      isLoadingMoreRef.current = true;
      loadMore().then(() => {
        // Restore scroll position after older messages are prepended
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight - prevScrollHeight;
        });
      });
    }
  };

  return (
    <div className="message-list" ref={listRef} onScroll={handleScroll}>
      {loading && <div className="loading">Loading messages...</div>}
      {messages.map((msg, i) => {
        const prev = messages[i - 1];
        const grouped = !!prev && !prev.isDeleted && prev.authorId === msg.authorId &&
          new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
        return (
          <MessageItem key={msg.id} message={msg} grouped={grouped} contextMenuOpen={contextMenuMessageId === msg.id} setContextMenuMessageId={setContextMenuMessageId} />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
