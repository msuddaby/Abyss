namespace Abyss.Api.Models;

public class ArchiveItem
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public Guid? AlbumId { get; set; }
    public ArchiveAlbum? Album { get; set; }
    public string UploaderId { get; set; } = string.Empty;
    public AppUser Uploader { get; set; } = null!;
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string FileName { get; set; } = string.Empty;
    /// <summary>
    /// Images: public static URL under /uploads/archive/... (webp, served from wwwroot).
    /// Videos: path relative to the content root (uploads/archive/{serverId}/{id}{ext}), served by ArchiveController.
    /// </summary>
    public string StoragePath { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public long Size { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public long? DurationMs { get; set; }
    public string? PosterPath { get; set; }
    public Guid? SourceAttachmentId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public bool IsVideo => ContentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase);
}
