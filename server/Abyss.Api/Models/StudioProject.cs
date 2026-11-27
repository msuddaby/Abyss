using System.ComponentModel.DataAnnotations;

namespace Abyss.Api.Models;

/// <summary>
/// The persistent project behind a Studio channel. The arrangement lives in
/// <see cref="DocJson"/> (normalized tracks/clips maps); live edits are applied
/// in memory by StudioSessionService and flushed here periodically.
/// </summary>
public class StudioProject
{
    public Guid Id { get; set; }
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public string DocJson { get; set; } = "{}";
    public long Version { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class StudioAsset
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public StudioProject Project { get; set; } = null!;
    public Guid ServerId { get; set; }
    [MaxLength(100)]
    public string Name { get; set; } = string.Empty;
    [MaxLength(512)]
    public string Url { get; set; } = string.Empty;
    public double DurationSec { get; set; }
    public long FileSize { get; set; }
    public string UploadedById { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
