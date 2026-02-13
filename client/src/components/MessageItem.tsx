import { useState, useRef, useEffect, useMemo } from "react";
import {
  getApiBase,
  useAuthStore,
  useServerStore,
  useMessageStore,
  useAppConfigStore,
  useToastStore,
  hasPermission,
  hasChannelPermission,
  Permission,
  getDisplayColor,
  getNameplateStyle,
  useDmStore,
} from "@abyss/shared";
import type { Message, Attachment } from "@abyss/shared";
import UserProfileCard from "./UserProfileCard";
import { renderMarkdownSafe } from "./markdown/messageMarkdown";
import { formatTime, formatDate } from "../utils/messageUtils";
import AttachmentMedia from "./message/AttachmentMedia";
import MessageReplyIndicator from "./message/MessageReplyIndicator";
import MessageReactions from "./message/MessageReactions";
import type { MessageReactionsHandle } from "./message/MessageReactions";
import ImagePreviewModal from "./message/ImagePreviewModal";
import { useContextMenuStore } from "../stores/contextMenuStore";

export default function MessageItem({
  message,
  grouped,
  onScrollToMessage,
}: {
  message: Message;
  grouped?: boolean;
  onScrollToMessage?: (id: string) => void;
}) {
  const [profileCard, setProfileCard] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [editError, setEditError] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(
    null,
  );
  const editInputRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const reactionsRef = useRef<MessageReactionsHandle>(null);
  const currentUser = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const maxMessageLength = useAppConfigStore((s) => s.maxMessageLength);
  const addToast = useToastStore((s) => s.addToast);
  const { editMessage, deleteMessage, toggleReaction, setReplyingTo } =
    useMessageStore();
  const isDmMode = useDmStore((s) => s.isDmMode);
  const openContextMenu = useContextMenuStore((s) => s.open);

  const isOwn = currentUser?.id === message.authorId;
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canManageMessages = currentMember
    ? hasPermission(currentMember, Permission.ManageMessages)
    : false;
  const canDelete = isOwn || canManageMessages;
  const canAddReactions = isDmMode
    ? true
    : hasChannelPermission(activeChannel?.permissions, Permission.AddReactions);
  const authorMember = members.find((m) => m.userId === message.authorId);
  const authorColor = authorMember ? getDisplayColor(authorMember) : undefined;
  const nameplateStyle = getNameplateStyle(message.author);
  const authorStyle = nameplateStyle ?? (authorColor ? { color: authorColor } : undefined);
  const membersById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of members) {
      map[m.userId] = m.user.displayName;
    }
    return map;
  }, [members]);
  const emojisById = useMemo(() => {
    const map: Record<string, { name: string; imageUrl: string }> = {};
    for (const e of emojis) {
      map[e.id] = { name: e.name, imageUrl: e.imageUrl };
    }
    return map;
  }, [emojis]);
  const markdownEnv = useMemo(
    () => ({
      membersById,
      emojisById,
      apiBase: getApiBase(),
    }),
    [membersById, emojisById],
  );
  const renderedContent = useMemo(
    () =>
      message.content ? renderMarkdownSafe(message.content, markdownEnv) : "",
    [message.content, markdownEnv],
  );

  // Use live member data when available, fall back to stale message snapshot
  const authorDisplayName =
    authorMember?.user.displayName ?? message.author.displayName;
  const authorAvatarUrl =
    authorMember?.user.avatarUrl ?? message.author.avatarUrl;

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
    }
  }, [editing]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openContextMenu(
      e.clientX,
      e.clientY,
      { message, user: message.author, member: authorMember },
      {
        onEdit: () => {
          setEditContent(message.content);
          setEditing(true);
        },
        onOpenReactionPicker: () => reactionsRef.current?.openPicker(),
        onViewProfile: () => setProfileCard({ x: e.clientX, y: e.clientY }),
      },
    );
  };

  const handleAuthorClick = (e: React.MouseEvent) => {
    setProfileCard({ x: e.clientX, y: e.clientY });
  };

  const handleEditSave = async () => {
    const trimmed = editContent.trim();
    if (trimmed.length > maxMessageLength) {
      setEditError(`Message must be 1-${maxMessageLength} characters.`);
      addToast(`Message must be 1-${maxMessageLength} characters.`, "error");
      return;
    }
    try {
      if (trimmed && trimmed !== message.content) {
        await editMessage(message.id, trimmed);
      }
      setEditing(false);
      setEditError(null);
    } catch {
      addToast("Failed to edit message.", "error");
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleEditSave();
    } else if (e.key === "Escape") {
      setEditContent(message.content);
      setEditError(null);
      setEditing(false);
    }
  };

  const handleDelete = () => {
    deleteMessage(message.id);
  };

  const handleToggleReaction = (emoji: string) => {
    toggleReaction(message.id, emoji);
  };

  const isMentioned =
    currentUser &&
    (message.content.includes(`<@${currentUser.id}>`) ||
      message.content.includes("@everyone") ||
      message.content.includes("@here"));

  if (message.isSystem) {
    return (
      <div className="message-item system-message">
        <div className="system-message-content">
          <span className="system-message-icon">●</span>
          <span className="system-message-text">
            <strong>{authorDisplayName}</strong> {message.content}
          </span>
          <span className="system-message-time">
            {formatDate(message.createdAt)} at {formatTime(message.createdAt)}
          </span>
        </div>
      </div>
    );
  }

  if (message.isDeleted) {
    return (
      <div className="message-item message-deleted">
        <div className="message-avatar" onClick={handleAuthorClick}>
          {authorAvatarUrl ? (
            <img
              src={
                authorAvatarUrl.startsWith("http")
                  ? authorAvatarUrl
                  : `${getApiBase()}${authorAvatarUrl}`
              }
              alt={authorDisplayName}
            />
          ) : (
            <span>{authorDisplayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="message-body">
          <div className="message-header">
            <span
              className="message-author clickable"
              onClick={handleAuthorClick}
              style={authorStyle}
            >
              {authorDisplayName}
            </span>
            <span className="message-time">
              {formatDate(message.createdAt)} at {formatTime(message.createdAt)}
            </span>
          </div>
          <div className="message-content message-deleted-text">
            This message has been deleted
          </div>
        </div>
        {profileCard && (
          <UserProfileCard
            userId={message.authorId}
            position={profileCard}
            onClose={() => setProfileCard(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={messageRef}
      className={`message-item${grouped ? " message-grouped" : ""}${isMentioned ? " message-mentioned" : ""}${message.replyTo ? " message-has-reply" : ""}`}
      onContextMenu={handleContextMenu}
    >
      {message.replyTo && (
        <MessageReplyIndicator
          replyTo={message.replyTo}
          onScrollToMessage={onScrollToMessage}
        />
      )}
      {grouped ? (
        <div className="message-avatar-gutter">
          <span className="message-time-inline">
            {formatTime(message.createdAt)}
          </span>
        </div>
      ) : (
        <div className="message-avatar clickable" onClick={handleAuthorClick}>
          {message.author.avatarUrl ? (
            <img
              src={
                message.author.avatarUrl.startsWith("http")
                  ? message.author.avatarUrl
                  : `${getApiBase()}${message.author.avatarUrl}`
              }
              alt={message.author.displayName}
            />
          ) : (
            <span>{message.author.displayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
      )}
      <div className="message-body">
        {!grouped && (
          <div className="message-header">
            <span
              className="message-author clickable"
              onClick={handleAuthorClick}
              style={authorStyle}
            >
              {message.author.displayName}
            </span>
            <span className="message-time">
              {formatDate(message.createdAt)} at {formatTime(message.createdAt)}
            </span>
            {message.editedAt && (
              <span className="message-edited-label">(edited)</span>
            )}
          </div>
        )}
        {grouped && message.editedAt && (
          <span className="message-edited-label">(edited)</span>
        )}
        {editing ? (
          <div className="message-edit-wrapper">
            <input
              ref={editInputRef}
              className="message-edit-input"
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value);
                if (
                  editError &&
                  e.target.value.trim().length <= maxMessageLength
                ) {
                  setEditError(null);
                }
              }}
              onKeyDown={handleEditKeyDown}
              onBlur={handleEditSave}
            />
            {editError && <div className="message-edit-error">{editError}</div>}
          </div>
        ) : (
          <>
            {message.content && (
              <div
                className="message-content message-markdown"
                dangerouslySetInnerHTML={{ __html: renderedContent }}
              />
            )}
          </>
        )}
        {message.attachments?.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="attachment">
                {att.contentType.startsWith("image/") &&
                !att.contentType.includes("svg") ? (
                  <img
                    src={`${getApiBase()}${att.filePath}`}
                    alt={att.fileName}
                    className="attachment-image"
                    onClick={() => setPreviewAttachment(att)}
                  />
                ) : (
                  <AttachmentMedia att={att} />
                )}
              </div>
            ))}
          </div>
        )}
        <MessageReactions
          ref={reactionsRef}
          message={message}
          canAddReactions={canAddReactions}
          onToggleReaction={handleToggleReaction}
          messageRef={messageRef}
        />
      </div>
      <div className="message-actions">
        <button onClick={() => setReplyingTo(message)} title="Reply">
          &#8617;
        </button>
        {canAddReactions && (
          <button
            onClick={() => reactionsRef.current?.openPicker()}
            title="Add Reaction"
          >
            &#128578;
          </button>
        )}
        {isOwn && !editing && (
          <button
            onClick={() => {
              setEditContent(message.content);
              setEditing(true);
            }}
            title="Edit"
          >
            &#9998;
          </button>
        )}
        {canDelete && !editing && (
          <button onClick={handleDelete} title="Delete">
            &#128465;
          </button>
        )}
      </div>
      {profileCard && (
        <UserProfileCard
          userId={message.authorId}
          position={profileCard}
          onClose={() => setProfileCard(null)}
        />
      )}
      {previewAttachment && (
        <ImagePreviewModal
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
}
