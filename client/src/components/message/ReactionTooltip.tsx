import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getApiBase, useServerStore } from "@abyss/shared";
import type { CustomEmoji, ReactionGroup } from "@abyss/shared";
import { formatReactorNames, reactorName } from "../../utils/reactionUtils";

/**
 * Fixed-position tooltip naming the reactors of a single reaction pill.
 *
 * Deliberately not the CSS-only `.emoji-tooltip` pattern used for inline custom emoji —
 * that one is absolutely positioned inside the message row and gets clipped by the
 * message-list scroll container. This follows the emoji picker / context menu approach:
 * fixed positioning off the anchor rect, clamped to the viewport.
 */
export default function ReactionTooltip({
  group,
  anchor,
  canAddReactions,
}: {
  group: ReactionGroup;
  anchor: DOMRect;
  canAddReactions: boolean;
}) {
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  // Measure once mounted, then clamp to the viewport — same approach as the emoji
  // picker in MessageReactions.tsx.
  const updatePosition = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = anchor.left + anchor.width / 2 - rect.width / 2;
    if (left < margin) left = margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    const above = anchor.top - rect.height - margin;
    const top = above >= margin ? above : anchor.bottom + margin;
    setStyle((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [anchor]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  const names = group.reactors.map((r) => reactorName(r, members));
  const customEmoji: CustomEmoji | undefined = group.emoji.startsWith("custom:")
    ? emojis.find((e) => e.id === group.emoji.substring(7))
    : undefined;

  return createPortal(
    <div
      className="reaction-tooltip"
      ref={ref}
      style={style ?? { left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="reaction-tooltip-line">
        <span className="reaction-tooltip-names">{formatReactorNames(names)}</span>
        <span className="reaction-tooltip-suffix"> reacted with </span>
        {group.emoji.startsWith("custom:") ? (
          customEmoji ? (
            <>
              <img
                src={`${getApiBase()}${customEmoji.imageUrl}`}
                alt={`:${customEmoji.name}:`}
                className="reaction-tooltip-emoji-img"
              />
              <span className="reaction-tooltip-emoji-name">:{customEmoji.name}:</span>
            </>
          ) : (
            <span className="reaction-tooltip-emoji">?</span>
          )
        ) : (
          <span className="reaction-tooltip-emoji">{group.emoji}</span>
        )}
      </div>
      {!canAddReactions && (
        <div className="reaction-tooltip-hint">No permission to add reactions</div>
      )}
    </div>,
    document.body,
  );
}
