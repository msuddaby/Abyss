namespace Abyss.Api.Models;

public class DevicePushToken
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public string Token { get; set; } = string.Empty;
    public string Platform { get; set; } = string.Empty; // "ios" or "android"
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
