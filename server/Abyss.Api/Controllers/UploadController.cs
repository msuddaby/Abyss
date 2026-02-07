using System.Security.Claims;
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
    private readonly ImageService _imageService;
    private readonly MediaValidator _mediaValidator;
    private readonly MediaConfig _mediaConfig;

    public UploadController(AppDbContext db, ImageService imageService, MediaValidator mediaValidator, MediaConfig mediaConfig)
    {
        _db = db;
        _imageService = imageService;
        _mediaValidator = mediaValidator;
        _mediaConfig = mediaConfig;
    }

    [HttpPost]
    public async Task<ActionResult> Upload(IFormFile file)
    {
        // 1. Comprehensive validation using our new MediaValidator
        var validation = await _mediaValidator.ValidateUploadAsync(file);
        if (!validation.IsValid)
        {
            return BadRequest(validation.ErrorMessage);
        }

        var ext = Path.GetExtension(file.FileName);
        var isImage = validation.Category == "image";

        var attachmentId = Guid.NewGuid();
        string url;
        long size;

        if (isImage)
        {
            // Process images through ImageMagick (strips metadata, re-encodes to WebP)
            (url, size) = await _imageService.ProcessImageAsync(file);
        }
        else
        {
            // Store non-image files as-is
            var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
            Directory.CreateDirectory(uploadsDir);

            var fileName = $"{attachmentId}{ext}";
            var filePath = Path.Combine(uploadsDir, fileName);

            using (var stream = new FileStream(filePath, FileMode.Create))
            {
                await file.CopyToAsync(stream);
            }

            url = $"/api/upload/{attachmentId}";
            size = file.Length;
        }

        // Store attachment metadata with detected MIME type
        var attachment = new Attachment
        {
            Id = attachmentId,
            FileName = file.FileName,
            FilePath = url,
            ContentType = isImage ? "image/webp" : (validation.DetectedMimeType ?? "application/octet-stream"),
            Size = size,
        };
        _db.Attachments.Add(attachment);
        await _db.SaveChangesAsync();

        return Ok(new { id = attachment.Id.ToString(), url = attachment.FilePath, fileName = attachment.FileName, contentType = attachment.ContentType, size = attachment.Size });
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
