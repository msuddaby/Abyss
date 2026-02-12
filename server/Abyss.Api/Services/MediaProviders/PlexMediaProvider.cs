using System.Text.Json;

namespace Abyss.Api.Services.MediaProviders;

public class PlexMediaProvider : IMediaProvider
{
    private readonly HttpClient _httpClient;
    private const string PlexClientId = "abyss-watch-party";

    public PlexMediaProvider(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public string GetProviderDisplayName() => "Plex";
    public string[] GetRequiredCredentialFields() => ["serverUrl", "authToken"];

    private (string serverUrl, string authToken) ParseConfig(string configJson)
    {
        var doc = JsonDocument.Parse(configJson);
        var serverUrl = doc.RootElement.GetProperty("serverUrl").GetString()!.TrimEnd('/');
        var authToken = doc.RootElement.GetProperty("authToken").GetString()!;
        return (serverUrl, authToken);
    }

    private HttpRequestMessage CreateRequest(string url, string token)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("X-Plex-Token", token);
        request.Headers.Add("X-Plex-Client-Identifier", PlexClientId);
        request.Headers.Add("Accept", "application/json");
        return request;
    }

    public async Task<ProviderAuthResult> AuthenticateAsync(string configJson)
    {
        try
        {
            var (serverUrl, authToken) = ParseConfig(configJson);
            var request = CreateRequest($"{serverUrl}/identity", authToken);
            var response = await _httpClient.SendAsync(request);
            if (!response.IsSuccessStatusCode)
                return new ProviderAuthResult { Success = false, ErrorMessage = $"Plex returned {response.StatusCode}" };

            var json = await response.Content.ReadAsStringAsync();
            var doc = JsonDocument.Parse(json);
            var serverName = doc.RootElement
                .GetProperty("MediaContainer")
                .GetProperty("machineIdentifier")
                .GetString();

            // Try to get friendly name
            string? friendlyName = null;
            if (doc.RootElement.GetProperty("MediaContainer").TryGetProperty("friendlyName", out var fn))
                friendlyName = fn.GetString();

            return new ProviderAuthResult
            {
                Success = true,
                ServerName = friendlyName ?? serverName ?? "Plex Server"
            };
        }
        catch (Exception ex)
        {
            return new ProviderAuthResult { Success = false, ErrorMessage = ex.Message };
        }
    }

    public async Task<bool> ValidateConnectionAsync(string configJson)
    {
        var result = await AuthenticateAsync(configJson);
        return result.Success;
    }

    public async Task<List<MediaLibrary>> GetLibrariesAsync(string configJson)
    {
        var (serverUrl, authToken) = ParseConfig(configJson);
        var request = CreateRequest($"{serverUrl}/library/sections", authToken);
        var response = await _httpClient.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync();
        var doc = JsonDocument.Parse(json);
        var directories = doc.RootElement
            .GetProperty("MediaContainer")
            .GetProperty("Directory");

        var libraries = new List<MediaLibrary>();
        foreach (var dir in directories.EnumerateArray())
        {
            libraries.Add(new MediaLibrary
            {
                Id = dir.GetProperty("key").GetString()!,
                Name = dir.GetProperty("title").GetString()!,
                Type = dir.GetProperty("type").GetString()!,
                ThumbnailUrl = dir.TryGetProperty("thumb", out var thumb)
                    ? $"{serverUrl}{thumb.GetString()}?X-Plex-Token={authToken}"
                    : null
            });
        }
        return libraries;
    }

    public async Task<List<MediaItem>> GetLibraryItemsAsync(string configJson, string libraryId, int offset = 0, int limit = 50)
    {
        var (serverUrl, authToken) = ParseConfig(configJson);
        var request = CreateRequest(
            $"{serverUrl}/library/sections/{libraryId}/all?X-Plex-Container-Start={offset}&X-Plex-Container-Size={limit}",
            authToken);
        var response = await _httpClient.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync();
        return ParseMetadataList(json, serverUrl, authToken);
    }

    public async Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId = null)
    {
        var (serverUrl, authToken) = ParseConfig(configJson);
        var url = libraryId != null
            ? $"{serverUrl}/library/sections/{libraryId}/search?type=1&type=4&query={Uri.EscapeDataString(query)}"
            : $"{serverUrl}/search?query={Uri.EscapeDataString(query)}";
        var request = CreateRequest(url, authToken);
        var response = await _httpClient.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync();
        return ParseMetadataList(json, serverUrl, authToken);
    }

    public async Task<MediaItem?> GetItemDetailsAsync(string configJson, string itemId)
    {
        var (serverUrl, authToken) = ParseConfig(configJson);
        var request = CreateRequest($"{serverUrl}/library/metadata/{itemId}", authToken);
        var response = await _httpClient.SendAsync(request);
        if (!response.IsSuccessStatusCode) return null;

        var json = await response.Content.ReadAsStringAsync();
        var items = ParseMetadataList(json, serverUrl, authToken);
        return items.FirstOrDefault();
    }

    public async Task<List<MediaItem>> GetItemChildrenAsync(string configJson, string itemId)
    {
        var (serverUrl, authToken) = ParseConfig(configJson);
        var request = CreateRequest($"{serverUrl}/library/metadata/{itemId}/children", authToken);
        var response = await _httpClient.SendAsync(request);
        if (!response.IsSuccessStatusCode) return new List<MediaItem>();

        var json = await response.Content.ReadAsStringAsync();
        return ParseMetadataList(json, serverUrl, authToken);
    }

    public async Task<PlaybackInfo?> GetPlaybackInfoAsync(string configJson, string itemId)
    {
        var (serverUrl, authToken) = ParseConfig(configJson);

        // Validate item exists
        var request = CreateRequest($"{serverUrl}/library/metadata/{itemId}", authToken);
        var response = await _httpClient.SendAsync(request);
        if (!response.IsSuccessStatusCode) return null;

        // Use Plex HLS transcode — direct-streams compatible tracks, transcodes the rest.
        // This guarantees browser-compatible audio (AAC) regardless of source codec.
        var sessionId = Guid.NewGuid().ToString("N");
        var encodedPath = Uri.EscapeDataString($"/library/metadata/{itemId}");
        var hlsUrl = $"{serverUrl}/video/:/transcode/universal/start.m3u8" +
            $"?path={encodedPath}" +
            $"&mediaIndex=0&partIndex=0" +
            $"&protocol=hls" +
            $"&session={sessionId}" +
            $"&directPlay=0&directStream=1&directStreamAudio=1" +
            $"&videoQuality=100&maxVideoBitrate=20000&audioBoost=100" +
            $"&location=lan&autoAdjustQuality=0" +
            $"&X-Plex-Token={authToken}" +
            $"&X-Plex-Client-Identifier={PlexClientId}" +
            $"&X-Plex-Product=Abyss&X-Plex-Platform=Chrome";

        return new PlaybackInfo
        {
            Url = hlsUrl,
            ContentType = "application/x-mpegURL",
            Headers = new Dictionary<string, string>()
        };
    }

    private List<MediaItem> ParseMetadataList(string json, string serverUrl, string authToken)
    {
        var doc = JsonDocument.Parse(json);
        var container = doc.RootElement.GetProperty("MediaContainer");

        if (!container.TryGetProperty("Metadata", out var metadata))
            return new List<MediaItem>();

        var items = new List<MediaItem>();
        foreach (var m in metadata.EnumerateArray())
        {
            var item = new MediaItem
            {
                Id = m.GetProperty("ratingKey").GetString()!,
                Title = m.GetProperty("title").GetString()!,
                Type = m.TryGetProperty("type", out var t) ? t.GetString()! : "unknown",
                Summary = m.TryGetProperty("summary", out var s) ? s.GetString() : null,
                DurationMs = m.TryGetProperty("duration", out var d) ? d.GetInt64() : null,
                Year = m.TryGetProperty("year", out var y) ? y.GetInt32() : null,
                ParentTitle = m.TryGetProperty("parentTitle", out var pt) ? pt.GetString() : null,
                GrandparentTitle = m.TryGetProperty("grandparentTitle", out var gpt) ? gpt.GetString() : null,
                Index = m.TryGetProperty("index", out var idx) ? idx.GetInt32() : null,
                ParentIndex = m.TryGetProperty("parentIndex", out var pidx) ? pidx.GetInt32() : null,
                Rating = m.TryGetProperty("rating", out var r) ? r.GetDouble() : null,
                ContentRating = m.TryGetProperty("contentRating", out var cr) ? cr.GetString() : null,
                Studio = m.TryGetProperty("studio", out var st) ? st.GetString() : null,
            };

            if (m.TryGetProperty("thumb", out var thumb))
                item.ThumbnailUrl = $"{serverUrl}{thumb.GetString()}?X-Plex-Token={authToken}";

            items.Add(item);
        }
        return items;
    }
}
