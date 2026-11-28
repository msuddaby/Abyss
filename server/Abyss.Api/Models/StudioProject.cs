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

/// <summary>
/// One accepted edit batch, with the exact ops that undo it (captured by the
/// server just before applying), so any collaborator's change can be reverted.
/// </summary>
public class StudioChange
{
    public long Id { get; set; }
    public Guid ProjectId { get; set; }
    public StudioProject Project { get; set; } = null!;
    /// <summary>Doc version this batch produced</summary>
    public long Version { get; set; }
    public string UserId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>"edit" or "restore" (a whole-doc replace; not revertible op by op)</summary>
    [MaxLength(16)]
    public string Kind { get; set; } = "edit";
    [MaxLength(300)]
    public string Summary { get; set; } = string.Empty;
    public int OpCount { get; set; }
    public string OpsJson { get; set; } = "[]";
    public string InverseJson { get; set; } = "[]";
}

/// <summary>A saved snapshot of the whole project (named by a user, or automatic).</summary>
public class StudioVersion
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public StudioProject Project { get; set; } = null!;
    [MaxLength(80)]
    public string Name { get; set; } = string.Empty;
    public bool Auto { get; set; }
    /// <summary>Null for automatic snapshots</summary>
    public string? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public long DocVersion { get; set; }
    public string DocJson { get; set; } = "{}";
}

/// <summary>
/// A saved instrument or effect setting, shared with everyone in the server's
/// studios (a server-wide preset library).
/// </summary>
public class StudioPreset
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public string CreatedById { get; set; } = string.Empty;
    /// <summary>"instrument" or "effect"</summary>
    [MaxLength(16)]
    public string Kind { get; set; } = "effect";
    /// <summary>Instrument / effect type, e.g. "synth", "delay"</summary>
    [MaxLength(24)]
    public string Type { get; set; } = string.Empty;
    [MaxLength(60)]
    public string Name { get; set; } = string.Empty;
    public string ParamsJson { get; set; } = "{}";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
