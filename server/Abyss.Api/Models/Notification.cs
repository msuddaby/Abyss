namespace Abyss.Api.Models;

public enum NotificationType
{
    UserMention,
    EveryoneMention,
    HereMention,
    ReplyMention,
    ServerMessage
}

public enum PushStatus
{
    None = 0,
    Pending = 1,
    Sent = 2,
    Failed = 3
}

public class Notification
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public Guid MessageId { get; set; }
    public Message Message { get; set; } = null!;
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public Guid? ServerId { get; set; }
    public Server? Server { get; set; }
    public NotificationType Type { get; set; }
    public bool IsRead { get; set; }
    public PushStatus PushStatus { get; set; } = PushStatus.None;
    public int PushAttempts { get; set; } = 0;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
