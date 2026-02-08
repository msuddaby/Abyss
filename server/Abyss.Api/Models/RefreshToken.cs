using System.ComponentModel.DataAnnotations;

namespace Abyss.Api.Models;

public class RefreshToken
{
    [Key]
    public Guid Id { get; set; }
    [MaxLength(128)]
    public string TokenHash { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public Guid? ReplacedByTokenId { get; set; }
    public string UserId { get; set; } = string.Empty;
    public AppUser? User { get; set; }

    public bool IsActive => RevokedAt == null && ExpiresAt > DateTime.UtcNow;
}
