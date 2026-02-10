using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
[EnableRateLimiting("upload")]
public class UploadController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly MediaConfig _mediaConfig;
    private readonly MediaUploadService _mediaUploadService;
    private readonly PermissionService _perms;

    public UploadController(AppDbContext db, MediaConfig mediaConfig, MediaUploadService mediaUploadService, PermissionService perms)
    {
        _db = db;
        _mediaConfig = mediaConfig;
        _mediaUploadService = mediaUploadService;
        _perms = perms;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpPost]
    public async Task<ActionResult> Upload(IFormFile file, [FromForm] Guid? serverId, [FromForm] Guid? channelId)
    {
        if (channelId is null)
            return BadRequest("ChannelId is required.");

        var channel = await _db.Channels
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == channelId.Value);

        if (channel is null)
            return BadRequest("Invalid channel.");

        if (channel.Type == ChannelType.DM)
        {
            if (serverId is not null)
                return BadRequest("ServerId is not valid for DM uploads.");

            if (channel.DmUser1Id != UserId && channel.DmUser2Id != UserId)
                return Forbid();
        }
        else
        {
            if (serverId is not null && channel.ServerId != serverId)
                return BadRequest("Channel does not belong to server.");

            if (!channel.ServerId.HasValue)
                return BadRequest("Channel is missing server.");

            if (!await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.ViewChannel))
                return Forbid();

            if (!await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.AttachFiles))
                return Forbid();
        }

        var effectiveServerId = channel.Type == ChannelType.DM ? null : channel.ServerId;

        var attachmentId = Guid.NewGuid();
        var upload = await _mediaUploadService.StoreAttachmentAsync(file, attachmentId, effectiveServerId, channel.Id);
        if (!upload.IsValid || upload.Result is null)
            return BadRequest(upload.ErrorMessage);

        // Store attachment metadata with detected MIME type
        var attachment = new Attachment
        {
            Id = attachmentId,
            FileName = file.FileName,
            FilePath = upload.Result.RelativeUrl,
            PosterPath = upload.Result.PosterPath,
            ContentType = upload.Result.ContentType,
            Size = upload.Result.Size,
        };
        _db.Attachments.Add(attachment);
        await _db.SaveChangesAsync();

        return Ok(new
        {
            id = attachment.Id.ToString(),
            url = attachment.FilePath,
            posterPath = attachment.PosterPath,
            fileName = attachment.FileName,
            contentType = attachment.ContentType,
            size = attachment.Size
        });
    }

    [HttpGet("{id:guid}")]
    [AllowAnonymous]
    public async Task<ActionResult> Download(Guid id)
    {
        var attachment = await _db.Attachments
            .Include(a => a.Message)
            .ThenInclude(m => m.Channel)
            .FirstOrDefaultAsync(a => a.Id == id);
        if (attachment is null) return NotFound();

        if (attachment.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return NotFound();

        var ext = Path.GetExtension(attachment.FileName);
        if (string.IsNullOrEmpty(ext))
            return NotFound();

        // Validate extension is still allowed (in case allowlist changed)
        var (isAllowed, category, _) = _mediaConfig.ValidateExtension(ext);
        if (!isAllowed)
            return NotFound();

        var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
        var channel = attachment.Message?.Channel;
        var subdir = BuildAttachmentSubdir(channel?.ServerId, channel?.Id);
        var filePath = string.IsNullOrWhiteSpace(subdir)
            ? Path.Combine(uploadsDir, $"{attachment.Id}{ext}")
            : Path.Combine(uploadsDir, subdir, $"{attachment.Id}{ext}");

        if (!System.IO.File.Exists(filePath))
        {
            // Backward compatibility for legacy flat uploads
            filePath = Path.Combine(uploadsDir, $"{attachment.Id}{ext}");
        }
        if (!System.IO.File.Exists(filePath)) return NotFound();

        // Matrix-inspired security headers
        Response.Headers["X-Content-Type-Options"] = "nosniff";

        if (category is "video" or "audio")
        {
            var safeName = SanitizeFileName(attachment.FileName);
            Response.Headers["Content-Disposition"] = $"inline; filename=\"{safeName}\"";
            var contentType = string.IsNullOrWhiteSpace(attachment.ContentType)
                ? "application/octet-stream"
                : attachment.ContentType;
            return PhysicalFile(filePath, contentType, enableRangeProcessing: true);
        }

        Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none';";
        Response.Headers["Content-Disposition"] = $"attachment; filename=\"{SanitizeFileName(attachment.FileName)}\"";
        return File(System.IO.File.OpenRead(filePath), "application/octet-stream");
    }

    /// <summary>
    /// Sanitize filename to prevent header injection attacks.
    /// </summary>
    private static string SanitizeFileName(string fileName)
    {
        // Remove any characters that could break headers
        return fileName.Replace("\"", "").Replace("\r", "").Replace("\n", "");
    }

    private static string? BuildAttachmentSubdir(Guid? serverId, Guid? channelId)
    {
        if (channelId is null)
            return null;

        if (serverId is null)
            return Path.Combine("dms", channelId.Value.ToString());

        return Path.Combine("servers", serverId.Value.ToString(), "channels", channelId.Value.ToString());
    }
}
