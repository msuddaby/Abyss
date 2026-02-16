using Microsoft.AspNetCore.Identity;

namespace Abyss.Api.Models;

public class AppUser : IdentityUser
{
    public string DisplayName { get; set; } = string.Empty;
    public string? AvatarUrl { get; set; }
    public string Status { get; set; } = string.Empty;
    public string Bio { get; set; } = string.Empty;
    public int PresenceStatus { get; set; } = 0; // 0=Online, 1=Away, 2=DoNotDisturb, 3=Invisible
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
