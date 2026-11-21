namespace Abyss.Api.Models;

public class ArchiveAlbum
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string Name { get; set; } = string.Empty;
    public string CreatedById { get; set; } = string.Empty;
    public AppUser CreatedBy { get; set; } = null!;
    public Guid? CoverItemId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
