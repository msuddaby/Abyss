namespace Abyss.Api.Models;

public class Invite
{
    public Guid Id { get; set; }
    public string Code { get; set; } = string.Empty;
    public Guid? ServerId { get; set; }
    public Server? Server { get; set; }
    public string? CreatorId { get; set; }
    public AppUser? Creator { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public int Uses { get; set; }
    public DateTime? LastUsedAt { get; set; }
    public bool AllowGuests { get; set; } = false;
}
