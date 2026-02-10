export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  status: string;
  bio: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: User;
}

export interface Server {
  id: string;
  name: string;
  iconUrl?: string;
  ownerId: string;
  joinLeaveMessagesEnabled: boolean;
  joinLeaveChannelId?: string | null;
  defaultNotificationLevel: number;
}

export const NotificationLevel = {
  AllMessages: 0,
  OnlyMentions: 1,
  Nothing: 2,
} as const;

const NotificationLevelNames: Record<number, string> = {
  0: 'All Messages',
  1: 'Only Mentions',
  2: 'Nothing',
};

export function getNotificationLevelName(level: number): string {
  return NotificationLevelNames[level] ?? 'All Messages';
}

export const VoiceInputMode = {
  VoiceActivity: 0,
  PushToTalk: 1,
} as const;

export interface ServerNotifSettings {
  notificationLevel: number | null;
  muteUntil: string | null;
  suppressEveryone: boolean;
}

export interface ChannelNotifSettings {
  notificationLevel: number | null;
  muteUntil: string | null;
}

export interface UserPreferences {
  inputMode: number;
  joinMuted: boolean;
  joinDeafened: boolean;
  inputSensitivity: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  uiPreferences: string | null;
}

export interface Channel {
  id: string;
  name: string;
  type: "Text" | "Voice";
  serverId: string;
  position: number;
  permissions?: number;
  persistentChat?: boolean;
}

export interface ServerRole {
  id: string;
  name: string;
  color: string;
  permissions: number;
  position: number;
  isDefault: boolean;
  displaySeparately: boolean;
}

export interface ServerMember {
  serverId: string;
  userId: string;
  user: User;
  isOwner: boolean;
  roles: ServerRole[];
  joinedAt: string;
}

export interface ServerBan {
  id: string;
  userId: string;
  user: User;
  bannedById: string;
  bannedBy: User;
  reason?: string;
  createdAt: string;
}

export interface VoiceUserState {
  displayName: string;
  isMuted: boolean;
  isDeafened: boolean;
  isServerMuted: boolean;
  isServerDeafened: boolean;
}

export interface ReplyReference {
  id: string;
  content: string;
  authorId: string;
  author: User;
  isDeleted: boolean;
}

export interface Message {
  id: string;
  content: string;
  authorId: string;
  author: User;
  channelId: string;
  createdAt: string;
  attachments: Attachment[];
  editedAt?: string;
  isDeleted: boolean;
  isSystem: boolean;
  reactions: Reaction[];
  replyToMessageId?: string;
  replyTo?: ReplyReference;
}

export interface PinnedMessage {
  message: Message;
  pinnedAt: string;
  pinnedBy: User;
}

export interface Reaction {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
}

export interface Attachment {
  id: string;
  messageId: string;
  fileName: string;
  filePath: string;
  posterPath?: string | null;
  contentType: string;
  size: number;
}

export interface Invite {
  id: string;
  code: string;
  serverId: string;
  creatorId: string;
  expiresAt?: string;
  maxUses?: number;
  uses: number;
}

export interface AuditLog {
  id: string;
  action: string;
  actorId: string;
  actor: User;
  targetId?: string;
  targetName?: string;
  details?: string;
  createdAt: string;
}

export interface CustomEmoji {
  id: string;
  serverId: string;
  name: string;
  imageUrl: string;
  createdById: string;
  createdAt: string;
}

export interface DmChannel {
  id: string;
  otherUser: User;
  lastMessageAt?: string;
  createdAt: string;
}

export interface DmUnread {
  channelId: string;
  hasUnread: boolean;
  mentionCount: number;
}

export interface SearchResult {
  message: Message;
  channelName: string;
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
}

export interface AdminServer {
  id: string;
  name: string;
  ownerId: string;
  memberCount: number;
  channelCount: number;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  status: string;
}

export interface AdminOverview {
  servers: AdminServer[];
  users: AdminUser[];
}

export interface InviteCode {
  id: string;
  code: string;
  createdById?: string;
  createdAt: string;
  expiresAt?: string;
  maxUses?: number;
  uses: number;
  lastUsedAt?: string;
}

export interface AdminSettings {
  inviteOnly: boolean;
  maxMessageLength: number;
  codes: InviteCode[];
}

export const Permission = {
  ManageChannels: 1 << 0,
  ManageMessages: 1 << 1,
  KickMembers: 1 << 2,
  BanMembers: 1 << 3,
  ManageRoles: 1 << 4,
  ViewAuditLog: 1 << 5,
  ManageServer: 1 << 6,
  ManageInvites: 1 << 7,
  ManageEmojis: 1 << 8,
  MuteMembers: 1 << 9,
  ViewChannel: 1 << 10,
  ReadMessageHistory: 1 << 11,
  SendMessages: 1 << 12,
  AddReactions: 1 << 13,
  AttachFiles: 1 << 14,
  MentionEveryone: 1 << 15,
  Connect: 1 << 16,
  Speak: 1 << 17,
  Stream: 1 << 18,
} as const;

export function hasPermission(member: ServerMember, perm: number): boolean {
  if (member.isOwner) return true;
  const combined = member.roles.reduce((acc, r) => acc | r.permissions, 0);
  return (combined & perm) === perm;
}

export function hasChannelPermission(
  channelPermissions: number | undefined,
  perm: number,
): boolean {
  if (channelPermissions == null) return false;
  return (channelPermissions & perm) === perm;
}

export function canViewChannel(channel: Channel): boolean {
  if (!channel.serverId) return true;
  return hasChannelPermission(channel.permissions, Permission.ViewChannel);
}

export function getDisplayColor(member: ServerMember): string | undefined {
  const sorted = [...member.roles]
    .filter((r) => r.color !== "#99aab5" && !r.isDefault)
    .sort((a, b) => b.position - a.position);
  return sorted[0]?.color;
}

export function getHighestRole(member: ServerMember): ServerRole | undefined {
  return [...member.roles]
    .filter((r) => !r.isDefault)
    .sort((a, b) => b.position - a.position)[0];
}

export function canActOn(actor: ServerMember, target: ServerMember): boolean {
  if (actor.userId === target.userId) return false;
  if (target.isOwner) return false;
  const actorPos = actor.isOwner
    ? Infinity
    : Math.max(0, ...actor.roles.map((r) => r.position));
  const targetPos = target.isOwner
    ? Infinity
    : Math.max(0, ...target.roles.map((r) => r.position));
  return actorPos > targetPos;
}
