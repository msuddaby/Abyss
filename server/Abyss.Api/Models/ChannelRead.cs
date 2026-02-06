namespace Abyss.Api.Models;

public class ChannelRead
{
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public DateTime LastReadAt { get; set; } = DateTime.UtcNow;
}
