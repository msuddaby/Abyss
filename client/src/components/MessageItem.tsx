import { useState, useRef, useEffect } from 'react';
import { API_BASE } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useMessageStore } from '../stores/messageStore';
import type { Message } from '../types';
import { hasPermission, Permission, getDisplayColor, canActOn } from '../types';
import UserProfileCard from './UserProfileCard';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

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

export default function MessageItem({ message, grouped, contextMenuOpen, setContextMenuMessageId }: { message: Message; grouped?: boolean; contextMenuOpen: boolean; setContextMenuMessageId: (id: string | null) => void }) {
  const [profileCard, setProfileCard] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [showPicker, setShowPicker] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const editInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const activeServer = useServerStore((s) => s.activeServer);
  const { kickMember, banMember } = useServerStore();
  const { editMessage, deleteMessage, toggleReaction } = useMessageStore();

  const isOwn = currentUser?.id === message.authorId;
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canManageMessages = currentMember ? hasPermission(currentMember, Permission.ManageMessages) : false;
  const canDelete = isOwn || canManageMessages;
  const authorMember = members.find((m) => m.userId === message.authorId);
  const authorColor = authorMember ? getDisplayColor(authorMember) : undefined;

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

  useEffect(() => {
    if (!contextMenuOpen) return;
    const handleClick = () => setContextMenuMessageId(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenuOpen, setContextMenuMessageId]);

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

  const handleEmojiSelect = (emoji: { native: string }) => {
    toggleReaction(message.id, emoji.native);
    setShowPicker(false);
  };

  const handleReactionClick = (emoji: string) => {
    toggleReaction(message.id, emoji);
  };

  if (message.isDeleted) {
    return (
      <div className="message-item message-deleted">
        <div className="message-avatar" onClick={handleAuthorClick}>
          {message.author.avatarUrl ? (
            <img src={message.author.avatarUrl.startsWith('http') ? message.author.avatarUrl : `${API_BASE}${message.author.avatarUrl}`} alt={message.author.displayName} />
          ) : (
            <span>{message.author.displayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="message-body">
          <div className="message-header">
            <span className="message-author clickable" onClick={handleAuthorClick} style={authorColor ? { color: authorColor } : undefined}>{message.author.displayName}</span>
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

  return (
    <div className={`message-item${grouped ? ' message-grouped' : ''}`} onContextMenu={handleContextMenu}>
      {grouped ? (
        <div className="message-avatar-gutter">
          <span className="message-time-inline">{formatTime(message.createdAt)}</span>
        </div>
      ) : (
        <div className="message-avatar clickable" onClick={handleAuthorClick}>
          {message.author.avatarUrl ? (
            <img src={message.author.avatarUrl.startsWith('http') ? message.author.avatarUrl : `${API_BASE}${message.author.avatarUrl}`} alt={message.author.displayName} />
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
            {message.content && <div className="message-content">{message.content}</div>}
          </>
        )}
        {message.attachments?.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="attachment">
                {att.contentType.startsWith('image/') ? (
                  <img src={`${API_BASE}${att.filePath}`} alt={att.fileName} className="attachment-image" />
                ) : (
                  <a href={`${API_BASE}${att.filePath}`} target="_blank" rel="noopener noreferrer">
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
                <span className="reaction-emoji">{g.emoji}</span>
                <span className="reaction-count">{g.count}</span>
              </button>
            ))}
            <button className="reaction-button reaction-add" onClick={() => setShowPicker(true)}>+</button>
          </div>
        )}
      </div>
      <div className="message-actions">
        <button onClick={() => setShowPicker(true)} title="Add Reaction">&#128578;</button>
        {isOwn && !editing && (
          <button onClick={() => { setEditContent(message.content); setEditing(true); }} title="Edit">&#9998;</button>
        )}
        {canDelete && !editing && (
          <button onClick={handleDelete} title="Delete">&#128465;</button>
        )}
      </div>
      {showPicker && (
        <div className="emoji-picker-container" ref={pickerRef}>
          <Picker data={data} onEmojiSelect={handleEmojiSelect} theme="dark" previewPosition="none" skinTonePosition="none" />
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
        <div className="context-menu" style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
          <button className="context-menu-item" onClick={() => { setShowPicker(true); setContextMenuMessageId(null); }}>Add Reaction</button>
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
    </div>
  );
}
