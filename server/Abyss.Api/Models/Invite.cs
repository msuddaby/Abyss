namespace Abyss.Api.Models;

public class Invite
{
    public Guid Id { get; set; }
    public string Code { get; set; } = string.Empty;
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string CreatorId { get; set; } = string.Empty;
    public AppUser Creator { get; set; } = null!;
    public DateTime? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public int Uses { get; set; }
}
