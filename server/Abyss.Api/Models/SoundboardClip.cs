namespace Abyss.Api.Models;

public class SoundboardClip
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string Name { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string UploadedById { get; set; } = string.Empty;
    public AppUser UploadedBy { get; set; } = null!;
    public double Duration { get; set; }
    public long FileSize { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
