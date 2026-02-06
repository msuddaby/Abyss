using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Abyss.Api.Data;
using Abyss.Api.Models;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class UploadController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IWebHostEnvironment _env;

    public UploadController(AppDbContext db, IWebHostEnvironment env)
    {
        _db = db;
        _env = env;
    }

    [HttpPost]
    public async Task<ActionResult> Upload(IFormFile file)
    {
        if (file.Length == 0) return BadRequest("No file");
        if (file.Length > 10 * 1024 * 1024) return BadRequest("File too large (max 10MB)");

        var uploadsDir = Path.Combine(_env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot"), "uploads");
        Directory.CreateDirectory(uploadsDir);

        var fileName = $"{Guid.NewGuid()}{Path.GetExtension(file.FileName)}";
        var filePath = Path.Combine(uploadsDir, fileName);

        using (var stream = new FileStream(filePath, FileMode.Create))
        {
            await file.CopyToAsync(stream);
        }

        var attachment = new Attachment
        {
            Id = Guid.NewGuid(),
            FileName = file.FileName,
            FilePath = $"/uploads/{fileName}",
            ContentType = file.ContentType,
            Size = file.Length,
        };
        _db.Attachments.Add(attachment);
        await _db.SaveChangesAsync();

        return Ok(new { id = attachment.Id.ToString(), url = attachment.FilePath, fileName = attachment.FileName, contentType = attachment.ContentType, size = attachment.Size });
    }
}
