import { useEffect, useRef, useState, useCallback } from "react";
import { useAuthStore, useMessageStore, getConnection } from "@abyss/shared";
import type { Message, Reaction } from "@abyss/shared";
import MessageItem from "./MessageItem";

export default function MessageList() {
  const { messages, loading, hasMore, loadMore } = useMessageStore();
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [contextMenuMessageId, setContextMenuMessageId] = useState<
    string | null
  >(null);
  const prevChannelRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const incomingSoundRef = useRef<HTMLAudioElement | null>(null);
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const currentUserId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    incomingSoundRef.current = new Audio('/sounds/message-sent.mp3');
    incomingSoundRef.current.preload = 'auto';
    const conn = getConnection();
    const handler = (message: Message) => {
      addMessage(message);
      const isFromOtherUser = message.authorId && message.authorId !== currentUserId;
      const isDifferentChannel = message.channelId !== currentChannelId;
      const isTabHidden = document.hidden;
      if (isFromOtherUser && (isDifferentChannel || isTabHidden) && incomingSoundRef.current) {
        incomingSoundRef.current.currentTime = 0;
        incomingSoundRef.current.play().catch((err) => console.error('Incoming message sound failed:', err));
      }
    };
    const editHandler = (
      messageId: string,
      content: string,
      editedAt: string,
    ) => {
      updateMessage(messageId, content, editedAt);
    };
    const deleteHandler = (messageId: string) => {
      markDeleted(messageId);
    };
    const reactionAddedHandler = (reaction: Reaction) => {
      addReaction(reaction);
    };
    const reactionRemovedHandler = (
      messageId: string,
      userId: string,
      emoji: string,
    ) => {
      removeReaction(messageId, userId, emoji);
    };
    conn.on("ReceiveMessage", handler);
    conn.on("MessageEdited", editHandler);
    conn.on("MessageDeleted", deleteHandler);
    conn.on("ReactionAdded", reactionAddedHandler);
    conn.on("ReactionRemoved", reactionRemovedHandler);
    return () => {
      incomingSoundRef.current = null;
      conn.off("ReceiveMessage", handler);
      conn.off("MessageEdited", editHandler);
      conn.off("MessageDeleted", deleteHandler);
      conn.off("ReactionAdded", reactionAddedHandler);
      conn.off("ReactionRemoved", reactionRemovedHandler);
    };
  }, [addMessage, updateMessage, markDeleted, addReaction, removeReaction, currentUserId, currentChannelId]);

  // Scroll to bottom on channel switch (after messages load)
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const channelChanged = currentChannelId !== prevChannelRef.current;
    if (channelChanged) {
      prevChannelRef.current = currentChannelId;
    }
    // Scroll when messages finish loading for a channel switch
    const justFinishedLoading = prevLoadingRef.current && !loading;
    prevLoadingRef.current = loading;
    if (channelChanged || (justFinishedLoading && messages.length > 0)) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView();
      });
    }
  }, [currentChannelId, messages, loading]);

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

    if (newCount > prevCount) {
      const lastMessage = messages[newCount - 1];
      const isOwnMessage = !!currentUserId && lastMessage?.authorId === currentUserId;
      if (isOwnMessage) {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        });
        return;
      }
      if (prevCount > 0) {
        // New message arrived — scroll to bottom only if user is near the bottom
        const distanceFromBottom =
          list.scrollHeight - list.scrollTop - list.clientHeight;
        if (distanceFromBottom < 150) {
          requestAnimationFrame(() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          });
        }
      }
    }
  }, [messages, currentUserId]);

  const scrollToMessage = useCallback((id: string) => {
    const el = messageRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('message-highlight');
    setTimeout(() => el.classList.remove('message-highlight'), 1500);
  }, []);

  const handleScroll = () => {
    if (
      listRef.current &&
      listRef.current.scrollTop === 0 &&
      hasMore &&
      !loading
    ) {
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
      {messages.length == 0 ? (
        <div className="empty-channel-message">
          <p>ha ha empty channel</p>
        </div>
      ) : (
        <></>
      )}
      {messages.map((msg, i) => {
        const prev = messages[i - 1];
        const grouped =
          !!prev &&
          !prev.isDeleted &&
          !msg.replyTo &&
          prev.authorId === msg.authorId &&
          new Date(msg.createdAt).getTime() -
            new Date(prev.createdAt).getTime() <
            5 * 60 * 1000;
        return (
          <div key={msg.id} data-message-id={msg.id} ref={(el) => { if (el) messageRefs.current.set(msg.id, el); else messageRefs.current.delete(msg.id); }}>
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
  );
}
