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
public record ServerDto(Guid Id, string Name, string? IconUrl, string OwnerId, bool JoinLeaveMessagesEnabled, Guid? JoinLeaveChannelId);
public record CreateChannelRequest(string Name, string Type);
public record UpdateChannelRequest(string Name);
public record ReorderChannelsRequest(string Type, List<Guid> ChannelIds);
public record ChannelDto(Guid Id, string? Name, string Type, Guid? ServerId, int Position, long? Permissions = null);
public record ChannelPermissionOverrideDto(Guid RoleId, long Allow, long Deny);
public record ChannelPermissionsDto(List<ChannelPermissionOverrideDto> Overrides);
public record ServerMemberDto(Guid ServerId, string UserId, UserDto User, bool IsOwner, List<ServerRoleDto> Roles, DateTime JoinedAt);
public record ServerRoleDto(Guid Id, string Name, string Color, long Permissions, int Position, bool IsDefault, bool DisplaySeparately);
public record InviteDto(Guid Id, string Code, Guid ServerId, string CreatorId, DateTime? ExpiresAt, int? MaxUses, int Uses);
public record ReplyReferenceDto(Guid Id, string Content, string AuthorId, UserDto Author, bool IsDeleted);
public record MessageDto(Guid Id, string Content, string AuthorId, UserDto Author, Guid ChannelId, DateTime CreatedAt, List<AttachmentDto> Attachments, DateTime? EditedAt, bool IsDeleted, bool IsSystem, List<ReactionDto> Reactions, Guid? ReplyToMessageId, ReplyReferenceDto? ReplyTo);
public record PinnedMessageDto(MessageDto Message, DateTime PinnedAt, UserDto PinnedBy);
public record ReactionDto(Guid Id, Guid MessageId, string UserId, string Emoji);
public record AttachmentDto(Guid Id, Guid MessageId, string FileName, string FilePath, string ContentType, long Size);
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
