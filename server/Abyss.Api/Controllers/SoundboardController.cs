using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/servers/{serverId}/soundboard")]
[Authorize]
public class SoundboardController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly MediaUploadService _mediaUploadService;

    private static readonly Regex NameRegex = new(@"^[a-zA-Z0-9_\- ]{2,32}$", RegexOptions.Compiled);
    private const int MaxClipsPerServer = 50;

    public SoundboardController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub, MediaUploadService mediaUploadService)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _mediaUploadService = mediaUploadService;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<SoundboardClipDto>>> ListClips(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var clips = await _db.SoundboardClips
            .Where(sc => sc.ServerId == serverId)
            .OrderBy(sc => sc.CreatedAt)
            .Select(sc => new SoundboardClipDto(sc.Id, sc.ServerId, sc.Name, sc.Url, sc.UploadedById, sc.Duration, sc.FileSize, sc.CreatedAt))
            .ToListAsync();
        return Ok(clips);
    }

    [HttpPost]
    public async Task<ActionResult<SoundboardClipDto>> UploadClip(Guid serverId, IFormFile file, [FromForm] string name)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageSoundboard)) return Forbid();

        if (string.IsNullOrWhiteSpace(name) || !NameRegex.IsMatch(name))
            return BadRequest("Clip name must be 2-32 characters, alphanumeric, spaces, hyphens, or underscores.");

        if (file == null || file.Length == 0)
            return BadRequest("No file provided.");

        var count = await _db.SoundboardClips.CountAsync(sc => sc.ServerId == serverId);
        if (count >= MaxClipsPerServer)
            return BadRequest($"Server has reached the maximum of {MaxClipsPerServer} soundboard clips.");

        var nameExists = await _db.SoundboardClips.AnyAsync(sc => sc.ServerId == serverId && sc.Name == name);
        if (nameExists)
            return BadRequest($"A clip with the name '{name}' already exists in this server.");

        var upload = await _mediaUploadService.StoreSoundAsync(file, "soundboard");
        if (!upload.IsValid || upload.Url is null)
            return BadRequest(upload.ErrorMessage);

        var clip = new SoundboardClip
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            Name = name,
            Url = upload.Url,
            UploadedById = UserId,
            Duration = upload.Duration,
            FileSize = file.Length,
            CreatedAt = DateTime.UtcNow,
        };
        _db.SoundboardClips.Add(clip);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.SoundboardClipUploaded, UserId, targetName: name);

        var dto = new SoundboardClipDto(clip.Id, clip.ServerId, clip.Name, clip.Url, clip.UploadedById, clip.Duration, clip.FileSize, clip.CreatedAt);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("SoundboardClipAdded", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpPatch("{clipId}")]
    public async Task<ActionResult<SoundboardClipDto>> RenameClip(Guid serverId, Guid clipId, RenameSoundboardClipRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageSoundboard)) return Forbid();

        var clip = await _db.SoundboardClips.FirstOrDefaultAsync(sc => sc.Id == clipId && sc.ServerId == serverId);
        if (clip == null) return NotFound();

        var nameExists = await _db.SoundboardClips.AnyAsync(sc => sc.ServerId == serverId && sc.Name == req.Name && sc.Id != clipId);
        if (nameExists)
            return BadRequest($"A clip with the name '{req.Name}' already exists in this server.");

        clip.Name = req.Name;
        await _db.SaveChangesAsync();

        var dto = new SoundboardClipDto(clip.Id, clip.ServerId, clip.Name, clip.Url, clip.UploadedById, clip.Duration, clip.FileSize, clip.CreatedAt);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("SoundboardClipUpdated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpDelete("{clipId}")]
    public async Task<IActionResult> DeleteClip(Guid serverId, Guid clipId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageSoundboard)) return Forbid();

        var clip = await _db.SoundboardClips.FirstOrDefaultAsync(sc => sc.Id == clipId && sc.ServerId == serverId);
        if (clip == null) return NotFound();

        // Delete file from disk
        if (!string.IsNullOrEmpty(clip.Url))
        {
            var filePath = Path.Combine(Directory.GetCurrentDirectory(), clip.Url.TrimStart('/'));
            if (System.IO.File.Exists(filePath))
                System.IO.File.Delete(filePath);
        }

        _db.SoundboardClips.Remove(clip);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.SoundboardClipDeleted, UserId, targetName: clip.Name);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("SoundboardClipRemoved", serverId.ToString(), clipId.ToString());
        return Ok();
    }
}
