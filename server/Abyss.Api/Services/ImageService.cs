using ImageMagick;

namespace Abyss.Api.Services;

public class ImageService
{
    private readonly string _uploadsDir;
    private readonly string _emojisDir;
    private readonly string _videoPostersDir;

    public ImageService(IWebHostEnvironment env)
    {
        var webRoot = env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot");
        _uploadsDir = Path.Combine(webRoot, "uploads");
        _emojisDir = Path.Combine(webRoot, "uploads", "emojis");
        _videoPostersDir = Path.Combine(webRoot, "uploads", "video-posters");
        Directory.CreateDirectory(_uploadsDir);
        Directory.CreateDirectory(_emojisDir);
        Directory.CreateDirectory(_videoPostersDir);
    }

    /// <summary>
    /// Process a general image upload: strip metadata and convert to WebP.
    /// </summary>
    public async Task<(string RelativePath, long Size)> ProcessImageAsync(IFormFile file, string? subdir = null)
    {
        var fileName = $"{Guid.NewGuid()}.webp";
        var (dirPath, urlPrefix) = ResolveUploadsSubdir(_uploadsDir, "/uploads", subdir);
        var filePath = Path.Combine(dirPath, fileName);

        using var input = file.OpenReadStream();

        if (file.ContentType.Equals("image/gif", StringComparison.OrdinalIgnoreCase))
        {
            using var frames = new MagickImageCollection();
            await frames.ReadAsync(input);

            foreach (var frame in frames)
            {
                frame.Strip();
            }

            frames.OptimizePlus();
            await frames.WriteAsync(filePath, MagickFormat.WebP);
        }
        else
        {
            using var image = new MagickImage();
            await image.ReadAsync(input);

            image.Strip();
            image.Quality = 85;

            await image.WriteAsync(filePath, MagickFormat.WebP);
        }

        var size = new FileInfo(filePath).Length;

        return ($"{urlPrefix}/{fileName}", size);
    }

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
}
