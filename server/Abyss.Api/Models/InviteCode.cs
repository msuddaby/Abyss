namespace Abyss.Api.Models;

public class InviteCode
{
    public Guid Id { get; set; }
    public string Code { get; set; } = string.Empty;
    public string? CreatedById { get; set; }
    public AppUser? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public int Uses { get; set; }
    public DateTime? LastUsedAt { get; set; }
}
