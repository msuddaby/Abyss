import { useEffect, useRef, useCallback } from 'react';
import { useVoiceChatStore, useVoiceStore, getMessageStyle } from '@abyss/shared';
import type { Message } from '@abyss/shared';
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
        {(() => {
          const groups: { key: string; msgs: { msg: Message; grouped: boolean }[]; cosmeticStyle?: React.CSSProperties }[] = [];
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const prev = messages[i - 1];
            const grouped =
              !!prev &&
              !msg.isSystem &&
              !prev.isSystem &&
              !prev.isDeleted &&
              !msg.replyTo &&
              prev.authorId === msg.authorId &&
              new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
            if (grouped && groups.length > 0) {
              groups[groups.length - 1].msgs.push({ msg, grouped: true });
            } else {
              groups.push({ key: msg.id, msgs: [{ msg, grouped: false }], cosmeticStyle: getMessageStyle(msg.author) });
            }
          }
          return groups.map((group) => (
            <div key={group.key} className={`message-group${group.cosmeticStyle ? ' message-cosmetic-group' : ''}`} style={group.cosmeticStyle}>
              {group.msgs.map(({ msg, grouped }) => (
                <div key={msg.id} data-message-id={msg.id}>
                  <MessageItem
                    message={msg}
                    grouped={grouped}
                    onScrollToMessage={scrollToMessage}
                  />
                </div>
              ))}
            </div>
          ));
        })()}
        <div ref={bottomRef} />
      </div>
      {channelId && <MessageInput channelId={channelId} />}
    </div>
  );
}
