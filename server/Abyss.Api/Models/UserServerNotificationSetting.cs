namespace Abyss.Api.Models;

public class UserServerNotificationSetting
{
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public NotificationLevel? NotificationLevel { get; set; }
    public DateTime? MuteUntil { get; set; }
    public bool SuppressEveryone { get; set; }
}
