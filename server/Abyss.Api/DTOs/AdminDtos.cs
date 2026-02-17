using System.ComponentModel.DataAnnotations;
using Abyss.Api.Validation;

namespace Abyss.Api.DTOs;

public record AdminServerDto(
    Guid Id,
    string Name,
    string OwnerId,
    string OwnerName,
    int MemberCount,
    int ChannelCount,
    DateTime CreatedAt
);

public record AdminUserDto(
    string Id,
    string Username,
    string DisplayName,
    string? Email,
    string Status,
    string? AvatarUrl,
    DateTime CreatedAt
);

public record AdminServersResponse(List<AdminServerDto> Servers, int TotalCount);
public record AdminUsersResponse(List<AdminUserDto> Users, int TotalCount);
public record AdminOverviewStatsDto(int ServerCount, int UserCount, int MessageCount);

public record InviteCodeDto(Guid Id, string Code, string? CreatorId, DateTime CreatedAt, DateTime? ExpiresAt, int? MaxUses, int Uses, DateTime? LastUsedAt);
public record AdminSettingsDto(bool InviteOnly, int MaxMessageLength, List<InviteCodeDto> Codes);
public record UpdateInviteOnlyRequest(bool InviteOnly);
public record UpdateMaxMessageLengthRequest([Range(100, 10000)] int MaxMessageLength);
public record CreateInviteCodeRequest([FutureDate] DateTime? ExpiresAt, [Range(1, int.MaxValue)] int? MaxUses);
public record TransferServerOwnershipRequest([Required] string NewOwnerId);
