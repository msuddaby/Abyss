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
    private static readonly HashSet<string> AllowedNonImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".pdf", ".zip", ".rar", ".7z", ".tar", ".gz",
        ".csv", ".json", ".md", ".log",
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".mp3", ".wav", ".ogg", ".m4a",
        ".mp4", ".mov", ".webm"
    };

    public UploadController(AppDbContext db, ImageService imageService)
    {
        _db = db;
        _imageService = imageService;
    }

    [HttpPost]
    public async Task<ActionResult> Upload(IFormFile file)
    {
        if (file.Length == 0) return BadRequest("No file");
        if (file.Length > 10 * 1024 * 1024) return BadRequest("File too large (max 10MB)");

        var isImage = file.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase);

        var attachmentId = Guid.NewGuid();
        string url;
        long size;

        if (isImage)
        {
            (url, size) = await _imageService.ProcessImageAsync(file);
        }
        else
        {
            var ext = Path.GetExtension(file.FileName);
            if (string.IsNullOrEmpty(ext) || !AllowedNonImageExtensions.Contains(ext))
                return BadRequest("Unsupported file type");

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

        var attachment = new Attachment
        {
            Id = attachmentId,
            FileName = file.FileName,
            FilePath = url,
            ContentType = isImage ? "image/webp" : "application/octet-stream",
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
        if (string.IsNullOrEmpty(ext) || !AllowedNonImageExtensions.Contains(ext))
            return NotFound();

        var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
        var filePath = Path.Combine(uploadsDir, $"{attachment.Id}{ext}");
        if (!System.IO.File.Exists(filePath)) return NotFound();

        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(System.IO.File.OpenRead(filePath), "application/octet-stream", attachment.FileName);
    }
}
