import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import {
  useAuthStore,
  useMessageStore,
  getConnection,
  useDmStore,
  useServerStore,
  getMessageStyle,
} from "@abyss/shared";
import { showDesktopNotification, isElectron } from "@abyss/shared/services/electronNotifications";
import type { Message, Reaction, PinnedMessage } from "@abyss/shared";
import MessageItem from "./MessageItem";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

const START_INDEX = 1_000_000;

interface MessageGroup {
  key: string;
  msgs: { msg: Message; grouped: boolean }[];
  cosmeticStyle?: React.CSSProperties;
}

export default function MessageList() {
  const { messages, loading, hasMore, loadMore } = useMessageStore();
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const hasNewer = useMessageStore((s) => s.hasNewer);
  const loadNewer = useMessageStore((s) => s.loadNewer);
  const highlightedMessageId = useMessageStore((s) => s.highlightedMessageId);
  const setHighlightedMessageId = useMessageStore(
    (s) => s.setHighlightedMessageId,
  );
  const lastPrependCount = useMessageStore((s) => s.lastPrependCount);
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const addPinnedMessage = useMessageStore((s) => s.addPinnedMessage);
  const removePinnedMessage = useMessageStore((s) => s.removePinnedMessage);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const incomingSoundRef = useRef<HTMLAudioElement | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isAtBottomRef = useRef(true);
  const prevChannelRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const isLoadingNewerRef = useRef(false);
  const prevLastMsgIdRef = useRef<string | null>(null);

  // ── Compute groups (same logic as old IIFE) ───────────────────────────
  const groups = useMemo<MessageGroup[]>(() => {
    const result: MessageGroup[] = [];
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
        new Date(msg.createdAt).getTime() -
          new Date(prev.createdAt).getTime() <
          5 * 60 * 1000;
      if (grouped && result.length > 0) {
        result[result.length - 1].msgs.push({ msg, grouped: true });
      } else {
        result.push({
          key: msg.id,
          msgs: [{ msg, grouped: false }],
          cosmeticStyle: getMessageStyle(msg.author),
        });
      }
    }
    return result;
  }, [messages]);

  // ── Map message ID → group index (for scrollToIndex) ──────────────────
  const msgIdToGroupIndex = useMemo(() => {
    const map = new Map<string, number>();
    groups.forEach((g, i) => {
      g.msgs.forEach(({ msg }) => map.set(msg.id, i));
    });
    return map;
  }, [groups]);

  // ── SignalR handlers (unchanged) ──────────────────────────────────────
  useEffect(() => {
    console.log(`[MessageList] effect MOUNT — registering handlers (channelId=${currentChannelId})`);
    incomingSoundRef.current = new Audio(`${import.meta.env.BASE_URL}sounds/new-message.ogg`);
    incomingSoundRef.current.preload = "auto";
    const conn = getConnection();
    const handler = async (message: Message) => {
      console.log(`[MessageList] ReceiveMessage handler fired — msgId=${message.id} channelId=${message.channelId} currentChannel=${currentChannelId}`);
      addMessage(message);
      const isFromOtherUser =
        message.authorId && message.authorId !== currentUserId;
      const isDifferentChannel = message.channelId !== currentChannelId;
      const isTabHidden = document.hidden;
      const isWindowHidden = isElectron()
        ? !(await window.electron!.isFocused())
        : isTabHidden;

      if (isFromOtherUser && (isDifferentChannel || isWindowHidden)) {
        if (incomingSoundRef.current) {
          incomingSoundRef.current.currentTime = 0;
          incomingSoundRef.current
            .play()
            .catch((err) =>
              console.error("Incoming message sound failed:", err),
            );
        }

        const isDmMode = useDmStore.getState().isDmMode;
        const activeServer = useServerStore.getState().activeServer;
        const isDm = (!activeServer || isDmMode) && (isDifferentChannel || isWindowHidden);

        if (isDm) {
          const senderName =
            message.author.displayName || message.author.username;
          const preview =
            message.content.length > 100
              ? message.content.substring(0, 100) + "..."
              : message.content;

          await showDesktopNotification(
            `${senderName} sent you a message`,
            preview,
            { channelId: message.channelId, messageId: message.id },
          );
        }
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
      console.log(`[MessageList] effect CLEANUP — deregistering handlers (channelId=${currentChannelId})`);
      incomingSoundRef.current = null;
      conn.off("ReceiveMessage", handler);
      conn.off("MessageEdited", editHandler);
      conn.off("MessageDeleted", deleteHandler);
      conn.off("ReactionAdded", reactionAddedHandler);
      conn.off("ReactionRemoved", reactionRemovedHandler);
      conn.off("MessagePinned", pinHandler);
      conn.off("MessageUnpinned", unpinHandler);
    };
  }, [
    addMessage,
    updateMessage,
    markDeleted,
    addReaction,
    removeReaction,
    addPinnedMessage,
    removePinnedMessage,
    currentUserId,
    currentChannelId,
  ]);

  // ── firstItemIndex adjustment when older messages are prepended ────────
  useEffect(() => {
    if (lastPrependCount > 0) {
      // Messages were prepended — find how many new groups were created.
      // The first "old" message is now at index lastPrependCount in the
      // messages array. Find which group it belongs to; all groups before
      // that are new.
      const oldFirstMsgId = messages[lastPrependCount]?.id;
      if (oldFirstMsgId) {
        const oldFirstGroupIdx = groups.findIndex((g) =>
          g.msgs.some((m) => m.msg.id === oldFirstMsgId),
        );
        if (oldFirstGroupIdx > 0) {
          setFirstItemIndex((prev) => prev - oldFirstGroupIdx);
        }
      }
      useMessageStore.setState({ lastPrependCount: 0 });
    }
  }, [lastPrependCount, messages, groups]);

  // ── Manual scroll for grouped messages ────────────────────────────────
  // followOutput only fires when groups.length grows. When a new message
  // merges into the last group, Virtuoso doesn't detect new output, so we
  // need to scroll manually.
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const lastMsgId = lastMsg?.id ?? null;
    const prevId = prevLastMsgIdRef.current;
    prevLastMsgIdRef.current = lastMsgId;

    // Only react to new messages appended at the end
    if (!lastMsgId || lastMsgId === prevId) return;
    // Skip on first mount / channel switch (prevId is null)
    if (!prevId) return;
    if (highlightedMessageId) return;

    if (isAtBottomRef.current || lastMsg.authorId === currentUserId) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "end",
          behavior: "smooth",
        });
      });
    }
  }, [messages, currentUserId, highlightedMessageId]);

  // ── Reset on channel switch ───────────────────────────────────────────
  useEffect(() => {
    if (currentChannelId !== prevChannelRef.current) {
      prevChannelRef.current = currentChannelId;
      setFirstItemIndex(START_INDEX);
      setShowScrollToBottom(false);
      isAtBottomRef.current = true;
      isLoadingRef.current = false;
      isLoadingNewerRef.current = false;
      prevLastMsgIdRef.current = null;
      // After Virtuoso remounts (via key prop), nudge scroll to sync internal isAtBottom state
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          behavior: "auto",
        });
      }, 50);
    }
  }, [currentChannelId]);

  // ── Reset firstItemIndex on /around/ jump (search/pin click) ──────────
  // Only reset when highlightedMessageId is newly set (null → value),
  // not on subsequent messages changes while the highlight is still active
  // (e.g. loadMore prepending during the 1.5s highlight window).
  const prevHighlightRef = useRef<string | null>(null);
  useEffect(() => {
    const justSet = !!highlightedMessageId && !prevHighlightRef.current;
    prevHighlightRef.current = highlightedMessageId;
    if (justSet) {
      setFirstItemIndex(START_INDEX);
    }
  }, [highlightedMessageId]);

  // ── Highlighted message scroll ────────────────────────────────────────
  useEffect(() => {
    if (!highlightedMessageId) return;

    const tryScroll = (attempts = 0) => {
      const groupIdx = msgIdToGroupIndex.get(highlightedMessageId);
      if (groupIdx === undefined) {
        if (attempts < 20) setTimeout(() => tryScroll(attempts + 1), 100);
        return;
      }

      virtuosoRef.current?.scrollToIndex({
        index: groupIdx,
        align: "center",
        behavior: "smooth",
      });

      setShowScrollToBottom(true);

      // Apply highlight class after scroll settles
      setTimeout(() => {
        const el = document.querySelector(
          `[data-message-id="${highlightedMessageId}"]`,
        );
        if (el) {
          el.classList.add("message-highlight");
          setTimeout(() => {
            el.classList.remove("message-highlight");
            setHighlightedMessageId(null);
          }, 1500);
        } else {
          setHighlightedMessageId(null);
        }
      }, 300);
    };

    requestAnimationFrame(() => tryScroll());
  }, [highlightedMessageId, setHighlightedMessageId, msgIdToGroupIndex]);

  // ── Virtuoso callbacks ────────────────────────────────────────────────
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const followOutput = useCallback(
    (isAtBottom: boolean): false | "smooth" | "auto" => {
      if (highlightedMessageId) return false;
      if (isAtBottom) return "smooth";
      // Auto-scroll for own messages even when not at bottom
      const msgs = useMessageStore.getState().messages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.authorId === currentUserId) return "smooth";
      return false;
    },
    [highlightedMessageId, currentUserId],
  );

  const handleStartReached = useCallback(() => {
    if (isLoadingRef.current || !hasMore) return;
    isLoadingRef.current = true;
    loadMore().finally(() => {
      isLoadingRef.current = false;
    });
  }, [hasMore, loadMore]);

  const handleEndReached = useCallback(() => {
    if (isLoadingNewerRef.current || !hasNewer) return;
    isLoadingNewerRef.current = true;
    loadNewer().finally(() => {
      isLoadingNewerRef.current = false;
    });
  }, [hasNewer, loadNewer]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "smooth",
    });
    setShowScrollToBottom(false);
  }, []);

  const scrollToMessage = useCallback(
    (id: string) => {
      const groupIdx = msgIdToGroupIndex.get(id);
      if (groupIdx === undefined) return;
      virtuosoRef.current?.scrollToIndex({
        index: groupIdx,
        align: "center",
        behavior: "smooth",
      });
      setTimeout(() => {
        const el = document.querySelector(`[data-message-id="${id}"]`);
        if (el) {
          el.classList.add("message-highlight");
          setTimeout(() => el.classList.remove("message-highlight"), 1500);
        }
      }, 300);
    },
    [msgIdToGroupIndex],
  );

  // ── Group renderer (matches old rendering exactly) ────────────────────
  const renderGroup = useCallback(
    (_index: number, group: MessageGroup) => {
      const groupStyle = group.cosmeticStyle
        ? {
            ...group.cosmeticStyle,
            animationPlayState: "paused" as const,
          }
        : undefined;

      return (
        <div
          className={`message-group${group.cosmeticStyle ? " message-cosmetic-group" : ""}`}
          style={groupStyle}
        >
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
      );
    },
    [scrollToMessage],
  );

  // ── Render ────────────────────────────────────────────────────────────
  if (loading && messages.length === 0) {
    return (
      <div className="message-list">
        <div className="loading">Loading messages...</div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="message-list">
        <div className="empty-channel-message">
          <p>ha ha empty channel</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list">
      {showScrollToBottom && (
        <div className="scroll-to-bottom-banner">
          <button type="button" onClick={scrollToBottom}>
            You're viewing earlier messages — jump to latest
          </button>
        </div>
      )}
      <Virtuoso
        key={currentChannelId}
        ref={virtuosoRef}
        style={{ height: "100%", width: "100%" }}
        data={groups}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={groups.length - 1}
        computeItemKey={(_index, group) => group.key}
        increaseViewportBy={{ top: 400, bottom: 400 }}
        followOutput={followOutput}
        startReached={handleStartReached}
        endReached={handleEndReached}
        atBottomStateChange={handleAtBottomChange}
        itemContent={renderGroup}
        atBottomThreshold={400}
      />
    </div>
  );
}
