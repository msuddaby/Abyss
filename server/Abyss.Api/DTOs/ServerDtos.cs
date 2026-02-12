using Microsoft.AspNetCore.Http;

namespace Abyss.Api.DTOs;

public record CreateServerRequest(string Name);
public class UpdateServerRequest
{
    public string? Name { get; set; }
    public IFormFile? Icon { get; set; }
    public bool? RemoveIcon { get; set; }
    public bool? JoinLeaveMessagesEnabled { get; set; }
    public Guid? JoinLeaveChannelId { get; set; }
}
public record ServerDto(Guid Id, string Name, string? IconUrl, string OwnerId, bool JoinLeaveMessagesEnabled, Guid? JoinLeaveChannelId, int DefaultNotificationLevel = 0);
public record CreateChannelRequest(string Name, string Type);
public record UpdateChannelRequest(string Name, bool? PersistentChat = null);
public record ReorderChannelsRequest(string Type, List<Guid> ChannelIds);
public record ChannelDto(Guid Id, string? Name, string Type, Guid? ServerId, int Position, long? Permissions = null, bool PersistentChat = false);
public record ChannelPermissionOverrideDto(Guid RoleId, long Allow, long Deny);
public record ChannelPermissionsDto(List<ChannelPermissionOverrideDto> Overrides);
public record ServerMemberDto(Guid ServerId, string UserId, UserDto User, bool IsOwner, List<ServerRoleDto> Roles, DateTime JoinedAt);
public record ServerRoleDto(Guid Id, string Name, string Color, long Permissions, int Position, bool IsDefault, bool DisplaySeparately);
public record InviteDto(Guid Id, string Code, Guid ServerId, string CreatorId, DateTime? ExpiresAt, int? MaxUses, int Uses);
public record ReplyReferenceDto(Guid Id, string Content, string AuthorId, UserDto Author, bool IsDeleted);
public record MessageDto(Guid Id, string Content, string AuthorId, UserDto Author, Guid ChannelId, DateTime CreatedAt, List<AttachmentDto> Attachments, DateTime? EditedAt, bool IsDeleted, bool IsSystem, List<ReactionDto> Reactions, Guid? ReplyToMessageId, ReplyReferenceDto? ReplyTo);
public record PinnedMessageDto(MessageDto Message, DateTime PinnedAt, UserDto PinnedBy);
public record ReactionDto(Guid Id, Guid MessageId, string UserId, string Emoji);
public record AttachmentDto(Guid Id, Guid MessageId, string FileName, string FilePath, string? PosterPath, string ContentType, long Size);
public record AuditLogDto(Guid Id, string Action, string ActorId, UserDto Actor, string? TargetId, string? TargetName, string? Details, DateTime CreatedAt);
public record CreateRoleRequest(string Name, string Color, long Permissions, bool DisplaySeparately);
public record UpdateRoleRequest(string? Name, string? Color, long? Permissions, int? Position, bool? DisplaySeparately);
public record UpdateMemberRolesRequest(List<Guid> RoleIds);
public record BanMemberRequest(string? Reason);
public record ServerBanDto(Guid Id, string UserId, UserDto User, string BannedById, UserDto BannedBy, string? Reason, DateTime CreatedAt);
public record ReorderRolesRequest(List<Guid> RoleIds);
public record ChannelUnreadDto(Guid ChannelId, bool HasUnread, int MentionCount);
public record ServerUnreadDto(Guid ServerId, bool HasUnread, int MentionCount);
public record NotificationDto(Guid Id, Guid MessageId, Guid ChannelId, Guid? ServerId, string Type, DateTime CreatedAt);
public record CustomEmojiDto(Guid Id, Guid ServerId, string Name, string ImageUrl, string CreatedById, DateTime CreatedAt);
public record RenameEmojiRequest(string Name);
public record DmChannelDto(Guid Id, UserDto OtherUser, DateTime? LastMessageAt, DateTime CreatedAt);
public record DmUnreadDto(Guid ChannelId, bool HasUnread, int MentionCount);
public record SearchResultDto(MessageDto Message, string ChannelName);
public record SearchResponseDto(List<SearchResultDto> Results, int TotalCount);
public record VoiceUserStateDto(string DisplayName, bool IsMuted, bool IsDeafened, bool IsServerMuted, bool IsServerDeafened);

// Notification settings DTOs
public record ServerNotificationSettingsDto(int? NotificationLevel, DateTime? MuteUntil, bool SuppressEveryone);
public record ChannelNotificationSettingsDto(int? NotificationLevel, DateTime? MuteUntil);
public class UpdateServerNotificationSettingsRequest
{
    public int? NotificationLevel { get; set; }
    public DateTime? MuteUntil { get; set; }
    public bool? SuppressEveryone { get; set; }
}
public class UpdateChannelNotificationSettingsRequest
{
    public int? NotificationLevel { get; set; }
    public DateTime? MuteUntil { get; set; }
}
public record UserNotificationOverviewDto(
    ServerNotificationSettingsDto ServerSettings,
    Dictionary<Guid, ChannelNotificationSettingsDto> ChannelSettings);

// Media provider DTOs
public record MediaProviderConnectionDto(Guid Id, Guid ServerId, string OwnerId, string ProviderType, string DisplayName, DateTime LinkedAt, DateTime? LastValidatedAt);
public record LinkProviderRequest(string ProviderType, string DisplayName, string ServerUrl, string AuthToken);
public record MediaLibraryDto(string Id, string Name, string Type, int ItemCount, string? ThumbnailUrl);
public record MediaItemDto(string Id, string Title, string Type, string? Summary, string? ThumbnailUrl, long? DurationMs, int? Year, string? ParentTitle, string? GrandparentTitle, int? Index, int? ParentIndex);
public record PlaybackInfoDto(string Url, string ContentType, Dictionary<string, string> Headers);

// Watch party DTOs
public record WatchPartyDto(Guid Id, Guid ChannelId, Guid MediaProviderConnectionId, string HostUserId, string ProviderItemId, string ItemTitle, string? ItemThumbnail, long? ItemDurationMs, double CurrentTimeMs, bool IsPlaying, DateTime LastSyncAt, List<QueueItemDto> Queue, DateTime StartedAt, string? ProviderType = null, string? PlaybackUrl = null);
public record YouTubeResolveDto(Guid ConnectionId, string VideoId, string Title, string ThumbnailUrl);
public record StartWatchPartyRequest(Guid MediaProviderConnectionId, string ProviderItemId, string ItemTitle, string? ItemThumbnail, long? ItemDurationMs);
public record QueueItemDto(string ProviderItemId, string Title, string? Thumbnail, long? DurationMs, string AddedByUserId);
public record AddToQueueRequest(string ProviderItemId, string Title, string? Thumbnail, long? DurationMs);
public record ReorderQueueRequest(List<int> NewOrder);

// User preferences DTOs
public record UserPreferencesDto(
    int InputMode,
    bool JoinMuted,
    bool JoinDeafened,
    double InputSensitivity,
    bool NoiseSuppression,
    bool EchoCancellation,
    bool AutoGainControl,
    string? UiPreferences,
    string? JoinSoundUrl,
    string? LeaveSoundUrl);
public class UpdateUserPreferencesRequest
{
    public int? InputMode { get; set; }
    public bool? JoinMuted { get; set; }
    public bool? JoinDeafened { get; set; }
    public double? InputSensitivity { get; set; }
    public bool? NoiseSuppression { get; set; }
    public bool? EchoCancellation { get; set; }
    public bool? AutoGainControl { get; set; }
    public string? UiPreferences { get; set; }
}
