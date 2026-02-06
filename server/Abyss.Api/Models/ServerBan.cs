namespace Abyss.Api.Models;

public class ServerBan
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public string BannedById { get; set; } = string.Empty;
    public AppUser BannedBy { get; set; } = null!;
    public string? Reason { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
