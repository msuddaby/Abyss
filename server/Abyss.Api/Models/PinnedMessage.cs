namespace Abyss.Api.Models;

public class PinnedMessage
{
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public Guid MessageId { get; set; }
    public Message Message { get; set; } = null!;
    public string PinnedById { get; set; } = string.Empty;
    public AppUser PinnedBy { get; set; } = null!;
    public DateTime PinnedAt { get; set; } = DateTime.UtcNow;
}
