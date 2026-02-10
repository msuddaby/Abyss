import { useRef, useEffect, useLayoutEffect, useState } from "react";

export default function MessageContextMenu({
  position,
  isOwn,
  editing,
  canDelete,
  canPin,
  isPinned,
  canAddReactions,
  canKickAuthor,
  canBanAuthor,
  onReply,
  onOpenPicker,
  onPinToggle,
  onEdit,
  onDelete,
  onKick,
  onBan,
  onClose,
}: {
  position: { x: number; y: number };
  isOwn: boolean;
  editing: boolean;
  canDelete: boolean;
  canPin: boolean;
  isPinned: boolean;
  canAddReactions: boolean;
  canKickAuthor: boolean;
  canBanAuthor: boolean;
  onReply: () => void;
  onOpenPicker: () => void;
  onPinToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onKick: () => void;
  onBan: () => void;
  onClose: () => void;
}) {
  const [contextMenuPos, setContextMenuPos] = useState(position);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = () => onClose();
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let left = position.x;
    let top = position.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - rect.height - margin;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (left !== contextMenuPos.x || top !== contextMenuPos.y) {
      setContextMenuPos({ x: left, y: top });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={contextMenuRef}
      className="context-menu"
      style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
    >
      <button
        className="context-menu-item"
        onClick={() => {
          onReply();
          onClose();
        }}
      >
        Reply
      </button>
      {canAddReactions && (
        <button
          className="context-menu-item"
          onClick={() => {
            onOpenPicker();
            onClose();
          }}
        >
          Add Reaction
        </button>
      )}
      {canPin && (
        <button
          className="context-menu-item"
          onClick={() => {
            onPinToggle();
            onClose();
          }}
        >
          {isPinned ? "Unpin Message" : "Pin Message"}
        </button>
      )}
      {isOwn && !editing && (
        <button
          className="context-menu-item"
          onClick={() => {
            onEdit();
            onClose();
          }}
        >
          Edit Message
        </button>
      )}
      {canDelete && !editing && (
        <button
          className="context-menu-item danger"
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          Delete Message
        </button>
      )}
      {(canKickAuthor || canBanAuthor) && (
        <div className="context-menu-separator" />
      )}
      {canKickAuthor && (
        <button className="context-menu-item danger" onClick={onKick}>
          Kick
        </button>
      )}
      {canBanAuthor && (
        <button className="context-menu-item danger" onClick={onBan}>
          Ban
        </button>
      )}
    </div>
  );
}
