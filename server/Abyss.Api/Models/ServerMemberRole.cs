namespace Abyss.Api.Models;

public class ServerMemberRole
{
    public Guid ServerId { get; set; }
    public string UserId { get; set; } = string.Empty;
    public Guid RoleId { get; set; }
    public ServerMember Member { get; set; } = null!;
    public ServerRole Role { get; set; } = null!;
}
