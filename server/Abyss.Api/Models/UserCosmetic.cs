namespace Abyss.Api.Models;

public class UserCosmetic
{
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public Guid CosmeticItemId { get; set; }
    public CosmeticItem CosmeticItem { get; set; } = null!;
    public bool IsEquipped { get; set; }
    public DateTime AcquiredAt { get; set; } = DateTime.UtcNow;
}
