using System.Security.Claims;
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
[Route("api/channels/{channelId}/studio")]
[Authorize]
public class StudioController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly MediaUploadService _mediaUploadService;
    private readonly StudioSessionService _studio;

    public StudioController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub, MediaUploadService mediaUploadService, StudioSessionService studio)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _mediaUploadService = mediaUploadService;
        _studio = studio;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private static StudioAssetDto ToDto(StudioAsset a) =>
        new(a.Id, a.Name, a.Url, a.DurationSec, a.FileSize, a.UploadedById, a.CreatedAt);

    private async Task<(Channel? Channel, StudioProject? Project)> LoadAsync(Guid channelId, Permission perm)
    {
        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.Type == ChannelType.Studio);
        if (channel?.ServerId == null) return (null, null);
        if (!await _perms.HasChannelPermissionAsync(channelId, UserId, perm)) return (null, null);
        // Ensures the project row exists (older channels or a missing row).
        await _studio.GetOrLoadAsync(channelId);
        var project = await _db.StudioProjects.FirstOrDefaultAsync(p => p.ChannelId == channelId);
        return (channel, project);
    }

    [HttpGet("assets")]
    public async Task<ActionResult<List<StudioAssetDto>>> ListAssets(Guid channelId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();

        var assets = await _db.StudioAssets
            .Where(a => a.ProjectId == project.Id)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync();
        return Ok(assets.Select(ToDto).ToList());
    }

    [HttpPost("assets")]
    [RequestSizeLimit(110 * 1024 * 1024)]
    public async Task<ActionResult<StudioAssetDto>> UploadAsset(Guid channelId, IFormFile file, [FromForm] string? name, [FromForm] double durationSec = 0)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        if (file == null || file.Length == 0) return BadRequest("No file provided.");

        var count = await _db.StudioAssets.CountAsync(a => a.ProjectId == project.Id);
        if (count >= 500) return BadRequest("This project has reached the 500 asset limit.");

        var (isValid, error, url, duration) = await _mediaUploadService.StoreStudioAudioAsync(file, durationSec);
        if (!isValid) return BadRequest(error);

        var displayName = string.IsNullOrWhiteSpace(name) ? Path.GetFileNameWithoutExtension(file.FileName) : name.Trim();
        if (displayName.Length > 100) displayName = displayName[..100];

        var asset = new StudioAsset
        {
            Id = Guid.NewGuid(),
            ProjectId = project.Id,
            ServerId = channel.ServerId!.Value,
            Name = displayName,
            Url = url!,
            DurationSec = duration,
            FileSize = file.Length,
            UploadedById = UserId,
        };
        _db.StudioAssets.Add(asset);
        await _db.SaveChangesAsync();

        var dto = ToDto(asset);
        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioAssetAdded", channelId.ToString(), dto);
        return Ok(dto);
    }

    [HttpDelete("assets/{assetId}")]
    public async Task<IActionResult> DeleteAsset(Guid channelId, Guid assetId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();

        var asset = await _db.StudioAssets.FirstOrDefaultAsync(a => a.Id == assetId && a.ProjectId == project.Id);
        if (asset == null) return NotFound();

        // Uploaders can remove their own assets; anyone else needs ManageStudio.
        var canManage = await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ManageStudio);
        if (asset.UploadedById != UserId && !canManage) return Forbid();
        if (_studio.IsAssetReferenced(channelId, assetId.ToString()))
            return BadRequest("This audio is used by clips in the project. Delete those clips first.");

        _db.StudioAssets.Remove(asset);
        await _db.SaveChangesAsync();
        TryDeleteFile(asset.Url);

        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioAssetRemoved", channelId.ToString(), assetId.ToString());
        return Ok();
    }

    [HttpPost("reset")]
    public async Task<IActionResult> ResetProject(Guid channelId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ManageStudio);
        if (channel == null || project == null) return Forbid();

        var session = await _studio.GetOrLoadAsync(channelId);
        await session.BroadcastGate.WaitAsync();
        try
        {
            var (doc, version) = await _studio.ResetAsync(channelId);
            await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioReset", channelId.ToString(), doc, version);
        }
        finally
        {
            session.BroadcastGate.Release();
        }
        await _perms.LogAsync(channel.ServerId!.Value, AuditAction.ChannelUpdated, UserId,
            targetName: $"#{channel.Name}", details: "Studio project reset");
        return Ok();
    }

    private static void TryDeleteFile(string url)
    {
        if (!url.StartsWith("/uploads/studio/")) return;
        var path = Path.Combine(Directory.GetCurrentDirectory(), "uploads", "studio", Path.GetFileName(url));
        try { System.IO.File.Delete(path); } catch { /* best effort */ }
    }
}
