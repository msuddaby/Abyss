namespace Abyss.Api.DTOs;

public record AppConfigDto(int MaxMessageLength, bool ForceRelayMode, UploadLimitsDto UploadLimits);

/// <summary>
/// Upload limits published to clients so they can validate before uploading.
/// Projected from MediaConfig so the two can never drift.
/// </summary>
/// <param name="MaxSizesByCategory">Category name ("image", "video", ...) to max size in bytes. Always contains "default".</param>
/// <param name="ExtensionCategories">Lower-case extension (".mp4") to its category, mirroring MediaConfig.ValidateExtension.</param>
/// <param name="EmojiMaxSize">Custom emoji upload limit, in bytes.</param>
/// <param name="SoundMaxSize">Soundboard clip and join/leave sound limit, in bytes.</param>
/// <param name="SoundMaxDurationSeconds">Maximum duration for soundboard and join/leave sounds.</param>
/// <param name="AvatarMaxSize">Profile avatar limit, in bytes.</param>
/// <param name="ServerIconMaxSize">Server icon limit, in bytes.</param>
public record UploadLimitsDto(
    Dictionary<string, long> MaxSizesByCategory,
    Dictionary<string, string> ExtensionCategories,
    long EmojiMaxSize,
    long SoundMaxSize,
    double SoundMaxDurationSeconds,
    long AvatarMaxSize,
    long ServerIconMaxSize);
