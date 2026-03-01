using ImageMagick;
using Microsoft.Extensions.Caching.Memory;
using Abyss.Api.DTOs;

namespace Abyss.Api.Services;

public class ImageService
{
    private readonly string _webRoot;
    private readonly string _uploadsDir;
    private readonly string _emojisDir;
    private readonly string _videoPostersDir;
    private readonly IMemoryCache _cache;

    private static readonly HashSet<string> AllowedImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"
    };

    public ImageService(IWebHostEnvironment env, IMemoryCache cache)
    {
        var webRoot = env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot");
        _webRoot = webRoot;
        _uploadsDir = Path.Combine(webRoot, "uploads");
        _emojisDir = Path.Combine(webRoot, "uploads", "emojis");
        _videoPostersDir = Path.Combine(webRoot, "uploads", "video-posters");
        _cache = cache;
        Directory.CreateDirectory(_uploadsDir);
        Directory.CreateDirectory(_emojisDir);
        Directory.CreateDirectory(_videoPostersDir);
    }

    /// <summary>
    /// Validate that a file is a safe raster image (not SVG or other non-raster formats).
    /// </summary>
    public static string? ValidateImageFile(IFormFile file)
    {
        var ext = Path.GetExtension(file.FileName);
        if (string.IsNullOrEmpty(ext) || !AllowedImageExtensions.Contains(ext))
            return $"File type '{ext}' is not allowed. Only JPG, PNG, GIF, WebP, and BMP images are accepted.";

        using var stream = file.OpenReadStream();
        var detectedMime = MagicNumberValidator.DetectMimeType(stream);
        if (detectedMime != null && detectedMime.Equals("image/svg+xml", StringComparison.OrdinalIgnoreCase))
            return "SVG files are not allowed.";

        return null;
    }

    /// <summary>
    /// Process a general image upload: strip metadata and convert to WebP.
    /// </summary>
    public async Task<(string RelativePath, long Size, int Width, int Height)> ProcessImageAsync(IFormFile file, string? subdir = null)
    {
        var fileName = $"{Guid.NewGuid()}.webp";
        var (dirPath, urlPrefix) = ResolveUploadsSubdir(_uploadsDir, "/uploads", subdir);
        var filePath = Path.Combine(dirPath, fileName);

        using var input = file.OpenReadStream();
        int width;
        int height;

        if (file.ContentType.Equals("image/gif", StringComparison.OrdinalIgnoreCase))
        {
            using var frames = new MagickImageCollection();
            await frames.ReadAsync(input);

            frames.Coalesce();

            foreach (var frame in frames)
            {
                frame.Strip();
            }

            width = (int)frames[0].Width;
            height = (int)frames[0].Height;
            frames.OptimizePlus();
            await frames.WriteAsync(filePath, MagickFormat.WebP);
        }
        else
        {
            using var image = new MagickImage();
            await image.ReadAsync(input);

            image.Strip();
            image.Quality = 85;
            width = (int)image.Width;
            height = (int)image.Height;

            await image.WriteAsync(filePath, MagickFormat.WebP);
        }

        var size = new FileInfo(filePath).Length;

        return ($"{urlPrefix}/{fileName}", size, width, height);
    }

    public AttachmentDto EnrichAttachmentDimensions(AttachmentDto attachment)
    {
        if (!attachment.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return attachment;
        if (attachment.Width.HasValue && attachment.Height.HasValue)
            return attachment;

        var dims = TryGetStoredImageDimensions(attachment.FilePath);
        return dims is null
            ? attachment
            : attachment with { Width = dims.Value.Width, Height = dims.Value.Height };
    }

    public MessageDto EnrichAttachmentDimensions(MessageDto message)
    {
        if (message.Attachments.Count == 0)
            return message;

        return message with
        {
            Attachments = message.Attachments.Select(EnrichAttachmentDimensions).ToList(),
        };
    }

    public List<MessageDto> EnrichAttachmentDimensions(List<MessageDto> messages)
        => messages.Select(EnrichAttachmentDimensions).ToList();

    public List<PinnedMessageDto> EnrichAttachmentDimensions(List<PinnedMessageDto> pins)
        => pins.Select(pin => pin with { Message = EnrichAttachmentDimensions(pin.Message) }).ToList();

    /// <summary>
    /// Process an emoji upload: resize to 128x128 and convert to WebP.
    /// GIFs are handled frame-by-frame to preserve animation.
    /// </summary>
    public async Task<string> ProcessEmojiAsync(IFormFile file)
    {
        var fileName = $"{Guid.NewGuid()}.webp";
        var filePath = Path.Combine(_emojisDir, fileName);

        using var input = file.OpenReadStream();

        if (file.ContentType.Equals("image/gif", StringComparison.OrdinalIgnoreCase))
        {
            using var frames = new MagickImageCollection();
            await frames.ReadAsync(input);

            frames.Coalesce();

            foreach (var frame in frames)
            {
                frame.Resize(new MagickGeometry(128, 128) { IgnoreAspectRatio = false, FillArea = true });
                frame.Crop(128, 128, Gravity.Center);
                frame.ResetPage();
                frame.Strip();
            }

            frames.OptimizePlus();
            await frames.WriteAsync(filePath, MagickFormat.WebP);
        }
        else
        {
            using var image = new MagickImage();
            await image.ReadAsync(input);

            image.Resize(new MagickGeometry(128, 128) { IgnoreAspectRatio = false, FillArea = true });
            image.Crop(128, 128, Gravity.Center);
            image.ResetPage();
            image.Strip();
            image.Quality = 90;

            await image.WriteAsync(filePath, MagickFormat.WebP);
        }

        return $"/uploads/emojis/{fileName}";
    }

    /// <summary>
    /// Process an avatar upload: resize to 256x256 and convert to WebP.
    /// </summary>
    public async Task<string> ProcessAvatarAsync(IFormFile file)
    {
        var fileName = $"{Guid.NewGuid()}.webp";
        var filePath = Path.Combine(_uploadsDir, fileName);

        using var input = file.OpenReadStream();

        if (file.ContentType.Equals("image/gif", StringComparison.OrdinalIgnoreCase))
        {
            using var frames = new MagickImageCollection();
            await frames.ReadAsync(input);

            frames.Coalesce();

            foreach (var frame in frames)
            {
                frame.Resize(new MagickGeometry(256, 256) { IgnoreAspectRatio = false, FillArea = true });
                frame.Crop(256, 256, Gravity.Center);
                frame.ResetPage();
                frame.Strip();
            }

            frames.OptimizePlus();
            await frames.WriteAsync(filePath, MagickFormat.WebP);
        }
        else
        {
            using var image = new MagickImage();
            await image.ReadAsync(input);

            image.Resize(new MagickGeometry(256, 256) { IgnoreAspectRatio = false, FillArea = true });
            image.Crop(256, 256, Gravity.Center);
            image.ResetPage();
            image.Strip();
            image.Quality = 85;

            await image.WriteAsync(filePath, MagickFormat.WebP);
        }

        return $"/uploads/{fileName}";
    }

    /// <summary>
    /// Process a video poster image into WebP with a capped width.
    /// </summary>
    public async Task<(string RelativePath, long Size)> ProcessVideoPosterAsync(string sourcePath, int maxWidth = 320, string? subdir = null)
    {
        var fileName = $"{Guid.NewGuid()}.webp";
        var (dirPath, urlPrefix) = ResolveUploadsSubdir(_videoPostersDir, "/uploads/video-posters", subdir);
        var filePath = Path.Combine(dirPath, fileName);

        using var image = new MagickImage(sourcePath);
        if (image.Width > (uint)maxWidth)
        {
            image.Resize(new MagickGeometry((uint)maxWidth, 0u));
        }

        image.Strip();
        image.Quality = 80;

        await image.WriteAsync(filePath, MagickFormat.WebP);
        var size = new FileInfo(filePath).Length;

        return ($"{urlPrefix}/{fileName}", size);
    }

    private static (string DirPath, string UrlPrefix) ResolveUploadsSubdir(string baseDir, string baseUrl, string? subdir)
    {
        if (string.IsNullOrWhiteSpace(subdir))
        {
            Directory.CreateDirectory(baseDir);
            return (baseDir, baseUrl);
        }

        var trimmed = subdir.Trim().Trim('/', '\\');
        var urlSubdir = trimmed.Replace('\\', '/');
        var dirSubdir = trimmed
            .Replace('/', Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar);

        var dirPath = Path.Combine(baseDir, dirSubdir);
        Directory.CreateDirectory(dirPath);
        return (dirPath, $"{baseUrl}/{urlSubdir}");
    }

    private (int Width, int Height)? TryGetStoredImageDimensions(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
            return null;

        return _cache.GetOrCreate<(int Width, int Height)?>(GetAttachmentDimensionCacheKey(relativePath), entry =>
        {
            entry.Size = 1;
            entry.SlidingExpiration = TimeSpan.FromHours(12);

            try
            {
                var filePath = Path.Combine(
                    _webRoot,
                    relativePath.TrimStart('/', '\\')
                        .Replace('/', Path.DirectorySeparatorChar)
                        .Replace('\\', Path.DirectorySeparatorChar)
                );

                if (!File.Exists(filePath))
                    return null;

                var info = new MagickImageInfo(filePath);
                return ((int)info.Width, (int)info.Height);
            }
            catch
            {
                return null;
            }
        });
    }

    private static string GetAttachmentDimensionCacheKey(string relativePath)
        => $"attachment-dim:{relativePath}";
}
