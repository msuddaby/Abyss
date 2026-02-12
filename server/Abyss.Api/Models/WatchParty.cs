namespace Abyss.Api.Models;

public class WatchParty
{
    public Guid Id { get; set; }
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public Guid MediaProviderConnectionId { get; set; }
    public MediaProviderConnection MediaProviderConnection { get; set; } = null!;
    public string HostUserId { get; set; } = string.Empty;
    public AppUser HostUser { get; set; } = null!;
    public string ProviderItemId { get; set; } = string.Empty;
    public string ItemTitle { get; set; } = string.Empty;
    public string? ItemThumbnail { get; set; }
    public long? ItemDurationMs { get; set; }
    public double CurrentTimeMs { get; set; }
    public bool IsPlaying { get; set; }
    public DateTime LastSyncAt { get; set; } = DateTime.UtcNow;
    public string QueueJson { get; set; } = "[]";
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
}
