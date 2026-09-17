import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { getApiBase, useAuthStore, useServerStore } from "@abyss/shared";
import type { Message } from "@abyss/shared";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import { groupReactions } from "../../utils/messageUtils";
import ReactionTooltip from "./ReactionTooltip";

const TOOLTIP_DELAY_MS = 250;

export interface MessageReactionsHandle {
  openPicker: () => void;
}

const MessageReactions = forwardRef<
  MessageReactionsHandle,
  {
    message: Message;
    canAddReactions: boolean;
    onToggleReaction: (emoji: string) => void;
    messageRef: React.RefObject<HTMLDivElement | null>;
  }
>(function MessageReactions({ message, canAddReactions, onToggleReaction, messageRef }, ref) {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties | null>(
    null,
  );
  const [hovered, setHovered] = useState<{
    emoji: string;
    anchor: DOMRect;
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const emojis = useServerStore((s) => s.emojis);

  useEffect(() => {
    if (!showPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPicker]);

  const updatePickerPosition = useCallback(() => {
    if (!showPicker || !pickerRef.current || !pickerAnchor) return;
    const rect = pickerRef.current.getBoundingClientRect();
    const margin = 8;
    let left = pickerAnchor.x - rect.width;
    let top = pickerAnchor.y;
    if (left < margin) left = margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    const aboveTop = pickerAnchor.y - rect.height - margin;
    const belowTop = pickerAnchor.y + margin;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + rect.height <= window.innerHeight - margin) {
      top = belowTop;
    } else {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPickerStyle((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [showPicker, pickerAnchor]);

  useLayoutEffect(() => {
    updatePickerPosition();
  }, [updatePickerPosition]);

  useEffect(() => {
    if (!showPicker || !pickerRef.current) return;
    const ro = new ResizeObserver(() => updatePickerPosition());
    ro.observe(pickerRef.current);
    window.addEventListener("resize", updatePickerPosition);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updatePickerPosition);
    };
  }, [showPicker, updatePickerPosition]);

  useImperativeHandle(ref, () => ({ openPicker }));

  const showTooltip = (emoji: string, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // Measure when the tooltip actually opens, not on mouseenter — the list may have
    // scrolled during the delay.
    hoverTimer.current = setTimeout(() => {
      if (!el.isConnected) return;
      setHovered({ emoji, anchor: el.getBoundingClientRect() });
    }, TOOLTIP_DELAY_MS);
  };

  const hideTooltip = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(null);
  }, []);

  // The tooltip is fixed-positioned off a rect captured on hover, so any scroll or
  // resize would leave it stranded — just dismiss it.
  useEffect(() => {
    if (!hovered) return;
    window.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);
    return () => {
      window.removeEventListener("scroll", hideTooltip, true);
      window.removeEventListener("resize", hideTooltip);
    };
  }, [hovered, hideTooltip]);

  useEffect(() => () => hideTooltip(), [hideTooltip]);

  const openPicker = (e?: React.MouseEvent<HTMLElement>) => {
    if (!canAddReactions) return;
    const target = e?.currentTarget as HTMLElement | null;
    const rect =
      target?.getBoundingClientRect() ??
      messageRef.current?.getBoundingClientRect();
    if (rect) {
      setPickerAnchor({ x: rect.right, y: rect.top });
    } else {
      setPickerAnchor({ x: 0, y: 0 });
    }
    setShowPicker(true);
  };

  const customEmojiCategory =
    emojis.length > 0
      ? [
          {
            id: "custom",
            name: "Server Emojis",
            emojis: emojis.map((e) => ({
              id: `custom-${e.id}`,
              name: e.name,
              keywords: [e.name],
              skins: [{ src: `${getApiBase()}${e.imageUrl}` }],
            })),
          },
        ]
      : [];

  const handleEmojiSelect = (emoji: { native?: string; id?: string }) => {
    if (!canAddReactions) return;
    if (emoji.native) {
      onToggleReaction(emoji.native);
    } else if (emoji.id?.startsWith("custom-")) {
      const emojiId = emoji.id.substring(7);
      onToggleReaction(`custom:${emojiId}`);
    }
    setShowPicker(false);
  };

  const reactionGroups = groupReactions(message);
  const hoveredGroup = hovered
    ? reactionGroups.find((g) => g.emoji === hovered.emoji)
    : undefined;

  return (
    <>
      {reactionGroups.length > 0 && (
        <div className="message-reactions">
          {reactionGroups.map((g) => (
            // The wrapper carries the hover handlers because the button is `disabled`
            // without the AddReactions permission, and disabled buttons swallow mouse
            // events — those users should still be able to see who reacted.
            <span
              key={g.emoji}
              className="reaction-pill-wrap"
              onMouseEnter={(e) => showTooltip(g.emoji, e.currentTarget)}
              onMouseLeave={hideTooltip}
            >
              <button
                className={`reaction-button${currentUser && g.userIds.includes(currentUser.id) ? " reacted" : ""}`}
                onClick={() => {
                  hideTooltip();
                  onToggleReaction(g.emoji);
                }}
                disabled={!canAddReactions}
              >
                <span className="reaction-emoji">
                  {g.emoji.startsWith("custom:")
                    ? (() => {
                        const eid = g.emoji.substring(7);
                        const ce = emojis.find((e) => e.id === eid);
                        return ce ? (
                          <img
                            src={`${getApiBase()}${ce.imageUrl}`}
                            alt={`:${ce.name}:`}
                            className="custom-emoji-reaction"
                          />
                        ) : (
                          "?"
                        );
                      })()
                    : g.emoji}
                </span>
                <span className="reaction-count">{g.count}</span>
              </button>
            </span>
          ))}
          {canAddReactions && (
            <button
              className="reaction-button reaction-add"
              onClick={(e) => openPicker(e)}
            >
              +
            </button>
          )}
        </div>
      )}
      {hovered && hoveredGroup && (
        <ReactionTooltip
          group={hoveredGroup}
          anchor={hovered.anchor}
          canAddReactions={canAddReactions}
        />
      )}
      {showPicker && (
        <div
          className="emoji-picker-container"
          ref={pickerRef}
          style={pickerStyle ? pickerStyle : { visibility: "hidden" }}
        >
          <Picker
            data={data}
            custom={customEmojiCategory}
            onEmojiSelect={handleEmojiSelect}
            theme="dark"
            previewPosition="none"
            skinTonePosition="none"
          />
        </div>
      )}
    </>
  );
});

export default MessageReactions;
export { groupReactions };
