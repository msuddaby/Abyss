import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { getApiBase, useAuthStore, useServerStore, useMessageStore, hasPermission, Permission, getDisplayColor, canActOn } from '@abyss/shared';
import type { Message, ServerMember, CustomEmoji, Attachment } from '@abyss/shared';
import UserProfileCard from './UserProfileCard';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

// Matches <@userId> mentions and <:name:id> custom emojis in a single pass
const MENTION_EMOJI_REGEX = /<@([a-zA-Z0-9-]+)>|<:([a-zA-Z0-9_]{2,32}):([a-fA-F0-9-]{36})>/g;

function renderMentions(content: string, members: ServerMember[], emojis: CustomEmoji[]): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  type Segment = { type: 'text'; value: string } | { type: 'mention'; userId: string } | { type: 'emoji'; name: string; id: string };
  const intermediate: Segment[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MENTION_EMOJI_REGEX);

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      intermediate.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      intermediate.push({ type: 'mention', userId: match[1] });
    } else if (match[2] && match[3]) {
      intermediate.push({ type: 'emoji', name: match[2], id: match[3] });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    intermediate.push({ type: 'text', value: content.slice(lastIndex) });
  }

  // Now process @everyone and @here within text segments
  let key = 0;
  for (const seg of intermediate) {
    if (seg.type === 'mention') {
      const member = members.find((m) => m.userId === seg.userId);
      const displayName = member?.user.displayName ?? 'Unknown';
      parts.push(
        <span key={key++} className="mention mention-user">@{displayName}</span>
      );
    } else if (seg.type === 'emoji') {
      const emoji = emojis.find((e) => e.id === seg.id);
      if (emoji) {
        parts.push(
          <img key={key++} src={`${getApiBase()}${emoji.imageUrl}`} alt={`:${seg.name}:`} title={`:${seg.name}:`} className="custom-emoji" />
        );
      } else {
        parts.push(<span key={key++}>:{seg.name}:</span>);
      }
    } else {
      // Split text on @everyone and @here
      const textParts = seg.value.split(/(@everyone|@here)/g);
      for (const tp of textParts) {
        if (tp === '@everyone') {
          parts.push(<span key={key++} className="mention mention-everyone">@everyone</span>);
        } else if (tp === '@here') {
          parts.push(<span key={key++} className="mention mention-here">@here</span>);
        } else if (tp) {
          parts.push(<span key={key++}>{tp}</span>);
        }
      }
    }
  }

  return parts;
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

function groupReactions(message: Message) {
  const groups: { emoji: string; userIds: string[]; count: number }[] = [];
  for (const r of message.reactions ?? []) {
    const existing = groups.find((g) => g.emoji === r.emoji);
    if (existing) {
      existing.userIds.push(r.userId);
      existing.count++;
    } else {
      groups.push({ emoji: r.emoji, userIds: [r.userId], count: 1 });
    }
  }
  return groups;
}

export default function MessageItem({ message, grouped, contextMenuOpen, setContextMenuMessageId, onScrollToMessage }: { message: Message; grouped?: boolean; contextMenuOpen: boolean; setContextMenuMessageId: (id: string | null) => void; onScrollToMessage?: (id: string) => void }) {
  const [profileCard, setProfileCard] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(null);
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const activeServer = useServerStore((s) => s.activeServer);
  const { kickMember, banMember } = useServerStore();
  const { editMessage, deleteMessage, toggleReaction, setReplyingTo } = useMessageStore();

  const isOwn = currentUser?.id === message.authorId;
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canManageMessages = currentMember ? hasPermission(currentMember, Permission.ManageMessages) : false;
  const canDelete = isOwn || canManageMessages;
  const authorMember = members.find((m) => m.userId === message.authorId);
  const authorColor = authorMember ? getDisplayColor(authorMember) : undefined;

  // Use live member data when available, fall back to stale message snapshot
  const authorDisplayName = authorMember?.user.displayName ?? message.author.displayName;
  const authorAvatarUrl = authorMember?.user.avatarUrl ?? message.author.avatarUrl;

  const canKickPerm = currentMember ? hasPermission(currentMember, Permission.KickMembers) : false;
  const canBanPerm = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (!showPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPicker]);

  const updatePickerPosition = useCallback(() => {
    if (!showPicker || !pickerRef.current || !pickerAnchor) return;
    const rect = pickerRef.current.getBoundingClientRect();
    const margin = 8;
    let left = pickerAnchor.x;
    let top = pickerAnchor.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (left < margin) left = margin;
    const aboveTop = pickerAnchor.y - rect.height - margin;
    const belowTop = pickerAnchor.y + margin;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + rect.height <= window.innerHeight - margin) {
      top = belowTop;
    } else {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPickerStyle((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [showPicker, pickerAnchor]);

  useLayoutEffect(() => {
    updatePickerPosition();
  }, [updatePickerPosition]);

  useEffect(() => {
    if (!showPicker || !pickerRef.current) return;
    const ro = new ResizeObserver(() => updatePickerPosition());
    ro.observe(pickerRef.current);
    window.addEventListener('resize', updatePickerPosition);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updatePickerPosition);
    };
  }, [showPicker, updatePickerPosition]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const handleClick = () => setContextMenuMessageId(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenuOpen, setContextMenuMessageId]);

  useLayoutEffect(() => {
    if (!contextMenuOpen || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let left = contextMenuPos.x;
    let top = contextMenuPos.y;
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
  }, [contextMenuOpen, contextMenuPos]);

  useEffect(() => {
    if (!previewAttachment) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPreviewAttachment(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [previewAttachment]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuMessageId(message.id);
  };

  // Admin action conditions for context menu
  const showAdminActions = !isOwn && authorMember && currentMember;
  const canKickAuthor = canKickPerm && showAdminActions && canActOn(currentMember!, authorMember!);
  const canBanAuthor = canBanPerm && showAdminActions && canActOn(currentMember!, authorMember!);

  const handleKick = async () => {
    if (!activeServer) return;
    await kickMember(activeServer.id, message.authorId);
    setContextMenuMessageId(null);
  };

  const handleBan = async () => {
    if (!activeServer) return;
    await banMember(activeServer.id, message.authorId);
    setContextMenuMessageId(null);
  };

  const handleAuthorClick = (e: React.MouseEvent) => {
    setProfileCard({ x: e.clientX, y: e.clientY });
  };

  const handleImagePreview = (att: Attachment) => {
    setPreviewAttachment(att);
  };

  const handleClosePreview = () => {
    setPreviewAttachment(null);
  };

  const handleEditSave = async () => {
    const trimmed = editContent.trim();
    if (trimmed && trimmed !== message.content) {
      await editMessage(message.id, trimmed);
    }
    setEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleEditSave();
    } else if (e.key === 'Escape') {
      setEditContent(message.content);
      setEditing(false);
    }
  };

  const handleDelete = () => {
    deleteMessage(message.id);
  };

  const openPicker = (e?: React.MouseEvent<HTMLElement>) => {
    const target = e?.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect() ?? messageRef.current?.getBoundingClientRect();
    if (rect) {
      setPickerAnchor({ x: rect.right, y: rect.top });
    } else {
      setPickerAnchor({ x: 0, y: 0 });
    }
    setShowPicker(true);
  };

  const customEmojiCategory = emojis.length > 0 ? [{
    id: 'custom',
    name: 'Server Emojis',
    emojis: emojis.map((e) => ({
      id: `custom-${e.id}`,
      name: e.name,
      keywords: [e.name],
      skins: [{ src: `${getApiBase()}${e.imageUrl}` }],
    })),
  }] : [];

  const handleEmojiSelect = (emoji: { native?: string; id?: string }) => {
    if (emoji.native) {
      toggleReaction(message.id, emoji.native);
    } else if (emoji.id?.startsWith('custom-')) {
      const emojiId = emoji.id.substring(7);
      toggleReaction(message.id, `custom:${emojiId}`);
    }
    setShowPicker(false);
  };

  const handleReactionClick = (emoji: string) => {
    toggleReaction(message.id, emoji);
  };

  if (message.isSystem) {
    return (
      <div className="message-item system-message">
        <div className="system-message-content">
          <span className="system-message-icon">●</span>
          <span className="system-message-text">
            <strong>{authorDisplayName}</strong> {message.content}
          </span>
          <span className="system-message-time">{formatDate(message.createdAt)} at {formatTime(message.createdAt)}</span>
        </div>
      </div>
    );
  }

  if (message.isDeleted) {
    return (
      <div className="message-item message-deleted">
        <div className="message-avatar" onClick={handleAuthorClick}>
          {authorAvatarUrl ? (
            <img src={authorAvatarUrl.startsWith('http') ? authorAvatarUrl : `${getApiBase()}${authorAvatarUrl}`} alt={authorDisplayName} />
          ) : (
            <span>{authorDisplayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="message-body">
          <div className="message-header">
            <span className="message-author clickable" onClick={handleAuthorClick} style={authorColor ? { color: authorColor } : undefined}>{authorDisplayName}</span>
            <span className="message-time">{formatDate(message.createdAt)} at {formatTime(message.createdAt)}</span>
          </div>
          <div className="message-content message-deleted-text">This message has been deleted</div>
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

  const reactionGroups = groupReactions(message);

  const isMentioned = currentUser && (
    message.content.includes(`<@${currentUser.id}>`) ||
    message.content.includes('@everyone') ||
    message.content.includes('@here')
  );

  return (
    <div ref={messageRef} className={`message-item${grouped ? ' message-grouped' : ''}${isMentioned ? ' message-mentioned' : ''}${message.replyTo ? ' message-has-reply' : ''}`} onContextMenu={handleContextMenu}>
      {message.replyTo && (
        <div className="reply-reference" onClick={() => !message.replyTo!.isDeleted && onScrollToMessage?.(message.replyTo!.id)}>
          <div className="reply-reference-line" />
          <div className="reply-reference-avatar">
            {message.replyTo.author.avatarUrl ? (
              <img src={message.replyTo.author.avatarUrl.startsWith('http') ? message.replyTo.author.avatarUrl : `${getApiBase()}${message.replyTo.author.avatarUrl}`} alt={message.replyTo.author.displayName} />
            ) : (
              <span>{message.replyTo.author.displayName.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <span className="reply-reference-author" style={(() => { const m = members.find((m) => m.userId === message.replyTo!.authorId); return m ? { color: getDisplayColor(m) } : undefined; })()}>
            {message.replyTo.author.displayName}
          </span>
          {message.replyTo.isDeleted ? (
            <span className="reply-reference-content reply-deleted">Original message was deleted</span>
          ) : (
            <span className="reply-reference-content">{message.replyTo.content.length > 100 ? message.replyTo.content.slice(0, 100) + '...' : message.replyTo.content}</span>
          )}
        </div>
      )}
      {grouped ? (
        <div className="message-avatar-gutter">
          <span className="message-time-inline">{formatTime(message.createdAt)}</span>
        </div>
      ) : (
        <div className="message-avatar clickable" onClick={handleAuthorClick}>
          {message.author.avatarUrl ? (
            <img src={message.author.avatarUrl.startsWith('http') ? message.author.avatarUrl : `${getApiBase()}${message.author.avatarUrl}`} alt={message.author.displayName} />
          ) : (
            <span>{message.author.displayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
      )}
      <div className="message-body">
        {!grouped && (
          <div className="message-header">
            <span className="message-author clickable" onClick={handleAuthorClick} style={authorColor ? { color: authorColor } : undefined}>{message.author.displayName}</span>
            <span className="message-time">{formatDate(message.createdAt)} at {formatTime(message.createdAt)}</span>
            {message.editedAt && <span className="message-edited-label">(edited)</span>}
          </div>
        )}
        {grouped && message.editedAt && <span className="message-edited-label">(edited)</span>}
        {editing ? (
          <input
            ref={editInputRef}
            className="message-edit-input"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={handleEditSave}
          />
        ) : (
          <>
            {message.content && <div className="message-content">{renderMentions(message.content, members, emojis)}</div>}
          </>
        )}
        {message.attachments?.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="attachment">
                {att.contentType.startsWith('image/') ? (
                  <img
                    src={`${getApiBase()}${att.filePath}`}
                    alt={att.fileName}
                    className="attachment-image"
                    onClick={() => handleImagePreview(att)}
                  />
                ) : (
                  <a href={`${getApiBase()}${att.filePath}`} target="_blank" rel="noopener noreferrer">
                    {att.fileName}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {reactionGroups.length > 0 && (
          <div className="message-reactions">
            {reactionGroups.map((g) => (
              <button
                key={g.emoji}
                className={`reaction-button${currentUser && g.userIds.includes(currentUser.id) ? ' reacted' : ''}`}
                onClick={() => handleReactionClick(g.emoji)}
              >
                <span className="reaction-emoji">{g.emoji.startsWith('custom:') ? (() => {
                  const eid = g.emoji.substring(7);
                  const ce = emojis.find((e) => e.id === eid);
                  return ce ? <img src={`${getApiBase()}${ce.imageUrl}`} alt={`:${ce.name}:`} className="custom-emoji-reaction" /> : '?';
                })() : g.emoji}</span>
                <span className="reaction-count">{g.count}</span>
              </button>
            ))}
            <button className="reaction-button reaction-add" onClick={(e) => openPicker(e)}>+</button>
          </div>
        )}
      </div>
      <div className="message-actions">
        <button onClick={() => setReplyingTo(message)} title="Reply">&#8617;</button>
        <button onClick={(e) => openPicker(e)} title="Add Reaction">&#128578;</button>
        {isOwn && !editing && (
          <button onClick={() => { setEditContent(message.content); setEditing(true); }} title="Edit">&#9998;</button>
        )}
        {canDelete && !editing && (
          <button onClick={handleDelete} title="Delete">&#128465;</button>
        )}
      </div>
      {showPicker && (
        <div className="emoji-picker-container" ref={pickerRef} style={pickerStyle ?? undefined}>
          <Picker data={data} custom={customEmojiCategory} onEmojiSelect={handleEmojiSelect} theme="dark" previewPosition="none" skinTonePosition="none" />
        </div>
      )}
      {profileCard && (
        <UserProfileCard
          userId={message.authorId}
          position={profileCard}
          onClose={() => setProfileCard(null)}
        />
      )}
      {contextMenuOpen && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
          <button className="context-menu-item" onClick={() => { setReplyingTo(message); setContextMenuMessageId(null); }}>Reply</button>
          <button className="context-menu-item" onClick={(e) => { openPicker(e); setContextMenuMessageId(null); }}>Add Reaction</button>
          {isOwn && !editing && (
            <button className="context-menu-item" onClick={() => { setEditContent(message.content); setEditing(true); setContextMenuMessageId(null); }}>Edit Message</button>
          )}
          {canDelete && !editing && (
            <button className="context-menu-item danger" onClick={() => { handleDelete(); setContextMenuMessageId(null); }}>Delete Message</button>
          )}
          {(canKickAuthor || canBanAuthor) && (
            <div className="context-menu-separator" />
          )}
          {canKickAuthor && (
            <button className="context-menu-item danger" onClick={handleKick}>Kick</button>
          )}
          {canBanAuthor && (
            <button className="context-menu-item danger" onClick={handleBan}>Ban</button>
          )}
        </div>
      )}
      {previewAttachment && (
        <div className="modal-overlay image-preview-overlay" onClick={handleClosePreview}>
          <div className="image-preview-modal" onClick={(e) => e.stopPropagation()}>
            <img
              src={`${getApiBase()}${previewAttachment.filePath}`}
              alt={previewAttachment.fileName}
              className="image-preview-img"
            />
            <div className="image-preview-actions">
              <a
                className="image-download-btn"
                href={`${getApiBase()}${previewAttachment.filePath}`}
                download={previewAttachment.fileName}
              >
                Download
              </a>
              <button className="btn-secondary" onClick={handleClosePreview}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
