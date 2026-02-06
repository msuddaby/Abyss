namespace Abyss.Api.Models;

public enum AuditAction
{
    MessageDeleted,
    ChannelCreated,
    ChannelDeleted,
    MemberKicked,
    MemberPromoted,
    MemberDemoted,
    ServerDeleted,
    MemberBanned,
    MemberUnbanned,
    RoleCreated,
    RoleUpdated,
    RoleDeleted,
    MemberRolesUpdated
}

public class AuditLog
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public AuditAction Action { get; set; }
    public string ActorId { get; set; } = string.Empty;
    public AppUser Actor { get; set; } = null!;
    public string? TargetId { get; set; }
    public string? TargetName { get; set; }
    public string? Details { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
