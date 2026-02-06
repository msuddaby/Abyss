using Microsoft.AspNetCore.Identity;

namespace Abyss.Api.Models;

public class AppUser : IdentityUser
{
    public string DisplayName { get; set; } = string.Empty;
    public string? AvatarUrl { get; set; }
    public string Status { get; set; } = "Online";
    public string Bio { get; set; } = string.Empty;
}
