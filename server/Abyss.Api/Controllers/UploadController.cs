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

        string url;
        long size;

        if (isImage)
        {
            (url, size) = await _imageService.ProcessImageAsync(file);
        }
        else
        {
            var webRoot = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
            var uploadsDir = Path.Combine(webRoot, "uploads");
            Directory.CreateDirectory(uploadsDir);

            var fileName = $"{Guid.NewGuid()}{Path.GetExtension(file.FileName)}";
            var filePath = Path.Combine(uploadsDir, fileName);

            using (var stream = new FileStream(filePath, FileMode.Create))
            {
                await file.CopyToAsync(stream);
            }

            url = $"/uploads/{fileName}";
            size = file.Length;
        }

        var attachment = new Attachment
        {
            Id = Guid.NewGuid(),
            FileName = file.FileName,
            FilePath = url,
            ContentType = isImage ? "image/webp" : file.ContentType,
            Size = size,
        };
        _db.Attachments.Add(attachment);
        await _db.SaveChangesAsync();

        return Ok(new { id = attachment.Id.ToString(), url = attachment.FilePath, fileName = attachment.FileName, contentType = attachment.ContentType, size = attachment.Size });
    }
}
