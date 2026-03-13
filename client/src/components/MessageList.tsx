import {
  useEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
} from "react";
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

const AT_BOTTOM_THRESHOLD = 50;

type MessageSegmentPosition = "single" | "start" | "middle" | "end";
const DEFAULT_COSMETIC_BORDER_RADIUS = "4px";

interface MessageRow {
  key: string;
  msg: Message;
  grouped: boolean;
  cosmeticStyle?: React.CSSProperties;
  segmentPosition: MessageSegmentPosition;
  hoverGroupKey: string;
}

function shouldGroupWithPrevious(prev: Message | undefined, msg: Message): boolean {
  return (
    !!prev &&
    !msg.isSystem &&
    !prev.isSystem &&
    !prev.isDeleted &&
    !msg.replyTo &&
    prev.authorId === msg.authorId &&
    new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() <
      5 * 60 * 1000
  );
}

function getSegmentPosition(isStart: boolean, isEnd: boolean): MessageSegmentPosition {
  if (isStart && isEnd) return "single";
  if (isStart) return "start";
  if (isEnd) return "end";
  return "middle";
}

function splitBorderRadius(borderRadius: string, position: MessageSegmentPosition): string {
  const normalized = borderRadius.trim().split(/\s+/);
  const [tl, tr = tl, br = tl, bl = tr] =
    normalized.length === 1
      ? [normalized[0], normalized[0], normalized[0], normalized[0]]
      : normalized.length === 2
        ? [normalized[0], normalized[1], normalized[0], normalized[1]]
        : normalized.length === 3
          ? [normalized[0], normalized[1], normalized[2], normalized[1]]
          : [normalized[0], normalized[1], normalized[2], normalized[3]];

  switch (position) {
    case "single":
      return `${tl} ${tr} ${br} ${bl}`;
    case "start":
      return `${tl} ${tr} 0 0`;
    case "middle":
      return "0";
    case "end":
      return `0 0 ${br} ${bl}`;
  }
}

function normalizeBorderRadius(
  borderRadius: React.CSSProperties["borderRadius"],
): string {
  if (typeof borderRadius === "number") return `${borderRadius}px`;
  if (typeof borderRadius === "string" && borderRadius.trim().length > 0) {
    return borderRadius;
  }
  return DEFAULT_COSMETIC_BORDER_RADIUS;
}

function getCosmeticShellStyle(
  style: React.CSSProperties | undefined,
  position: MessageSegmentPosition,
): React.CSSProperties | undefined {
  if (!style) return undefined;

  const shellStyle: React.CSSProperties = {
    ...style,
    animationPlayState: "paused",
  };

  if (style.border) {
    const borderValue = style.border;
    delete shellStyle.border;
    shellStyle.borderLeft = style.borderLeft ?? borderValue;
    shellStyle.borderRight = style.borderRight ?? borderValue;
    shellStyle.borderTop =
      position === "single" || position === "start"
        ? (style.borderTop ?? borderValue)
        : "0";
    shellStyle.borderBottom =
      position === "single" || position === "end"
        ? (style.borderBottom ?? borderValue)
        : "0";
  } else if (position !== "single") {
    shellStyle.borderTop = position === "start" ? shellStyle.borderTop : "0";
    shellStyle.borderBottom = position === "end" ? shellStyle.borderBottom : "0";
  }

  if (position !== "single") {
    // boxShadow/outline span the full group via the overlay
    delete shellStyle.boxShadow;
    delete shellStyle.outline;
    delete shellStyle.outlineOffset;
  }

  shellStyle.borderRadius = splitBorderRadius(
    normalizeBorderRadius(style.borderRadius),
    position,
  );

  return shellStyle;
}

function getCosmeticGroupOverlayStyle(
  style: React.CSSProperties | undefined,
  height: number,
): React.CSSProperties | undefined {
  if (!style || !style.animation || height <= 0) return undefined;

  // Overlay only handles full-group effects (boxShadow, outline) — borders are per-row
  const {
    border: _b, borderLeft: _bl, borderRight: _br, borderTop: _bt,
    borderBottom: _bb, borderImage: _bi,
    ...rest
  } = style;

  return {
    ...rest,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height,
    pointerEvents: "none",
    zIndex: 0,
    animationPlayState: "running",
    borderRadius: normalizeBorderRadius(style.borderRadius),
  };
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
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const markDeleted = useMessageStore((s) => s.markDeleted);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const addPinnedMessage = useMessageStore((s) => s.addPinnedMessage);
  const removePinnedMessage = useMessageStore((s) => s.removePinnedMessage);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const incomingSoundRef = useRef<HTMLAudioElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hoveredGroupRef = useRef<string | null>(null);
  const isAtBottomRef = useRef(true);
  const isLoadingRef = useRef(false);
  const isLoadingNewerRef = useRef(false);

  // ── Compute rows ───────────────────────────────────────────────────────
  const rows = useMemo<MessageRow[]>(() => {
    const result: MessageRow[] = [];
    let currentHoverGroupKey = "";
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const grouped = shouldGroupWithPrevious(prev, msg);
      const nextGrouped = next ? shouldGroupWithPrevious(msg, next) : false;
      const isStart = !grouped;
      const isEnd = !nextGrouped;

      if (isStart) {
        currentHoverGroupKey = msg.id;
      }

      result.push({
        key: msg.id,
        msg,
        grouped,
        cosmeticStyle: getMessageStyle(msg.author),
        segmentPosition: getSegmentPosition(isStart, isEnd),
        hoverGroupKey: currentHoverGroupKey,
      });
    }
    return result;
  }, [messages]);

  // ── Scroll helpers ────────────────────────────────────────────────────
  // In a column-reverse container, scrollTop=0 is the bottom (newest messages).
  // scrollTop increases as you scroll up toward older messages.
  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (el) {
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
    setShowScrollToBottom(false);
  }, []);

  // ── Track scroll position for "at bottom" detection ───────────────────
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollTop <= AT_BOTTOM_THRESHOLD;
      isAtBottomRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [currentChannelId]);

  // ── Load older messages (top sentinel) ────────────────────────────────
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || isLoadingRef.current || !hasMore) return;
        isLoadingRef.current = true;
        loadMore().finally(() => {
          isLoadingRef.current = false;
        });
      },
      { root: scroller, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, currentChannelId]);

  // ── Load newer messages (bottom sentinel, for /around/ jumps) ─────────
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || isLoadingNewerRef.current || !hasNewer) return;
        isLoadingNewerRef.current = true;
        loadNewer().finally(() => {
          isLoadingNewerRef.current = false;
        });
      },
      { root: scroller, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNewer, loadNewer, currentChannelId]);

  // ── SignalR handlers ──────────────────────────────────────────────────
  useEffect(() => {
    incomingSoundRef.current = new Audio(`${import.meta.env.BASE_URL}sounds/new-message.ogg`);
    incomingSoundRef.current.preload = "auto";
    const conn = getConnection();
    const handler = async (message: Message) => {
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

  // ── Auto-scroll on new messages ──────────────────────────────────────
  // In column-reverse, scrollTop=0 is the bottom. When the user is at
  // the bottom, new messages naturally appear without scroll adjustment.
  // We only need to nudge scroll for the user's own messages when they've
  // scrolled up slightly.
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (messages.length <= prevCount) return;
    if (highlightedMessageId) return;

    const lastMsg = messages[messages.length - 1];
    const isOwn = lastMsg?.authorId === currentUserId;
    if (isOwn || isAtBottomRef.current) {
      // Own messages: always scroll to bottom (even if scrolled up)
      // Others' messages: scroll to bottom only if user is near the bottom
      scrollerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [messages, currentUserId, highlightedMessageId]);

  // ── Reset on channel switch ───────────────────────────────────────────
  useEffect(() => {
    setShowScrollToBottom(false);
    isAtBottomRef.current = true;
    isLoadingRef.current = false;
    isLoadingNewerRef.current = false;
    // column-reverse: scrollTop=0 is the bottom, which is the default
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = 0;
    }
  }, [currentChannelId]);

  // ── Highlighted message scroll ────────────────────────────────────────
  useEffect(() => {
    if (!highlightedMessageId) return;

    const tryScroll = (attempts = 0) => {
      const el = document.querySelector(
        `[data-message-id="${highlightedMessageId}"]`,
      );
      if (!el) {
        if (attempts < 20) setTimeout(() => tryScroll(attempts + 1), 100);
        return;
      }

      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setShowScrollToBottom(true);

      // Apply highlight class after scroll settles
      setTimeout(() => {
        el.classList.add("message-highlight");
        setTimeout(() => {
          el.classList.remove("message-highlight");
          setHighlightedMessageId(null);
        }, 1500);
      }, 300);
    };

    requestAnimationFrame(() => tryScroll());
  }, [highlightedMessageId, setHighlightedMessageId]);

  // ── Imperative hover management (no React state, no re-renders) ──────
  const clearHoveredGroup = useCallback(() => {
    const prev = hoveredGroupRef.current;
    if (!prev) return;
    hoveredGroupRef.current = null;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rows = scroller.querySelectorAll<HTMLElement>(
      `[data-hover-group-key="${prev}"]`,
    );
    rows.forEach((row) => row.classList.remove("message-group-hovered"));
  }, []);

  const handleRowMouseEnter = useCallback((
    _event: React.MouseEvent<HTMLDivElement>,
    groupKey: string,
  ) => {
    if (hoveredGroupRef.current === groupKey) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // Clear previous group
    clearHoveredGroup();

    hoveredGroupRef.current = groupKey;
    const groupRows = scroller.querySelectorAll<HTMLElement>(
      `[data-hover-group-key="${groupKey}"]`,
    );
    let totalHeight = 0;
    groupRows.forEach((row) => {
      row.classList.add("message-group-hovered");
      totalHeight += row.offsetHeight;
    });

    // Set overlay height via CSS variable on the start/single row
    const startRow = scroller.querySelector<HTMLElement>(
      `[data-hover-group-key="${groupKey}"][data-segment-position="start"], [data-hover-group-key="${groupKey}"][data-segment-position="single"]`,
    );
    if (startRow) {
      startRow.style.setProperty("--cosmetic-group-height", `${totalHeight}px`);
    }
  }, [clearHoveredGroup]);

  const handleRowMouseLeave = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    groupKey: string,
  ) => {
    const nextTarget = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    if (nextTarget?.closest(`[data-hover-group-key="${groupKey}"]`)) {
      return;
    }
    if (hoveredGroupRef.current === groupKey) {
      clearHoveredGroup();
    }
  }, [clearHoveredGroup]);

  // ── Scroll to message (for reply clicks) ──────────────────────────────
  const scrollToMessage = useCallback((id: string) => {
    const el = document.querySelector(`[data-message-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      el.classList.add("message-highlight");
      setTimeout(() => el.classList.remove("message-highlight"), 1500);
    }, 300);
  }, []);

  // ── Row renderer ───────────────────────────────────────────────────────
  const renderRow = useCallback(
    (row: MessageRow) => {
      const shellStyle = getCosmeticShellStyle(
        row.cosmeticStyle,
        row.segmentPosition,
      );

      const hasOverlaySlot =
        (row.segmentPosition === "start" || row.segmentPosition === "single") &&
        row.cosmeticStyle?.animation;
      const overlayBaseStyle = hasOverlaySlot
        ? getCosmeticGroupOverlayStyle(row.cosmeticStyle, 1)
        : undefined;

      return (
        <div
          key={row.key}
          className={`message-row message-row-${row.segmentPosition}${row.cosmeticStyle ? " message-cosmetic-group message-cosmetic-row" : ""}`}
          data-hover-group-key={row.hoverGroupKey}
          data-segment-position={row.segmentPosition}
          style={shellStyle}
          onMouseEnter={(event) => handleRowMouseEnter(event, row.hoverGroupKey)}
          onMouseLeave={(event) => handleRowMouseLeave(event, row.hoverGroupKey)}
        >
          {overlayBaseStyle && (
            <div
              className="message-cosmetic-group-overlay"
              style={{ ...overlayBaseStyle, height: "var(--cosmetic-group-height, 0px)" }}
            />
          )}
          <div className="message-row-content" data-message-id={row.msg.id}>
            <MessageItem
              message={row.msg}
              grouped={row.grouped}
              onScrollToMessage={scrollToMessage}
            />
          </div>
        </div>
      );
    },
    [handleRowMouseEnter, handleRowMouseLeave, scrollToMessage],
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
      <div
        key={currentChannelId}
        ref={scrollerRef}
        className="message-scroller"
      >
        <div className="message-scroller-content">
          {hasMore && <div ref={topSentinelRef} className="load-more-sentinel" />}
          {loading && <div className="loading">Loading older messages...</div>}
          {rows.map(renderRow)}
          {hasNewer && <div ref={bottomSentinelRef} className="load-newer-sentinel" />}
        </div>
      </div>
    </div>
  );
}
