namespace Abyss.Api.Models;

public class ServerMember
{
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public bool IsOwner { get; set; }
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
    public ICollection<ServerMemberRole> MemberRoles { get; set; } = new List<ServerMemberRole>();
}
