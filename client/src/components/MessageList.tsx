import {
  useEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
  useLayoutEffect,
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
import {
  Virtuoso,
  type VirtuosoHandle,
  type ItemProps,
  type ListRange,
} from "react-virtuoso";

const START_INDEX = 1_000_000;
const TOP_PRELOAD_ITEM_THRESHOLD = 24;

// Flex container prevents child margins from collapsing out of the wrapper,
// which ensures Virtuoso's offsetHeight measurements include the full visual
// space for per-message cosmetic shells.
const VirtuosoItem = ({ children, ...props }: ItemProps<MessageRow>) => (
  <div {...props} style={{ display: "flex", flexDirection: "column" }}>
    {children}
  </div>
);

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
  const scrollerRef = useRef<HTMLElement | null>(null);
  const incomingSoundRef = useRef<HTMLAudioElement | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [hoveredGroup, setHoveredGroup] = useState<{
    key: string;
    height: number;
  } | null>(null);
  const isAtBottomRef = useRef(true);
  const prevChannelRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const isLoadingNewerRef = useRef(false);
  const prevLastMsgIdRef = useRef<string | null>(null);


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

  // ── Map message ID → row index (for scrollToIndex) ────────────────────
  const msgIdToRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.msg.id, i));
    return map;
  }, [rows]);

  // Apply prepend math in the same render that receives the older page.
  // Virtuoso uses firstItemIndex to preserve the viewport anchor, so
  // delaying the correction until after paint causes visible jumps.
  const effectiveFirstItemIndex = firstItemIndex - lastPrependCount;

  // ── Commit prepend bookkeeping before paint ────────────────────────────
  useLayoutEffect(() => {
    if (lastPrependCount <= 0) return;

    useMessageStore.setState({ lastPrependCount: 0 });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFirstItemIndex((current) => current - lastPrependCount);
  }, [lastPrependCount]);

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

  // ── Auto-scroll on new messages ──────────────────────────────────────
  // Scrolls to the bottom when a new message arrives and the user is
  // already near the bottom, or when the user sends their own message.
  // Uses the raw DOM scroller instead of Virtuoso's scrollToIndex because
  // the latter can undershoot when items haven't been measured yet.
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
      // Scroll the raw DOM element to the bottom after Virtuoso renders the new content.
      // We use the DOM element directly because Virtuoso's scrollToIndex can undershoot
      // when it hasn't measured new/resized items yet. Two passes ensure we catch both
      // new groups (rendered quickly) and merged groups (re-measured after layout).
      const scrollToEnd = () => {
        const el = scrollerRef.current;
        if (el) {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }
      };
      setTimeout(scrollToEnd, 50);
      setTimeout(scrollToEnd, 150);
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
      prevLastMsgIdRef.current = messages[messages.length - 1]?.id ?? null;
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
      const rowIdx = msgIdToRowIndex.get(highlightedMessageId);
      if (rowIdx === undefined) {
        if (attempts < 20) setTimeout(() => tryScroll(attempts + 1), 100);
        return;
      }

      virtuosoRef.current?.scrollToIndex({
        index: rowIdx,
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
  }, [highlightedMessageId, setHighlightedMessageId, msgIdToRowIndex]);

  // ── Virtuoso callbacks ────────────────────────────────────────────────
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const handleRangeChanged = useCallback((range: ListRange) => {
    const distanceFromTop = range.startIndex - effectiveFirstItemIndex;
    if (
      distanceFromTop > TOP_PRELOAD_ITEM_THRESHOLD ||
      isLoadingRef.current ||
      !hasMore
    ) {
      return;
    }

    isLoadingRef.current = true;
    loadMore().finally(() => {
      isLoadingRef.current = false;
    });
  }, [effectiveFirstItemIndex, hasMore, loadMore]);

  // Disabled — we handle all auto-scrolling via the manual useEffect above
  // using the raw DOM scroller, which is more reliable than Virtuoso's
  // followOutput (which can undershoot on unmeasured items).
  const followOutput = useCallback(
    (): false | "smooth" | "auto" => false,
    [],
  );

  const handleEndReached = useCallback(() => {
    if (isLoadingNewerRef.current || !hasNewer) return;
    isLoadingNewerRef.current = true;
    loadNewer().finally(() => {
      isLoadingNewerRef.current = false;
    });
  }, [hasNewer, loadNewer]);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
    setShowScrollToBottom(false);
  }, []);

  const scrollToMessage = useCallback(
    (id: string) => {
      const rowIdx = msgIdToRowIndex.get(id);
      if (rowIdx === undefined) return;
      virtuosoRef.current?.scrollToIndex({
        index: rowIdx,
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
    [msgIdToRowIndex],
  );

  const handleRowMouseEnter = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    groupKey: string,
  ) => {
    const scroller = scrollerRef.current;
    const hoveredRow = event.currentTarget;
    const groupRows = scroller?.querySelectorAll<HTMLElement>(
      `[data-hover-group-key="${groupKey}"]`,
    );
    const measuredHeight = groupRows
      ? Array.from(groupRows).reduce((total, row) => total + row.offsetHeight, 0)
      : hoveredRow.offsetHeight;

    setHoveredGroup((current) => {
      if (current?.key === groupKey && current.height === measuredHeight) {
        return current;
      }

      return {
        key: groupKey,
        height: measuredHeight,
      };
    });
  }, []);

  const handleRowMouseLeave = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    groupKey: string,
  ) => {
    const nextTarget = event.relatedTarget as HTMLElement | null;
    if (nextTarget?.closest(`[data-hover-group-key="${groupKey}"]`)) {
      return;
    }

    setHoveredGroup((current) => (
      current?.key === groupKey ? null : current
    ));
  }, []);

  // ── Row renderer ───────────────────────────────────────────────────────
  const renderRow = useCallback(
    (_index: number, row: MessageRow) => {
      const isGroupHovered = hoveredGroup?.key === row.hoverGroupKey;
      const shellStyle = getCosmeticShellStyle(
        row.cosmeticStyle,
        row.segmentPosition,
      );
      const groupOverlayStyle =
        isGroupHovered && row.segmentPosition === "start"
          ? getCosmeticGroupOverlayStyle(
              row.cosmeticStyle,
              hoveredGroup?.height ?? 0,
            )
          : undefined;

      return (
        <div
          className={`message-row message-row-${row.segmentPosition}${row.cosmeticStyle ? " message-cosmetic-group message-cosmetic-row" : ""}${isGroupHovered ? " message-group-hovered" : ""}`}
          data-hover-group-key={row.hoverGroupKey}
          data-segment-position={row.segmentPosition}
          style={shellStyle}
          onMouseEnter={(event) => handleRowMouseEnter(event, row.hoverGroupKey)}
          onMouseLeave={(event) => handleRowMouseLeave(event, row.hoverGroupKey)}
        >
          {groupOverlayStyle && (
            <div className="message-cosmetic-group-overlay" style={groupOverlayStyle} />
          )}
          <div className="message-row-content" data-message-id={row.msg.id}>
            <MessageItem
              message={row.msg}
              grouped={row.grouped}
              onScrollToMessage={scrollToMessage}
              forceHovered={isGroupHovered}
            />
          </div>
        </div>
      );
    },
    [
      handleRowMouseEnter,
      handleRowMouseLeave,
      hoveredGroup,
      scrollToMessage,
    ],
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
        scrollerRef={(el) => { scrollerRef.current = el as HTMLElement | null; }}
        style={{ height: "100%", width: "100%" }}
        components={{ Item: VirtuosoItem }}
        data={rows}
        firstItemIndex={effectiveFirstItemIndex}
        initialTopMostItemIndex={rows.length - 1}
        computeItemKey={(_index, row) => row.key}
        increaseViewportBy={{ top: 400, bottom: 400 }}
        followOutput={followOutput}
        endReached={handleEndReached}
        atBottomStateChange={handleAtBottomChange}
        rangeChanged={handleRangeChanged}
        itemContent={renderRow}
        atBottomThreshold={400}
      />
    </div>
  );
}
