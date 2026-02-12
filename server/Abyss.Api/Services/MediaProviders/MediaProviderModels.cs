namespace Abyss.Api.Services.MediaProviders;

public class ProviderAuthResult
{
    public bool Success { get; set; }
    public string? ServerName { get; set; }
    public string? ErrorMessage { get; set; }
}

public class MediaLibrary
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty; // movie, show, music, photo
    public int ItemCount { get; set; }
    public string? ThumbnailUrl { get; set; }
}

public class MediaItem
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty; // movie, episode, track, album
    public string? Summary { get; set; }
    public string? ThumbnailUrl { get; set; }
    public long? DurationMs { get; set; }
    public int? Year { get; set; }
    public string? ParentTitle { get; set; } // Show name for episodes, Artist for tracks
    public string? GrandparentTitle { get; set; } // Show name for episodes in a season
    public int? Index { get; set; } // Episode/track number
    public int? ParentIndex { get; set; } // Season number
    public double? Rating { get; set; }
    public string? ContentRating { get; set; }
    public string? Studio { get; set; }
}

public class PlaybackInfo
{
    public string Url { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public PlaybackQuality[] AvailableQualities { get; set; } = [];
    public Dictionary<string, string> Headers { get; set; } = new();
}

public class PlaybackQuality
{
    public string Id { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public int? Width { get; set; }
    public int? Height { get; set; }
    public int? Bitrate { get; set; }
}
