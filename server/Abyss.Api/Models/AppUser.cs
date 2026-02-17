using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Identity;

namespace Abyss.Api.Models;

public class AppUser : IdentityUser
{
    [MaxLength(32)]
    public string DisplayName { get; set; } = string.Empty;
    public string? AvatarUrl { get; set; }
    [MaxLength(128)]
    public string Status { get; set; } = string.Empty;
    [MaxLength(500)]
    public string Bio { get; set; } = string.Empty;
    public int PresenceStatus { get; set; } = 0; // 0=Online, 1=Away, 2=DoNotDisturb, 3=Invisible
    public bool IsAutoAway { get; set; } = false;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
