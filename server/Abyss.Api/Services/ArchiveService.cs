using System.Diagnostics;
using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Models;
using Abyss.Api.Services.MediaProviders;

namespace Abyss.Api.Services;

/// <summary>
/// Storage and watch-party plumbing for the per-server Archive.
/// Images are converted to webp and served statically from wwwroot/uploads/archive/{serverId};
/// videos live under {contentRoot}/uploads/archive/{serverId} and are only reachable through
/// ArchiveController (membership-checked, range-enabled).
/// </summary>
public class ArchiveService
{
    private readonly AppDbContext _db;
    private readonly MediaValidator _validator;
    private readonly ImageService _imageService;
    private readonly VideoPosterService _posterService;
    private readonly ProviderConfigProtector _protector;
    private readonly ILogger<ArchiveService> _logger;

    public ArchiveService(AppDbContext db, MediaValidator validator, ImageService imageService,
        VideoPosterService posterService, ProviderConfigProtector protector, ILogger<ArchiveService> logger)
    {
        _db = db;
        _validator = validator;
        _imageService = imageService;
        _posterService = posterService;
        _protector = protector;
        _logger = logger;
    }

    public record StoredFile(string StoragePath, string ContentType, long Size, int? Width, int? Height, long? DurationMs, string? PosterPath);

    private static string Subdir(Guid serverId) => Path.Combine("archive", serverId.ToString());

    private static string VideoDir(Guid serverId)
    {
        var dir = Path.Combine(Directory.GetCurrentDirectory(), "uploads", Subdir(serverId));
        Directory.CreateDirectory(dir);
        return dir;
    }

    public static string FileUrl(ArchiveItem item) =>
        item.IsVideo ? $"/api/servers/{item.ServerId}/archive/items/{item.Id}/file" : item.StoragePath;

    public string? ResolveVideoPath(ArchiveItem item)
    {
        if (!item.IsVideo) return null;
        var root = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "uploads", "archive"));
        var full = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), item.StoragePath));
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? full : null;
    }

    public async Task<(string? Error, StoredFile? File)> StoreUploadAsync(IFormFile file, Guid itemId, Guid serverId)
    {
        var validation = await _validator.ValidateUploadAsync(file);
        if (!validation.IsValid) return (validation.ErrorMessage, null);

        if (validation.Category == "image")
        {
            var (url, size, w, h) = await _imageService.ProcessImageAsync(file, Subdir(serverId));
            return (null, new StoredFile(url, "image/webp", size, w, h, null, null));
        }

        if (validation.Category != "video")
            return ("Only images and videos can be added to the archive.", null);

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var fullPath = Path.Combine(VideoDir(serverId), $"{itemId}{ext}");
        await using (var fs = new FileStream(fullPath, FileMode.Create))
        {
            await file.CopyToAsync(fs);
        }

        var contentType = validation.DetectedMimeType ?? file.ContentType ?? "video/mp4";
        return (null, await FinishVideoAsync(fullPath, serverId, contentType, file.Length));
    }

    /// <summary>Copy a chat attachment's file into the archive so it outlives the message.</summary>
    public async Task<(string? Error, StoredFile? File)> CopyAttachmentAsync(Attachment attachment, Guid itemId, Guid serverId)
    {
        var isImage = attachment.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase);
        var isVideo = attachment.ContentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase);
        if (!isImage && !isVideo) return ("Only images and videos can be added to the archive.", null);

        if (isImage)
        {
            var src = _imageService.ResolveWebPath(attachment.FilePath);
            if (src == null || !File.Exists(src)) return ("Original file not found.", null);
            var destUrl = $"/uploads/archive/{serverId}/{itemId}{Path.GetExtension(src)}";
            var dest = _imageService.ResolveWebPath(destUrl)!;
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(src, dest, overwrite: false);
            return (null, new StoredFile(destUrl, attachment.ContentType, attachment.Size, attachment.Width, attachment.Height, null, null));
        }

        var ext = Path.GetExtension(attachment.FileName).ToLowerInvariant();
        var srcPath = ResolveAttachmentVideoPath(attachment, ext);
        if (srcPath == null) return ("Original file not found.", null);

        var fullPath = Path.Combine(VideoDir(serverId), $"{itemId}{ext}");
        File.Copy(srcPath, fullPath, overwrite: false);
        return (null, await FinishVideoAsync(fullPath, serverId, attachment.ContentType, attachment.Size));
    }

    private static string? ResolveAttachmentVideoPath(Attachment attachment, string ext)
    {
        var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
        var channel = attachment.Message?.Channel;
        var candidates = new List<string>();
        if (channel?.ServerId != null)
            candidates.Add(Path.Combine(uploadsDir, "servers", channel.ServerId.Value.ToString(), "channels", channel.Id.ToString(), $"{attachment.Id}{ext}"));
        candidates.Add(Path.Combine(uploadsDir, $"{attachment.Id}{ext}"));
        return candidates.FirstOrDefault(File.Exists);
    }

    private async Task<StoredFile> FinishVideoAsync(string fullPath, Guid serverId, string contentType, long size)
    {
        var poster = await _posterService.TryGeneratePosterAsync(fullPath, Subdir(serverId));
        var (durationMs, w, h) = await ProbeVideoAsync(fullPath);
        var relative = Path.GetRelativePath(Directory.GetCurrentDirectory(), fullPath);
        return new StoredFile(relative, contentType, size, w, h, durationMs, poster);
    }

    public void DeleteFiles(ArchiveItem item)
    {
        try
        {
            var main = item.IsVideo ? ResolveVideoPath(item) : _imageService.ResolveWebPath(item.StoragePath);
            if (main != null && File.Exists(main)) File.Delete(main);
            var poster = _imageService.ResolveWebPath(item.PosterPath);
            if (poster != null && File.Exists(poster)) File.Delete(poster);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to delete archive files for {ItemId}", item.Id);
        }
    }

    /// <summary>ffprobe duration (ms) and dimensions; all null if ffprobe is unavailable.</summary>
    private async Task<(long? DurationMs, int? Width, int? Height)> ProbeVideoAsync(string path)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffprobe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var a in new[] { "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "default=noprint_wrappers=1", path })
            psi.ArgumentList.Add(a);

        try
        {
            using var proc = Process.Start(psi);
            if (proc == null) return (null, null, null);
            var outputTask = proc.StandardOutput.ReadToEndAsync();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await proc.WaitForExitAsync(cts.Token);
            var output = await outputTask;

            long? duration = null; int? w = null, h = null;
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var kv = line.Split('=', 2);
                if (kv.Length != 2) continue;
                switch (kv[0])
                {
                    case "duration" when double.TryParse(kv[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var secs):
                        duration = (long)(secs * 1000); break;
                    case "width" when int.TryParse(kv[1], out var pw): w = pw; break;
                    case "height" when int.TryParse(kv[1], out var ph): h = ph; break;
                }
            }
            return (duration, w, h);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ffprobe failed for {Path}", path);
            return (null, null, null);
        }
    }

    /// <summary>
    /// Watch parties are keyed by a MediaProviderConnection; the archive gets one hidden
    /// connection per server (filtered out of the provider list).
    /// </summary>
    public async Task<MediaProviderConnection> GetOrCreateConnectionAsync(Guid serverId)
    {
        var existing = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.ServerId == serverId && c.ProviderType == MediaProviderType.Archive);
        if (existing != null) return existing;

        var ownerId = await _db.Servers.Where(s => s.Id == serverId).Select(s => s.OwnerId).FirstAsync();
        var conn = new MediaProviderConnection
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            OwnerId = ownerId,
            ProviderType = MediaProviderType.Archive,
            DisplayName = "Archive",
            ProviderConfigJson = _protector.Encrypt("{}"),
            LinkedAt = DateTime.UtcNow,
            LastValidatedAt = DateTime.UtcNow,
        };
        _db.MediaProviderConnections.Add(conn);
        await _db.SaveChangesAsync();
        return conn;
    }

    public static ArchiveItemDto ToDto(ArchiveItem i) => new(
        i.Id, i.ServerId, i.AlbumId, i.UploaderId,
        i.Uploader == null ? null : new UserDto(i.Uploader.Id, i.Uploader.UserName!, i.Uploader.DisplayName, i.Uploader.AvatarUrl, i.Uploader.Status, i.Uploader.Bio, i.Uploader.PresenceStatus),
        i.Title, i.Description, i.FileName, FileUrl(i), i.ContentType, i.Size, i.Width, i.Height, i.DurationMs, i.PosterPath, i.CreatedAt);

    public static string EncodeCursor(DateTime t) => t.Ticks.ToString(CultureInfo.InvariantCulture);

    public static DateTime? DecodeCursor(string? cursor) =>
        long.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)
            ? new DateTime(ticks, DateTimeKind.Utc)
            : null;
}
