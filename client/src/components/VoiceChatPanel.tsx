import { useEffect, useRef, useState, useCallback } from 'react';
import { getConnection, useVoiceChatStore, useVoiceStore } from '@abyss/shared';
import type { Message, Reaction } from '@abyss/shared';
import MessageItem from './MessageItem';
import MessageInput from './MessageInput';

export default function VoiceChatPanel() {
  const messages = useVoiceChatStore((s) => s.messages);
  const channelId = useVoiceChatStore((s) => s.channelId);
  const loading = useVoiceChatStore((s) => s.loading);
  const hasMore = useVoiceChatStore((s) => s.hasMore);
  const loadMore = useVoiceChatStore((s) => s.loadMore);
  const addMessage = useVoiceChatStore((s) => s.addMessage);
  const updateMessage = useVoiceChatStore((s) => s.updateMessage);
  const markDeleted = useVoiceChatStore((s) => s.markDeleted);
  const addReaction = useVoiceChatStore((s) => s.addReaction);
  const removeReaction = useVoiceChatStore((s) => s.removeReaction);
  const toggleVoiceChat = useVoiceStore((s) => s.toggleVoiceChat);

  const [contextMenuMessageId, setContextMenuMessageId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // SignalR listeners for voice chat messages
  useEffect(() => {
    const conn = getConnection();
    const onReceive = (message: Message) => addMessage(message);
    const onEdit = (messageId: string, content: string, editedAt: string) => updateMessage(messageId, content, editedAt);
    const onDelete = (messageId: string) => markDeleted(messageId);
    const onReactionAdded = (reaction: Reaction) => addReaction(reaction);
    const onReactionRemoved = (messageId: string, userId: string, emoji: string) => removeReaction(messageId, userId, emoji);

    conn.on('ReceiveMessage', onReceive);
    conn.on('MessageEdited', onEdit);
    conn.on('MessageDeleted', onDelete);
    conn.on('ReactionAdded', onReactionAdded);
    conn.on('ReactionRemoved', onReactionRemoved);
    return () => {
      conn.off('ReceiveMessage', onReceive);
      conn.off('MessageEdited', onEdit);
      conn.off('MessageDeleted', onDelete);
      conn.off('ReactionAdded', onReactionAdded);
      conn.off('ReactionRemoved', onReactionRemoved);
    };
  }, [addMessage, updateMessage, markDeleted, addReaction, removeReaction]);

  // Auto-scroll when new messages arrive (if near bottom)
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 100;
    if (el.scrollTop === 0 && hasMore && !loading) {
      loadMore();
    }
  }, [hasMore, loading, loadMore]);

  const scrollToMessage = useCallback((id: string) => {
    const el = listRef.current?.querySelector(`[data-message-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('message-highlight');
    setTimeout(() => el.classList.remove('message-highlight'), 1500);
  }, []);

  return (
    <div className="voice-chat-panel">
      <div className="voice-chat-header">
        <span>Chat</span>
        <button className="voice-chat-close" onClick={toggleVoiceChat} title="Close chat">&#x2715;</button>
      </div>
      <div className="voice-chat-messages" ref={listRef} onScroll={handleScroll}>
        {loading && <div className="loading">Loading...</div>}
        {!hasMore && messages.length > 0 && (
          <div className="voice-chat-start">Beginning of chat</div>
        )}
        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const grouped =
            !!prev &&
            !msg.isSystem &&
            !prev.isSystem &&
            !prev.isDeleted &&
            !msg.replyTo &&
            prev.authorId === msg.authorId &&
            new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
          return (
            <div key={msg.id} data-message-id={msg.id}>
              <MessageItem
                message={msg}
                grouped={grouped}
                contextMenuOpen={contextMenuMessageId === msg.id}
                setContextMenuMessageId={setContextMenuMessageId}
                onScrollToMessage={scrollToMessage}
              />
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {channelId && <MessageInput channelId={channelId} />}
    </div>
  );
}
