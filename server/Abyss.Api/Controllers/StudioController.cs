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
    public async Task<IActionResult> DeleteAsset(Guid channelId, Guid assetId, [FromQuery] bool force = false)
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
        // Saved versions keep working only while their audio exists: ask first.
        if (!force)
        {
            var inVersions = (await VersionDocsAsync(project.Id)).Count(d => StudioSessionService.DocReferences(d, assetId.ToString()));
            if (inVersions > 0)
                return Conflict(new { versions = inVersions, message = $"Saved versions ({inVersions}) use this audio; restoring them later would leave silent clips." });
        }

        _db.StudioAssets.Remove(asset);
        await _db.SaveChangesAsync();
        TryDeleteFile(asset.Url);

        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioAssetRemoved", channelId.ToString(), assetId.ToString());
        return Ok();
    }

    private async Task<List<string>> VersionDocsAsync(Guid projectId) =>
        await _db.StudioVersions.Where(v => v.ProjectId == projectId).Select(v => v.DocJson).ToListAsync();

    /// <summary>Where each asset is used: the live project and/or saved versions.</summary>
    [HttpGet("assets/usage")]
    public async Task<IActionResult> AssetUsage(Guid channelId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();
        var live = _studio.DocJson(channelId) ?? project.DocJson;
        var versions = await VersionDocsAsync(project.Id);
        var assets = await _db.StudioAssets.Where(a => a.ProjectId == project.Id).ToListAsync();
        return Ok(assets.Select(a =>
        {
            var id = a.Id.ToString();
            return new { id, inProject = StudioSessionService.DocReferences(live, id), versions = versions.Count(d => StudioSessionService.DocReferences(d, id)), fileSize = a.FileSize };
        }));
    }

    /// <summary>Deletes assets nothing uses (not the project, not any saved version). Own uploads, or all with ManageStudio.</summary>
    [HttpPost("assets/cleanup")]
    public async Task<IActionResult> CleanupAssets(Guid channelId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        var canManage = await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ManageStudio);
        var live = _studio.DocJson(channelId) ?? project.DocJson;
        var versions = await VersionDocsAsync(project.Id);
        var unused = (await _db.StudioAssets.Where(a => a.ProjectId == project.Id).ToListAsync())
            .Where(a => canManage || a.UploadedById == UserId)
            .Where(a => !StudioSessionService.DocReferences(live, a.Id.ToString()) && !versions.Any(d => StudioSessionService.DocReferences(d, a.Id.ToString())))
            .ToList();
        _db.StudioAssets.RemoveRange(unused);
        await _db.SaveChangesAsync();
        foreach (var a in unused)
        {
            TryDeleteFile(a.Url);
            await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioAssetRemoved", channelId.ToString(), a.Id.ToString());
        }
        return Ok(new { deleted = unused.Count, bytes = unused.Sum(a => a.FileSize) });
    }

    // ───────────── Presets (shared across the server's studios) ─────────────

    private static readonly HashSet<string> PresetKinds = new() { "instrument", "effect" };

    [HttpGet("presets")]
    public async Task<IActionResult> ListPresets(Guid channelId, [FromQuery] string kind, [FromQuery] string type)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();
        var list = await _db.StudioPresets
            .Where(p => p.ServerId == channel.ServerId && p.Kind == kind && p.Type == type)
            .OrderBy(p => p.Name)
            .Take(500)
            .ToListAsync();
        return Ok(list.Select(p => new { id = p.Id, name = p.Name, createdById = p.CreatedById, createdAt = p.CreatedAt, @params = System.Text.Json.JsonDocument.Parse(p.ParamsJson).RootElement }));
    }

    [HttpPost("presets")]
    public async Task<IActionResult> SavePreset(Guid channelId, [FromBody] SavePresetRequest req)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        var name = req.Name?.Trim() ?? "";
        if (name.Length is 0 or > 60) return BadRequest("Give the preset a name (up to 60 characters).");
        if (!PresetKinds.Contains(req.Kind) || string.IsNullOrEmpty(req.Type) || req.Type.Length > 24) return BadRequest("Unknown preset type.");
        if (req.Params.ValueKind != System.Text.Json.JsonValueKind.Object) return BadRequest("Invalid preset.");
        var json = req.Params.GetRawText();
        if (json.Length > 32 * 1024) return BadRequest("Preset is too large.");
        var count = await _db.StudioPresets.CountAsync(p => p.ServerId == channel.ServerId);
        if (count >= 2000) return BadRequest("This server has reached the preset limit.");
        var preset = new StudioPreset
        {
            Id = Guid.NewGuid(), ServerId = channel.ServerId!.Value, CreatedById = UserId,
            Kind = req.Kind, Type = req.Type, Name = name, ParamsJson = json,
        };
        _db.StudioPresets.Add(preset);
        await _db.SaveChangesAsync();
        return Ok(new { id = preset.Id, name = preset.Name, createdById = preset.CreatedById, createdAt = preset.CreatedAt, @params = req.Params });
    }

    [HttpDelete("presets/{presetId}")]
    public async Task<IActionResult> DeletePreset(Guid channelId, Guid presetId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();
        var preset = await _db.StudioPresets.FirstOrDefaultAsync(p => p.Id == presetId && p.ServerId == channel.ServerId);
        if (preset == null) return NotFound();
        var canManage = await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ManageStudio);
        if (preset.CreatedById != UserId && !canManage) return Forbid();
        _db.StudioPresets.Remove(preset);
        await _db.SaveChangesAsync();
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
            var (doc, version) = await _studio.ResetAsync(channelId, UserId);
            await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioReset", channelId.ToString(), doc, version);
        }
        finally
        {
            session.BroadcastGate.Release();
        }
        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioVersionsChanged", channelId.ToString());
        await _perms.LogAsync(channel.ServerId!.Value, AuditAction.ChannelUpdated, UserId,
            targetName: $"#{channel.Name}", details: "Studio project reset");
        return Ok();
    }

    // ───────────────────────── History & versions ─────────────────────────

    /// <summary>Edit history, newest first. Pages with <paramref name="before"/> (a change id).</summary>
    [HttpGet("history")]
    public async Task<IActionResult> History(Guid channelId, [FromQuery] long? before, [FromQuery] int limit = 100)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();
        // Make the last few seconds of edits visible too.
        await _studio.FlushDirtyAsync();
        limit = Math.Clamp(limit, 1, 200);
        var q = _db.StudioChanges.Where(c => c.ProjectId == project.Id);
        if (before != null) q = q.Where(c => c.Id < before);
        var rows = await q.OrderByDescending(c => c.Id).Take(limit)
            .Select(c => new { c.Id, c.Version, c.UserId, c.CreatedAt, c.Kind, c.Summary, c.OpCount })
            .ToListAsync();
        return Ok(rows);
    }

    /// <summary>
    /// What it takes to revert some changes: their combined inverse (newest
    /// first) plus their forward ops, so the client can spot later edits to the
    /// same things before applying the inverse as an ordinary edit.
    /// </summary>
    [HttpPost("history/revert")]
    public async Task<IActionResult> RevertOps(Guid channelId, [FromBody] RevertRequest req)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        if (req.Ids == null || req.Ids.Count == 0 || req.Ids.Count > 500) return BadRequest("Pick up to 500 changes.");
        await _studio.FlushDirtyAsync();
        var rows = await _db.StudioChanges
            .Where(c => c.ProjectId == project.Id && req.Ids.Contains(c.Id) && c.Kind == "edit")
            .OrderByDescending(c => c.Id)
            .Select(c => new { c.Id, c.OpsJson, c.InverseJson })
            .ToListAsync();
        var inverse = new System.Text.Json.Nodes.JsonArray();
        var forward = new System.Text.Json.Nodes.JsonArray();
        foreach (var r in rows)
            foreach (var op in System.Text.Json.Nodes.JsonNode.Parse(r.InverseJson)!.AsArray()) inverse.Add(op!.DeepClone());
        foreach (var r in rows.AsEnumerable().Reverse())
            foreach (var op in System.Text.Json.Nodes.JsonNode.Parse(r.OpsJson)!.AsArray()) forward.Add(op!.DeepClone());
        return Ok(new { ids = rows.Select(r => r.Id), inverse, forward, skipped = req.Ids.Count - rows.Count });
    }

    [HttpGet("versions")]
    public async Task<IActionResult> Versions(Guid channelId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();
        var rows = await _db.StudioVersions.Where(v => v.ProjectId == project.Id)
            .OrderByDescending(v => v.CreatedAt)
            .Select(v => new { v.Id, v.Name, v.Auto, v.CreatedById, v.CreatedAt, v.DocVersion })
            .ToListAsync();
        return Ok(rows);
    }

    /// <summary>A version's full doc (for comparing it with the live project).</summary>
    [HttpGet("versions/{versionId}")]
    public async Task<IActionResult> VersionDoc(Guid channelId, Guid versionId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.ViewChannel);
        if (channel == null || project == null) return NotFound();
        var json = await _db.StudioVersions.Where(v => v.Id == versionId && v.ProjectId == project.Id).Select(v => v.DocJson).FirstOrDefaultAsync();
        if (json == null) return NotFound();
        return Content(json, "application/json");
    }

    [HttpPost("versions")]
    public async Task<IActionResult> SaveVersion(Guid channelId, [FromBody] SaveVersionRequest req)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        var name = (req.Name ?? "").Trim();
        if (name.Length == 0 || name.Length > 80) return BadRequest("Give the version a name (up to 80 characters).");
        var v = await _studio.SaveVersionAsync(channelId, name, UserId);
        if (v == null) return BadRequest($"This project already has {StudioSessionService.MaxNamedSnapshots} saved versions. Delete some first.");
        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioVersionsChanged", channelId.ToString());
        return Ok(new { v.Id, v.Name, v.Auto, v.CreatedById, v.CreatedAt, v.DocVersion });
    }

    [HttpDelete("versions/{versionId}")]
    public async Task<IActionResult> DeleteVersion(Guid channelId, Guid versionId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        var v = await _db.StudioVersions.FirstOrDefaultAsync(x => x.Id == versionId && x.ProjectId == project.Id);
        if (v == null) return NotFound();
        var canManage = await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ManageStudio);
        if (v.CreatedById != UserId && !canManage) return Forbid();
        _db.StudioVersions.Remove(v);
        await _db.SaveChangesAsync();
        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioVersionsChanged", channelId.ToString());
        return Ok();
    }

    /// <summary>Replaces the project with a saved version (the current state is auto-saved first).</summary>
    [HttpPost("versions/{versionId}/restore")]
    public async Task<IActionResult> RestoreVersion(Guid channelId, Guid versionId)
    {
        var (channel, project) = await LoadAsync(channelId, Permission.EditStudio);
        if (channel == null || project == null) return Forbid();
        var v = await _db.StudioVersions.FirstOrDefaultAsync(x => x.Id == versionId && x.ProjectId == project.Id);
        if (v == null) return NotFound();
        if (System.Text.Json.Nodes.JsonNode.Parse(v.DocJson) is not System.Text.Json.Nodes.JsonObject doc) return BadRequest("That version is unreadable.");

        var label = v.Auto ? $"auto-save from {v.CreatedAt:u}" : $"\"{v.Name}\"";
        var session = await _studio.GetOrLoadAsync(channelId);
        await session.BroadcastGate.WaitAsync();
        try
        {
            var (live, version) = await _studio.ReplaceDocAsync(channelId, doc, UserId, $"Restored version {label}", $"Before restoring {label}");
            await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioReset", channelId.ToString(), live, version);
        }
        finally
        {
            session.BroadcastGate.Release();
        }
        await _hub.Clients.Group($"studio:{channelId}").SendAsync("StudioVersionsChanged", channelId.ToString());
        await _perms.LogAsync(channel.ServerId!.Value, AuditAction.ChannelUpdated, UserId,
            targetName: $"#{channel.Name}", details: $"Studio restored to version {label}");
        return Ok();
    }

    private static void TryDeleteFile(string url)
    {
        if (!url.StartsWith("/uploads/studio/")) return;
        var path = Path.Combine(Directory.GetCurrentDirectory(), "uploads", "studio", Path.GetFileName(url));
        try { System.IO.File.Delete(path); } catch { /* best effort */ }
    }
}

public record RevertRequest(List<long> Ids);
public record SaveVersionRequest(string? Name);
public record SavePresetRequest(string Kind, string Type, string? Name, System.Text.Json.JsonElement Params);
