import { useEffect, useRef, useState, useCallback } from "react";
import { useAuthStore, useMessageStore, getConnection } from "@abyss/shared";
import type { Message, Reaction, PinnedMessage } from "@abyss/shared";
import MessageItem from "./MessageItem";

export default function MessageList() {
  const { messages, loading, hasMore, hasNewer, loadMore, loadNewer } = useMessageStore();
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const highlightedMessageId = useMessageStore((s) => s.highlightedMessageId);
  const setHighlightedMessageId = useMessageStore((s) => s.setHighlightedMessageId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listInnerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [contextMenuMessageId, setContextMenuMessageId] = useState<
    string | null
  >(null);
  const prevChannelRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const isLoadingNewerRef = useRef(false);
  const suppressAutoScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const initialScrollDoneRef = useRef<string | null>(null);
  const incomingSoundRef = useRef<HTMLAudioElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const pendingInitialScrollRef = useRef(false);
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const addPinnedMessage = useMessageStore((s) => s.addPinnedMessage);
  const removePinnedMessage = useMessageStore((s) => s.removePinnedMessage);
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
    const pinHandler = (pinned: PinnedMessage) => {
      addPinnedMessage(pinned);
    };
    const unpinHandler = (channelId: string, messageId: string) => {
      removePinnedMessage(channelId, messageId);
    };
    conn.on("ReceiveMessage", handler);
    conn.on("MessageEdited", editHandler);
    conn.on("MessageDeleted", deleteHandler);
    conn.on("ReactionAdded", reactionAddedHandler);
    conn.on("ReactionRemoved", reactionRemovedHandler);
    conn.on("MessagePinned", pinHandler);
    conn.on("MessageUnpinned", unpinHandler);
    return () => {
      incomingSoundRef.current = null;
      conn.off("ReceiveMessage", handler);
      conn.off("MessageEdited", editHandler);
      conn.off("MessageDeleted", deleteHandler);
      conn.off("ReactionAdded", reactionAddedHandler);
      conn.off("ReactionRemoved", reactionRemovedHandler);
      conn.off("MessagePinned", pinHandler);
      conn.off("MessageUnpinned", unpinHandler);
    };
  }, [addMessage, updateMessage, markDeleted, addReaction, removeReaction, addPinnedMessage, removePinnedMessage, currentUserId, currentChannelId]);

  const updateScrollToBottomState = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 150;
    setShowScrollToBottom(distanceFromBottom > 150);
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollToBottom(false);
    suppressAutoScrollRef.current = false;
  }, []);

  // Scroll to bottom on channel switch (after messages load)
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const channelChanged = currentChannelId !== prevChannelRef.current;
    if (channelChanged) {
      prevChannelRef.current = currentChannelId;
      initialScrollDoneRef.current = null;
      pendingInitialScrollRef.current = true;
      suppressAutoScrollRef.current = false;
    }
    // Scroll when messages finish loading for a channel switch
    const justFinishedLoading = prevLoadingRef.current && !loading;
    prevLoadingRef.current = loading;
    if (suppressAutoScrollRef.current || highlightedMessageId) return;
    if (channelChanged || (justFinishedLoading && messages.length > 0)) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView();
        updateScrollToBottomState();
      });
    }
  }, [currentChannelId, messages, loading, updateScrollToBottomState, highlightedMessageId]);

  // Scroll to bottom on new messages (only if near bottom), preserve position on loadMore
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prevCount = prevMessageCountRef.current;
    const newCount = messages.length;
    prevMessageCountRef.current = newCount;

    if (isLoadingMoreRef.current || isLoadingNewerRef.current) {
      // Preserve scroll position after prepending older messages
      isLoadingMoreRef.current = false;
      return;
    }

    if (suppressAutoScrollRef.current || highlightedMessageId) return;

    if (!loading && messages.length > 0 && initialScrollDoneRef.current !== currentChannelId) {
      initialScrollDoneRef.current = currentChannelId ?? null;
      pendingInitialScrollRef.current = false;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView();
        updateScrollToBottomState();
      });
      return;
    }

    if (newCount === prevCount && isNearBottomRef.current) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
      });
      requestAnimationFrame(updateScrollToBottomState);
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
    requestAnimationFrame(updateScrollToBottomState);
  }, [messages, currentUserId, updateScrollToBottomState, highlightedMessageId]);

  useEffect(() => {
    const inner = listInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (highlightedMessageId) {
        const el = messageRefs.current.get(highlightedMessageId);
        if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' });
        return;
      }
      if (suppressAutoScrollRef.current) return;
      if (pendingInitialScrollRef.current && messages.length > 0 && !loading) {
        pendingInitialScrollRef.current = false;
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView();
          updateScrollToBottomState();
        });
        return;
      }
      if (isNearBottomRef.current) {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: "auto" });
          updateScrollToBottomState();
        });
      }
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [messages.length, loading, updateScrollToBottomState, highlightedMessageId]);

  const scrollToMessage = useCallback((id: string) => {
    const el = messageRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('message-highlight');
    setTimeout(() => el.classList.remove('message-highlight'), 1500);
  }, []);

  useEffect(() => {
    if (!highlightedMessageId) return;
    suppressAutoScrollRef.current = true;
    isNearBottomRef.current = false;
    setShowScrollToBottom(true);

    const tryScroll = () => {
      const el = messageRefs.current.get(highlightedMessageId);
      if (!el) {
        setTimeout(tryScroll, 100);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('message-highlight');
      setTimeout(() => {
        el.classList.remove('message-highlight');
        setHighlightedMessageId(null);
      }, 1500);
    };

    requestAnimationFrame(tryScroll);
  }, [highlightedMessageId, setHighlightedMessageId]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;

    const distanceFromBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight;

    if (suppressAutoScrollRef.current && distanceFromBottom < 50 && !hasNewer) {
      suppressAutoScrollRef.current = false;
    }

    if (distanceFromBottom < 150 && hasNewer && !loading && !isLoadingNewerRef.current && !highlightedMessageId) {
      isLoadingNewerRef.current = true;
      loadNewer().then(() => {
        requestAnimationFrame(() => {
          updateScrollToBottomState();
          isLoadingNewerRef.current = false;
        });
      });
      return;
    }

    if (list.scrollTop === 0 && hasMore && !loading) {
      const prevScrollHeight = list.scrollHeight;
      isLoadingMoreRef.current = true;
      loadMore().then(() => {
        // Restore scroll position after older messages are prepended
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight - prevScrollHeight;
          updateScrollToBottomState();
        });
      });
      return;
    }

    updateScrollToBottomState();
  };

  return (
    <div className="message-list" ref={listRef} onScroll={handleScroll}>
      {showScrollToBottom && (
        <div className="scroll-to-bottom-banner">
          <button type="button" onClick={scrollToBottom}>
            You’re viewing earlier messages — jump to latest
          </button>
        </div>
      )}
      <div className="message-list-inner" ref={listInnerRef}>
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
            !msg.isSystem &&
            !prev.isSystem &&
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
    </div>
  );
}
