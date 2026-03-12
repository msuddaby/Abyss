namespace Abyss.Api.Services.MediaProviders;

public class YtDlpMediaProvider : IMediaProvider
{
    private readonly YtDlpService _ytDlp;

    public YtDlpMediaProvider(YtDlpService ytDlp)
    {
        _ytDlp = ytDlp;
    }

    public string GetProviderDisplayName() => "Direct Link (yt-dlp)";

    public string[] GetRequiredCredentialFields() => [];

    public Task<ProviderAuthResult> AuthenticateAsync(string configJson)
    {
        var available = _ytDlp.IsAvailable();
        return Task.FromResult(new ProviderAuthResult
        {
            Success = available,
            ServerName = "yt-dlp",
            ErrorMessage = available ? null : "yt-dlp binary not found on server PATH"
        });
    }

    public Task<bool> ValidateConnectionAsync(string configJson)
        => Task.FromResult(_ytDlp.IsAvailable());

    public Task<List<MediaLibrary>> GetLibrariesAsync(string configJson)
        => Task.FromResult(new List<MediaLibrary>());

    public Task<List<MediaItem>> GetLibraryItemsAsync(string configJson, string libraryId, int offset = 0, int limit = 50)
        => Task.FromResult(new List<MediaItem>());

    public Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId = null)
        => Task.FromResult(new List<MediaItem>());

    public async Task<MediaItem?> GetItemDetailsAsync(string configJson, string itemId)
    {
        // itemId is the URL for yt-dlp
        var meta = await _ytDlp.GetMetadataAsync(itemId);
        if (meta == null) return null;

        return new MediaItem
        {
            Id = itemId,
            Title = meta.Title,
            Type = "movie",
            ThumbnailUrl = meta.Thumbnail,
            DurationMs = meta.DurationMs,
        };
    }

    public Task<List<MediaItem>> GetItemChildrenAsync(string configJson, string itemId)
        => Task.FromResult(new List<MediaItem>());

    public async Task<PlaybackInfo?> GetPlaybackInfoAsync(string configJson, string itemId)
    {
        // itemId is the URL for yt-dlp
        var playback = await _ytDlp.GetPlaybackUrlAsync(itemId);
        if (playback == null) return null;

        return new PlaybackInfo
        {
            Url = playback.Url,
            ContentType = playback.ContentType,
            Headers = playback.Headers,
            AvailableQualities = []
        };
    }
}
