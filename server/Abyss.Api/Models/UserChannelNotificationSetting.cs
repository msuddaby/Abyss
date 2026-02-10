namespace Abyss.Api.Models;

public class UserChannelNotificationSetting
{
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public NotificationLevel? NotificationLevel { get; set; }
    public DateTime? MuteUntil { get; set; }
}
