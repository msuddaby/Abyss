export interface CosmeticItem {
  id: string;
  name: string;
  description: string;
  type: CosmeticType;
  rarity: CosmeticRarity;
  cssData: string;
  previewImageUrl?: string;
  isActive: boolean;
  createdAt: string;
}

export const CosmeticType = {
  Nameplate: 0,
  MessageStyle: 1,
  ProfileEffect: 2,
  AvatarDecoration: 3,
} as const;
export type CosmeticType = (typeof CosmeticType)[keyof typeof CosmeticType];

export const CosmeticRarity = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Epic: 3,
  Legendary: 4,
} as const;
export type CosmeticRarity = (typeof CosmeticRarity)[keyof typeof CosmeticRarity];

export const CosmeticRarityNames: Record<number, string> = {
  0: 'Common',
  1: 'Uncommon',
  2: 'Rare',
  3: 'Epic',
  4: 'Legendary',
};

export const CosmeticRarityColors: Record<number, string> = {
  0: '#95a5a6',
  1: '#2ecc71',
  2: '#3498db',
  3: '#9b59b6',
  4: '#f39c12',
};

export const CosmeticTypeNames: Record<number, string> = {
  0: 'Nameplate',
  1: 'Message Style',
  2: 'Profile Effect',
  3: 'Avatar Decoration',
};

export interface EquippedCosmetics {
  nameplate?: CosmeticItem | null;
  messageStyle?: CosmeticItem | null;
  profileEffect?: CosmeticItem | null;
  avatarDecoration?: CosmeticItem | null;
}

export interface UserCosmetic {
  item: CosmeticItem;
  isEquipped: boolean;
  acquiredAt: string;
}

export const PresenceStatus = {
  Online: 0,
  Away: 1,
  DoNotDisturb: 2,
  Invisible: 3,
} as const;
export type PresenceStatus = (typeof PresenceStatus)[keyof typeof PresenceStatus];

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  status: string;
  bio: string;
  presenceStatus: number;
  cosmetics?: EquippedCosmetics | null;
  isGuest?: boolean;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: User;
}

export interface InviteInfo {
  serverName: string;
  serverIconUrl?: string;
  memberCount: number;
  allowGuests: boolean;
}

export interface GuestJoinResponse {
  token: string;
  refreshToken: string;
  user: User;
  server: Server;
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
  joinSoundUrl: string | null;
  leaveSoundUrl: string | null;
}

export interface Channel {
  id: string;
  name: string;
  type: "Text" | "Voice";
  serverId: string;
  position: number;
  permissions?: number;
  persistentChat?: boolean;
  userLimit?: number | null;
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
  serverId?: string;
  creatorId?: string;
  createdAt: string;
  expiresAt?: string;
  maxUses?: number;
  uses: number;
  lastUsedAt?: string;
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

export type FriendshipStatus = 'Pending' | 'Accepted' | 'Declined';

export interface Friendship {
  id: string;
  user: User;
  status: string;
  createdAt: string;
  acceptedAt?: string;
}

export interface FriendRequest {
  id: string;
  user: User;
  isOutgoing: boolean;
  createdAt: string;
}

export interface DmChannel {
  id: string;
  otherUser: User;
  lastMessageAt?: string;
  createdAt: string;
  lastMessageContent?: string | null;
  lastMessageAuthorName?: string | null;
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
  ownerName: string;
  memberCount: number;
  channelCount: number;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  status: string;
  avatarUrl?: string | null;
  createdAt: string;
}

export interface AdminOverviewStats {
  serverCount: number;
  userCount: number;
  messageCount: number;
}

export interface AdminServersResponse {
  servers: AdminServer[];
  totalCount: number;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  totalCount: number;
}

export interface AdminSettings {
  inviteOnly: boolean;
  maxMessageLength: number;
  codes: Invite[];
}

// Media provider types
export type MediaProviderType = 'Plex' | 'YouTube' | 'Spotify' | 'Twitch' | 'SoundCloud';

export interface MediaProviderConnection {
  id: string;
  serverId: string;
  ownerId: string;
  providerType: MediaProviderType;
  displayName: string;
  linkedAt: string;
  lastValidatedAt?: string;
}

export interface MediaLibrary {
  id: string;
  name: string;
  type: string;
  itemCount: number;
  thumbnailUrl?: string;
}

export interface MediaItem {
  id: string;
  title: string;
  type: string;
  summary?: string;
  thumbnailUrl?: string;
  durationMs?: number;
  year?: number;
  parentTitle?: string;
  grandparentTitle?: string;
  index?: number;
  parentIndex?: number;
}

export interface PlaybackInfo {
  url: string;
  contentType: string;
  headers: Record<string, string>;
}

export interface QueueItem {
  providerItemId: string;
  title: string;
  thumbnail?: string;
  durationMs?: number;
  addedByUserId: string;
}

export interface WatchParty {
  id: string;
  channelId: string;
  mediaProviderConnectionId: string;
  hostUserId: string;
  providerItemId: string;
  itemTitle: string;
  itemThumbnail?: string;
  itemDurationMs?: number;
  currentTimeMs: number;
  isPlaying: boolean;
  lastSyncAt: string;
  queue: QueueItem[];
  startedAt: string;
  providerType?: string;
  playbackUrl?: string;
}

export interface YouTubeResolveResult {
  connectionId: string;
  videoId: string;
  title: string;
  thumbnailUrl: string;
}

export interface SoundboardClip {
  id: string;
  serverId: string;
  name: string;
  url: string;
  uploadedById: string;
  duration: number;
  fileSize: number;
  createdAt: string;
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
  ManageSoundboard: 1 << 19,
  UseSoundboard: 1 << 20,
  AddToWatchTogether: 1 << 21,
  ModerateWatchTogether: 1 << 22,
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
