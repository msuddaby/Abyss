using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Abyss.Api.Data;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class UploadController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly MediaConfig _mediaConfig;
    private readonly MediaUploadService _mediaUploadService;

    public UploadController(AppDbContext db, MediaConfig mediaConfig, MediaUploadService mediaUploadService)
    {
        _db = db;
        _mediaConfig = mediaConfig;
        _mediaUploadService = mediaUploadService;
    }

    [HttpPost]
    public async Task<ActionResult> Upload(IFormFile file)
    {
        var attachmentId = Guid.NewGuid();
        var upload = await _mediaUploadService.StoreAttachmentAsync(file, attachmentId);
        if (!upload.IsValid || upload.Result is null)
            return BadRequest(upload.ErrorMessage);

        // Store attachment metadata with detected MIME type
        var attachment = new Attachment
        {
            Id = attachmentId,
            FileName = file.FileName,
            FilePath = upload.Result.RelativeUrl,
            ContentType = upload.Result.ContentType,
            Size = upload.Result.Size,
        };
        _db.Attachments.Add(attachment);
        await _db.SaveChangesAsync();

        return Ok(new
        {
            id = attachment.Id.ToString(),
            url = attachment.FilePath,
            fileName = attachment.FileName,
            contentType = attachment.ContentType,
            size = attachment.Size
        });
    }

    [HttpGet("{id:guid}")]
    [AllowAnonymous]
    public async Task<ActionResult> Download(Guid id)
    {
        var attachment = await _db.Attachments.FindAsync(id);
        if (attachment is null) return NotFound();

        if (attachment.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return NotFound();

        var ext = Path.GetExtension(attachment.FileName);
        if (string.IsNullOrEmpty(ext))
            return NotFound();

        // Validate extension is still allowed (in case allowlist changed)
        var (isAllowed, _, _) = _mediaConfig.ValidateExtension(ext);
        if (!isAllowed)
            return NotFound();

        var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
        var filePath = Path.Combine(uploadsDir, $"{attachment.Id}{ext}");
        if (!System.IO.File.Exists(filePath)) return NotFound();

        // Matrix-inspired security headers
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none';";
        Response.Headers["X-Content-Type-Options"] = "nosniff";

        // Force download, never inline (prevents XSS via SVG, HTML, etc.)
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
}
