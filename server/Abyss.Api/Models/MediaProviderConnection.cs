namespace Abyss.Api.Models;

public class MediaProviderConnection
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string OwnerId { get; set; } = string.Empty;
    public AppUser Owner { get; set; } = null!;
    public MediaProviderType ProviderType { get; set; }
    public string DisplayName { get; set; } = string.Empty;
    public string ProviderConfigJson { get; set; } = string.Empty;
    public DateTime LinkedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastValidatedAt { get; set; }
}
