namespace Abyss.Api.Models;

public class CosmeticItem
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public CosmeticType Type { get; set; }
    public CosmeticRarity Rarity { get; set; }
    public string CssData { get; set; } = "{}";
    public string? PreviewImageUrl { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public ICollection<UserCosmetic> UserCosmetics { get; set; } = new List<UserCosmetic>();
}

public enum CosmeticType
{
    Nameplate = 0,
    MessageStyle = 1,
    ProfileEffect = 2,
    AvatarDecoration = 3,
}

public enum CosmeticRarity
{
    Common = 0,
    Uncommon = 1,
    Rare = 2,
    Epic = 3,
    Legendary = 4,
}
