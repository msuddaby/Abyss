using System.Text.Json;
using System.Text.RegularExpressions;

namespace Abyss.Api.Services.MediaProviders;

public class YouTubeMediaProvider : IMediaProvider
{
    private readonly HttpClient _httpClient;

    private static readonly Regex[] VideoIdPatterns =
    [
        new(@"(?:youtube\.com/watch\?.*v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/|youtube\.com/live/)([a-zA-Z0-9_-]{11})", RegexOptions.Compiled)
    ];

    public YouTubeMediaProvider(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public static string? ExtractVideoId(string url)
    {
        foreach (var pattern in VideoIdPatterns)
        {
            var match = pattern.Match(url);
            if (match.Success) return match.Groups[1].Value;
        }
        return null;
    }

    public string GetProviderDisplayName() => "YouTube";
    public string[] GetRequiredCredentialFields() => [];

    public Task<ProviderAuthResult> AuthenticateAsync(string configJson)
        => Task.FromResult(new ProviderAuthResult { Success = true, ServerName = "YouTube" });

    public Task<bool> ValidateConnectionAsync(string configJson)
        => Task.FromResult(true);

    public Task<List<MediaLibrary>> GetLibrariesAsync(string configJson)
        => Task.FromResult(new List<MediaLibrary>());

    public Task<List<MediaItem>> GetLibraryItemsAsync(string configJson, string libraryId, int offset = 0, int limit = 50)
        => Task.FromResult(new List<MediaItem>());

    public Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId = null)
        => Task.FromResult(new List<MediaItem>());

    public Task<MediaItem?> GetItemDetailsAsync(string configJson, string itemId)
        => Task.FromResult<MediaItem?>(new MediaItem
        {
            Id = itemId,
            Title = itemId,
            Type = "movie",
            ThumbnailUrl = $"https://img.youtube.com/vi/{itemId}/hqdefault.jpg"
        });

    public Task<List<MediaItem>> GetItemChildrenAsync(string configJson, string itemId)
        => Task.FromResult(new List<MediaItem>());

    public Task<PlaybackInfo?> GetPlaybackInfoAsync(string configJson, string itemId)
        => Task.FromResult<PlaybackInfo?>(null);

    public async Task<(string VideoId, string Title, string ThumbnailUrl)?> ResolveUrlAsync(string url)
    {
        var videoId = ExtractVideoId(url);
        if (videoId == null) return null;

        var thumbnailUrl = $"https://img.youtube.com/vi/{videoId}/hqdefault.jpg";
        var title = videoId;

        try
        {
            var oembedUrl = $"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={videoId}&format=json";
            var response = await _httpClient.GetAsync(oembedUrl);
            if (response.IsSuccessStatusCode)
            {
                var json = await response.Content.ReadAsStringAsync();
                var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("title", out var titleProp))
                    title = titleProp.GetString() ?? videoId;
            }
        }
        catch
        {
            // oEmbed failed — fall back to videoId as title
        }

        return (videoId, title, thumbnailUrl);
    }
}
