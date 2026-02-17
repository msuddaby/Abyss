import { useState, useRef, useEffect, useMemo, useCallback } from "react";
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
import { useLongPress } from "../hooks/useLongPress";

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
  const [previewSource, setPreviewSource] = useState<
    | { kind: "attachment"; attachment: Attachment }
    | { kind: "url"; url: string; fileName: string }
    | null
  >(null);
  const [isHovered, setIsHovered] = useState(false);
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
  // Always add animationPlayState control if there's any nameplateStyle (not just when animation property exists)
  const authorStyle: React.CSSProperties | undefined = nameplateStyle ? {
    ...nameplateStyle,
    animationPlayState: isHovered ? 'running' : 'paused',
    ...(nameplateStyle?.animation ? {
      willChange: 'background-position',
      transform: 'translateZ(0)',
      backfaceVisibility: 'hidden',
    } : {}),
  } : (authorColor ? { color: authorColor } : undefined);
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
  const emojisByName = useMemo(() => {
    const map: Record<string, { id: string; name: string; imageUrl: string }> = {};
    for (const e of emojis) {
      map[e.name.toLowerCase()] = { id: e.id, name: e.name, imageUrl: e.imageUrl };
    }
    return map;
  }, [emojis]);
  const markdownEnv = useMemo(
    () => ({
      membersById,
      emojisById,
      emojisByName,
      apiBase: getApiBase(),
    }),
    [membersById, emojisById, emojisByName],
  );
  const renderedContent = useMemo(
    () =>
      message.content ? renderMarkdownSafe(message.content, markdownEnv) : "",
    [message.content, markdownEnv],
  );
  const isGifMessage = useMemo(() => {
    if (!message.content) return false;
    return /^https:\/\/(media[0-9]*\.giphy\.com|i\.giphy\.com)\/media\/[^\s]+$/i.test(
      message.content.trim(),
    );
  }, [message.content]);

  const emojiOnly = useMemo(() => {
    if (!message.content) return false;
    // Strip custom emojis (<:name:id> format) and count them
    let t = message.content.trim();
    const customEmojiRe = /<:[a-zA-Z0-9_]{2,32}:[a-fA-F0-9-]{36}>/g;
    let count = 0;
    for (const _ of t.matchAll(customEmojiRe)) count++;
    t = t.replace(customEmojiRe, "");
    // Strip :name: shortcodes that match server emojis
    const shortcodeRe = /:([a-zA-Z0-9_]{2,32}):/g;
    t = t.replace(shortcodeRe, (match, name) => {
      if (emojisByName[(name as string).toLowerCase()]) { count++; return ""; }
      return match;
    });
    // Count remaining native emojis via grapheme segmenter
    const segs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)];
    for (const seg of segs) {
      if (/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/u.test(seg.segment)) count++;
      else if (seg.segment.trim().length > 0) return false; // non-emoji text
    }
    return count >= 1 && count <= 3;
  }, [message.content, emojisByName]);

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

  const openMessageMenu = useCallback(
    (x: number, y: number) => {
      openContextMenu(
        x,
        y,
        { message, user: message.author, member: authorMember },
        {
          onEdit: () => {
            setEditContent(message.content);
            setEditing(true);
          },
          onOpenReactionPicker: () => reactionsRef.current?.openPicker(),
          onViewProfile: () => setProfileCard({ x, y }),
        },
      );
    },
    [message, authorMember, openContextMenu],
  );

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMessageMenu(e.clientX, e.clientY);
  };

  const longPressHandlers = useLongPress(openMessageMenu);

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
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      {...longPressHandlers}
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
      )}
      <div className="message-body">
        {!grouped && (
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
            {message.content && isGifMessage ? (
              <div className="message-gif">
                <img
                  src={message.content.trim()}
                  alt="GIF"
                  loading="lazy"
                  onClick={() =>
                    setPreviewSource({
                      kind: "url",
                      url: message.content!.trim(),
                      fileName: "giphy.gif",
                    })
                  }
                  style={{ cursor: "pointer" }}
                />
              </div>
            ) : message.content ? (
              <div
                className={`message-content message-markdown${emojiOnly ? " single-emoji" : ""}`}
                dangerouslySetInnerHTML={{ __html: renderedContent }}
              />
            ) : null}
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
                    onClick={() => setPreviewSource({ kind: "attachment", attachment: att })}
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
      {previewSource && (
        <ImagePreviewModal
          source={previewSource}
          onClose={() => setPreviewSource(null)}
        />
      )}
    </div>
  );
}
