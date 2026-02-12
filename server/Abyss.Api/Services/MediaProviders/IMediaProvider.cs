namespace Abyss.Api.Services.MediaProviders;

public interface IMediaProvider
{
    string GetProviderDisplayName();
    string[] GetRequiredCredentialFields();
    Task<ProviderAuthResult> AuthenticateAsync(string configJson);
    Task<bool> ValidateConnectionAsync(string configJson);
    Task<List<MediaLibrary>> GetLibrariesAsync(string configJson);
    Task<List<MediaItem>> GetLibraryItemsAsync(string configJson, string libraryId, int offset = 0, int limit = 50);
    Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId = null);
    Task<MediaItem?> GetItemDetailsAsync(string configJson, string itemId);
    Task<List<MediaItem>> GetItemChildrenAsync(string configJson, string itemId);
    Task<PlaybackInfo?> GetPlaybackInfoAsync(string configJson, string itemId);
}
