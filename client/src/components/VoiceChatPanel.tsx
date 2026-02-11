import { useEffect, useRef, useCallback } from 'react';
import { useVoiceChatStore, useVoiceStore } from '@abyss/shared';
import MessageItem from './MessageItem';
import MessageInput from './MessageInput';

export default function VoiceChatPanel() {
  const messages = useVoiceChatStore((s) => s.messages);
  const channelId = useVoiceChatStore((s) => s.channelId);
  const loading = useVoiceChatStore((s) => s.loading);
  const hasMore = useVoiceChatStore((s) => s.hasMore);
  const loadMore = useVoiceChatStore((s) => s.loadMore);
  const toggleVoiceChat = useVoiceStore((s) => s.toggleVoiceChat);

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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
