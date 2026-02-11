namespace Abyss.Api.Services;

/// <summary>
/// Centralized media upload configuration and validation.
/// Inspired by Matrix/Element's approach but adapted for centralized deployment.
/// </summary>
public class MediaConfig
{
    /// <summary>
    /// Emoji-specific upload limits.
    /// </summary>
    public long EmojiMaxSize { get; } = 256 * 1024; // 256KB

    /// <summary>
    /// Allowed emoji MIME types.
    /// </summary>
    public HashSet<string> EmojiAllowedMimeTypes { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/gif",
        "image/webp",
        "image/jpeg"
    };

    /// <summary>
    /// Allowed emoji file extensions.
    /// </summary>
    public HashSet<string> EmojiAllowedExtensions { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png",
        ".gif",
        ".webp",
        ".jpg",
        ".jpeg"
    };

    /// <summary>
    /// Per-category size limits in bytes.
    /// More granular than a single global limit.
    /// </summary>
    public Dictionary<string, long> MaxSizesByCategory { get; } = new()
    {
        ["image"] = 10 * 1024 * 1024,      // 10MB - images
        ["video"] = 200 * 1024 * 1024,     // 200MB - videos
        ["audio"] = 100 * 1024 * 1024,      // 100MB - audio
        ["document"] = 10 * 1024 * 1024,   // 10MB - documents
        ["archive"] = 50 * 1024 * 1024,    // 50MB - archives
        ["default"] = 10 * 1024 * 1024     // 10MB - fallback
    };

    /// <summary>
    /// Allowed file extensions mapped to their category and expected MIME type prefix.
    /// </summary>
    public Dictionary<string, (string Category, string MimePrefix)> AllowedExtensions { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        // Images (processed by ImageMagick)
        [".jpg"] = ("image", "image/"),
        [".jpeg"] = ("image", "image/"),
        [".png"] = ("image", "image/"),
        [".gif"] = ("image", "image/"),
        [".webp"] = ("image", "image/"),
        [".bmp"] = ("image", "image/"),

        // Documents
        [".svg"] = ("document", "image/svg"),
        [".pdf"] = ("document", "application/pdf"),
        [".txt"] = ("document", "text/"),
        [".md"] = ("document", "text/"),
        [".csv"] = ("document", "text/csv"),
        [".json"] = ("document", "application/json"),

        // Archives
        [".zip"] = ("archive", "application/"),
        [".tar"] = ("archive", "application/"),
        [".gz"] = ("archive", "application/"),
        [".7z"] = ("archive", "application/"),

        // Audio
        [".mp3"] = ("audio", "audio/"),
        [".wav"] = ("audio", "audio/"),
        [".ogg"] = ("audio", "audio/"),
        [".m4a"] = ("audio", "audio/"),
        [".flac"] = ("audio", "audio/"),

        // Video
        [".mp4"] = ("video", "video/"),
        [".webm"] = ("video", "video/"),
        [".mov"] = ("video", "video/"),
        [".avi"] = ("video", "video/"),
    };

    /// <summary>
    /// MIME types that are explicitly blocked (executables, scripts).
    /// </summary>
    public HashSet<string> BlockedMimeTypes { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        "application/x-msdownload",           // .exe
        "application/x-executable",           // executables
        "application/x-dosexec",              // DOS executables
        "application/x-sh",                   // shell scripts
        "application/x-shellscript",          // shell scripts
        "application/x-python-code",          // .pyc
        "application/x-javascript",           // .js (potential XSS)
        "text/javascript",                    // .js
        "application/x-perl",                 // perl scripts
        "application/x-php",                  // PHP scripts
    };

    /// <summary>
    /// Voice sound upload limits.
    /// </summary>
    public long SoundMaxSize { get; } = 2 * 1024 * 1024; // 2MB
    public double SoundMaxDurationSeconds { get; } = 5.0;
    public HashSet<string> SoundAllowedMimeTypes { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "audio/flac",
        "audio/mp4"
    };
    public HashSet<string> SoundAllowedExtensions { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp3",
        ".wav",
        ".ogg",
        ".flac",
        ".m4a"
    };

    /// <summary>
    /// Maximum decompressed size for archives (zip bomb protection).
    /// </summary>
    public long MaxDecompressedSize { get; } = 100 * 1024 * 1024; // 100MB

    /// <summary>
    /// Maximum compression ratio allowed (zip bomb protection).
    /// If compressed:decompressed ratio exceeds this, reject the file.
    /// </summary>
    public double MaxCompressionRatio { get; } = 100.0; // 100:1

    /// <summary>
    /// Validate file extension and return category and max size.
    /// </summary>
    public (bool IsValid, string? Category, long MaxSize) ValidateExtension(string extension)
    {
        if (string.IsNullOrEmpty(extension))
            return (false, null, 0);

        if (!AllowedExtensions.TryGetValue(extension, out var config))
            return (false, null, 0);

        var maxSize = MaxSizesByCategory.TryGetValue(config.Category, out var size)
            ? size
            : MaxSizesByCategory["default"];

        return (true, config.Category, maxSize);
    }

    /// <summary>
    /// Check if a MIME type is explicitly blocked.
    /// </summary>
    public bool IsMimeTypeBlocked(string mimeType)
    {
        return !string.IsNullOrEmpty(mimeType) && BlockedMimeTypes.Contains(mimeType);
    }

    /// <summary>
    /// Validate that detected MIME type matches expected prefix for extension.
    /// </summary>
    public bool MimeTypeMatchesExtension(string extension, string detectedMimeType)
    {
        if (!AllowedExtensions.TryGetValue(extension, out var config))
            return false;

        // Check if detected MIME starts with expected prefix
        return detectedMimeType.StartsWith(config.MimePrefix, StringComparison.OrdinalIgnoreCase);
    }
}
