namespace Abyss.Api.DTOs;

public record AdminServerDto(Guid Id, string Name, string OwnerId, int MemberCount, int ChannelCount);
public record AdminUserDto(string Id, string Username, string DisplayName, string? Email, string Status);
public record AdminOverviewDto(List<AdminServerDto> Servers, List<AdminUserDto> Users);
public record InviteCodeDto(Guid Id, string Code, string? CreatedById, DateTime CreatedAt, DateTime? ExpiresAt, int? MaxUses, int Uses, DateTime? LastUsedAt);
public record AdminSettingsDto(bool InviteOnly, List<InviteCodeDto> Codes);
public record UpdateInviteOnlyRequest(bool InviteOnly);
public record CreateInviteCodeRequest(DateTime? ExpiresAt, int? MaxUses);
