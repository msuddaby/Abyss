using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/servers/{serverId}/archive")]
[Authorize]
public class ArchiveController : ControllerBase
{
    private const int MaxPageSize = 100;
    private const int MaxTitleLength = 120;
    private const int MaxDescriptionLength = 1000;
    private const int MaxAlbumNameLength = 48;

    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly ArchiveService _archive;
    private readonly TokenValidationParameters _mediaTokenParams;

    public ArchiveController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub,
        ArchiveService archive, IOptionsMonitor<JwtBearerOptions> jwtOptions)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _archive = archive;
        // Same rationale as MediaProvidersController: <video> can't send headers, so the
        // file endpoint takes ?token= and tolerates expiry for the length of a movie.
        _mediaTokenParams = jwtOptions.Get(JwtBearerDefaults.AuthenticationScheme).TokenValidationParameters.Clone();
        _mediaTokenParams.ClockSkew = TimeSpan.FromHours(6);
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private async Task<bool> CanModifyAsync(Guid serverId, string ownerId) =>
        ownerId == UserId || await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageArchive);

    private static string? CleanText(string? s, int max)
    {
        if (s == null) return null;
        var t = s.Trim();
        return t.Length > max ? t[..max] : t;
    }

    // ───────────── Albums ─────────────

    [HttpGet("albums")]
    public async Task<ActionResult<List<ArchiveAlbumDto>>> ListAlbums(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();
        return Ok(await BuildAlbumDtosAsync(serverId));
    }

    private async Task<List<ArchiveAlbumDto>> BuildAlbumDtosAsync(Guid serverId, Guid? onlyId = null)
    {
        var albums = await _db.ArchiveAlbums
            .Where(a => a.ServerId == serverId && (onlyId == null || a.Id == onlyId))
            .OrderBy(a => a.Name)
            .ToListAsync();

        var counts = await _db.ArchiveItems
            .Where(i => i.ServerId == serverId && i.AlbumId != null)
            .GroupBy(i => i.AlbumId!.Value)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Key, x => x.Count);

        var result = new List<ArchiveAlbumDto>();
        foreach (var a in albums)
        {
            var cover = a.CoverItemId != null
                ? await _db.ArchiveItems.FirstOrDefaultAsync(i => i.Id == a.CoverItemId && i.AlbumId == a.Id)
                : null;
            cover ??= await _db.ArchiveItems
                .Where(i => i.AlbumId == a.Id)
                .OrderByDescending(i => i.CreatedAt)
                .FirstOrDefaultAsync();
            var coverUrl = cover == null ? null : cover.IsVideo ? cover.PosterPath : cover.StoragePath;
            result.Add(new ArchiveAlbumDto(a.Id, a.ServerId, a.Name, a.CreatedById, a.CoverItemId, coverUrl,
                counts.GetValueOrDefault(a.Id), a.CreatedAt));
        }
        return result;
    }

    [HttpPost("albums")]
    public async Task<ActionResult<ArchiveAlbumDto>> CreateAlbum(Guid serverId, CreateArchiveAlbumRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.UploadToArchive)) return Forbid();
        var name = CleanText(req.Name, MaxAlbumNameLength);
        if (string.IsNullOrEmpty(name)) return BadRequest("Album name is required.");
        if (await _db.ArchiveAlbums.AnyAsync(a => a.ServerId == serverId && a.Name == name))
            return BadRequest("An album with that name already exists.");

        var album = new ArchiveAlbum { Id = Guid.NewGuid(), ServerId = serverId, Name = name, CreatedById = UserId };
        _db.ArchiveAlbums.Add(album);
        await _db.SaveChangesAsync();

        var dto = (await BuildAlbumDtosAsync(serverId, album.Id)).First();
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveAlbumsChanged", serverId.ToString());
        return Ok(dto);
    }

    [HttpPatch("albums/{albumId}")]
    public async Task<ActionResult<ArchiveAlbumDto>> UpdateAlbum(Guid serverId, Guid albumId, UpdateArchiveAlbumRequest req)
    {
        var album = await _db.ArchiveAlbums.FirstOrDefaultAsync(a => a.Id == albumId && a.ServerId == serverId);
        if (album == null) return NotFound();
        if (!await CanModifyAsync(serverId, album.CreatedById)) return Forbid();

        if (req.Name != null)
        {
            var name = CleanText(req.Name, MaxAlbumNameLength);
            if (string.IsNullOrEmpty(name)) return BadRequest("Album name is required.");
            if (await _db.ArchiveAlbums.AnyAsync(a => a.ServerId == serverId && a.Name == name && a.Id != albumId))
                return BadRequest("An album with that name already exists.");
            album.Name = name;
        }
        if (req.CoverItemId != null)
        {
            if (!await _db.ArchiveItems.AnyAsync(i => i.Id == req.CoverItemId && i.AlbumId == albumId))
                return BadRequest("Cover must be an item in this album.");
            album.CoverItemId = req.CoverItemId;
        }
        await _db.SaveChangesAsync();

        await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveAlbumsChanged", serverId.ToString());
        return Ok((await BuildAlbumDtosAsync(serverId, album.Id)).First());
    }

    /// <summary>Deleting an album keeps its items; they fall back to "no album".</summary>
    [HttpDelete("albums/{albumId}")]
    public async Task<IActionResult> DeleteAlbum(Guid serverId, Guid albumId)
    {
        var album = await _db.ArchiveAlbums.FirstOrDefaultAsync(a => a.Id == albumId && a.ServerId == serverId);
        if (album == null) return NotFound();
        if (!await CanModifyAsync(serverId, album.CreatedById)) return Forbid();

        await _db.ArchiveItems.Where(i => i.AlbumId == albumId)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.AlbumId, (Guid?)null));
        _db.ArchiveAlbums.Remove(album);
        await _db.SaveChangesAsync();

        await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveAlbumsChanged", serverId.ToString());
        return Ok();
    }

    // ───────────── Items ─────────────

    [HttpGet("items")]
    public async Task<ActionResult<ArchiveItemPageDto>> ListItems(Guid serverId,
        [FromQuery] Guid? albumId, [FromQuery] string? type, [FromQuery] string? q,
        [FromQuery] string? cursor, [FromQuery] string? sort, [FromQuery] int limit = 50)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();
        limit = Math.Clamp(limit, 1, MaxPageSize);

        var query = _db.ArchiveItems.Include(i => i.Uploader).Where(i => i.ServerId == serverId);
        if (albumId != null) query = query.Where(i => i.AlbumId == albumId);
        if (type == "video") query = query.Where(i => i.ContentType.StartsWith("video/"));
        else if (type == "image") query = query.Where(i => i.ContentType.StartsWith("image/"));
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = $"%{q.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";
            query = query.Where(i => EF.Functions.ILike(i.Title, pattern)
                || (i.Description != null && EF.Functions.ILike(i.Description, pattern))
                || EF.Functions.ILike(i.Uploader.DisplayName, pattern));
        }

        var oldestFirst = sort == "oldest";
        var after = ArchiveService.DecodeCursor(cursor);
        if (after != null)
            query = oldestFirst ? query.Where(i => i.CreatedAt > after) : query.Where(i => i.CreatedAt < after);
        query = oldestFirst ? query.OrderBy(i => i.CreatedAt) : query.OrderByDescending(i => i.CreatedAt);

        var items = await query.Take(limit + 1).ToListAsync();
        string? next = null;
        if (items.Count > limit)
        {
            items.RemoveAt(limit);
            next = ArchiveService.EncodeCursor(items[^1].CreatedAt);
        }
        return Ok(new ArchiveItemPageDto(items.Select(ArchiveService.ToDto).ToList(), next));
    }

    [HttpPost("items")]
    [EnableRateLimiting("upload")]
    public async Task<ActionResult<ArchiveItemDto>> UploadItem(Guid serverId, IFormFile file,
        [FromForm] string? title, [FromForm] string? description, [FromForm] Guid? albumId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.UploadToArchive)) return Forbid();
        if (file == null || file.Length == 0) return BadRequest("No file provided.");
        if (albumId != null && !await _db.ArchiveAlbums.AnyAsync(a => a.Id == albumId && a.ServerId == serverId))
            return BadRequest("Invalid album.");

        var id = Guid.NewGuid();
        var (error, stored) = await _archive.StoreUploadAsync(file, id, serverId);
        if (stored == null) return BadRequest(error);

        var item = new ArchiveItem
        {
            Id = id,
            ServerId = serverId,
            AlbumId = albumId,
            UploaderId = UserId,
            Title = CleanText(title, MaxTitleLength) is { Length: > 0 } t ? t : CleanText(Path.GetFileNameWithoutExtension(file.FileName), MaxTitleLength)!,
            Description = CleanText(description, MaxDescriptionLength) is { Length: > 0 } d ? d : null,
            FileName = file.FileName,
            StoragePath = stored.StoragePath,
            ContentType = stored.ContentType,
            Size = stored.Size,
            Width = stored.Width,
            Height = stored.Height,
            DurationMs = stored.DurationMs,
            PosterPath = stored.PosterPath,
            CreatedAt = DateTime.UtcNow,
        };
        return await SaveNewItemAsync(item);
    }

    [HttpPost("items/from-attachment/{attachmentId}")]
    public async Task<ActionResult<ArchiveItemDto>> SaveFromAttachment(Guid serverId, Guid attachmentId, SaveAttachmentToArchiveRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.UploadToArchive)) return Forbid();

        var attachment = await _db.Attachments
            .Include(a => a.Message).ThenInclude(m => m!.Channel)
            .FirstOrDefaultAsync(a => a.Id == attachmentId);
        var channel = attachment?.Message?.Channel;
        if (attachment == null || channel == null || channel.ServerId != serverId || attachment.Message!.IsDeleted)
            return NotFound();
        if (!await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.ViewChannel)
            || !await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.ReadMessageHistory))
            return Forbid();
        if (req.AlbumId != null && !await _db.ArchiveAlbums.AnyAsync(a => a.Id == req.AlbumId && a.ServerId == serverId))
            return BadRequest("Invalid album.");
        if (await _db.ArchiveItems.AnyAsync(i => i.ServerId == serverId && i.SourceAttachmentId == attachmentId))
            return BadRequest("That file is already in the archive.");

        var id = Guid.NewGuid();
        var (error, stored) = await _archive.CopyAttachmentAsync(attachment, id, serverId);
        if (stored == null) return BadRequest(error);

        var item = new ArchiveItem
        {
            Id = id,
            ServerId = serverId,
            AlbumId = req.AlbumId,
            UploaderId = UserId,
            Title = CleanText(req.Title, MaxTitleLength) is { Length: > 0 } t ? t : CleanText(Path.GetFileNameWithoutExtension(attachment.FileName), MaxTitleLength)!,
            FileName = attachment.FileName,
            StoragePath = stored.StoragePath,
            ContentType = stored.ContentType,
            Size = stored.Size,
            Width = stored.Width,
            Height = stored.Height,
            DurationMs = stored.DurationMs,
            PosterPath = stored.PosterPath,
            SourceAttachmentId = attachmentId,
            CreatedAt = DateTime.UtcNow,
        };
        return await SaveNewItemAsync(item);
    }

    private async Task<ActionResult<ArchiveItemDto>> SaveNewItemAsync(ArchiveItem item)
    {
        _db.ArchiveItems.Add(item);
        await _db.SaveChangesAsync();
        await _db.Entry(item).Reference(i => i.Uploader).LoadAsync();

        await _perms.LogAsync(item.ServerId, AuditAction.ArchiveItemUploaded, UserId, targetId: item.Id.ToString(), targetName: item.Title);

        var dto = ArchiveService.ToDto(item);
        await _hub.Clients.Group($"server:{item.ServerId}").SendAsync("ArchiveItemAdded", item.ServerId.ToString(), dto);
        if (item.AlbumId != null)
            await _hub.Clients.Group($"server:{item.ServerId}").SendAsync("ArchiveAlbumsChanged", item.ServerId.ToString());
        return Ok(dto);
    }

    [HttpPatch("items/{itemId}")]
    public async Task<ActionResult<ArchiveItemDto>> UpdateItem(Guid serverId, Guid itemId, UpdateArchiveItemRequest req)
    {
        var item = await _db.ArchiveItems.Include(i => i.Uploader).FirstOrDefaultAsync(i => i.Id == itemId && i.ServerId == serverId);
        if (item == null) return NotFound();
        if (!await CanModifyAsync(serverId, item.UploaderId)) return Forbid();

        var albumChanged = false;
        if (req.Title != null)
        {
            var title = CleanText(req.Title, MaxTitleLength);
            if (string.IsNullOrEmpty(title)) return BadRequest("Title is required.");
            item.Title = title;
        }
        if (req.Description != null)
            item.Description = CleanText(req.Description, MaxDescriptionLength) is { Length: > 0 } d ? d : null;
        if (req.ClearAlbum)
        {
            albumChanged = item.AlbumId != null;
            item.AlbumId = null;
        }
        else if (req.AlbumId != null && req.AlbumId != item.AlbumId)
        {
            if (!await _db.ArchiveAlbums.AnyAsync(a => a.Id == req.AlbumId && a.ServerId == serverId))
                return BadRequest("Invalid album.");
            item.AlbumId = req.AlbumId;
            albumChanged = true;
        }
        await _db.SaveChangesAsync();

        var dto = ArchiveService.ToDto(item);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveItemUpdated", serverId.ToString(), dto);
        if (albumChanged)
            await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveAlbumsChanged", serverId.ToString());
        return Ok(dto);
    }

    [HttpDelete("items/{itemId}")]
    public async Task<IActionResult> DeleteItem(Guid serverId, Guid itemId)
    {
        var item = await _db.ArchiveItems.FirstOrDefaultAsync(i => i.Id == itemId && i.ServerId == serverId);
        if (item == null) return NotFound();
        if (!await CanModifyAsync(serverId, item.UploaderId)) return Forbid();

        await _db.ArchiveAlbums.Where(a => a.CoverItemId == itemId)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.CoverItemId, (Guid?)null));
        _db.ArchiveItems.Remove(item);
        await _db.SaveChangesAsync();
        _archive.DeleteFiles(item);

        await _perms.LogAsync(serverId, AuditAction.ArchiveItemDeleted, UserId, targetId: item.Id.ToString(), targetName: item.Title);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveItemDeleted", serverId.ToString(), itemId.ToString());
        if (item.AlbumId != null)
            await _hub.Clients.Group($"server:{serverId}").SendAsync("ArchiveAlbumsChanged", serverId.ToString());
        return Ok();
    }

    /// <summary>Video bytes (range-enabled). Images are served statically from /uploads/archive.</summary>
    [AllowAnonymous]
    [HttpGet("items/{itemId}/file")]
    public async Task<IActionResult> GetFile(Guid serverId, Guid itemId, [FromQuery] string? token = null)
    {
        var userId = ResolveMediaUserId(token);
        if (userId == null) return Unauthorized();
        if (!await _perms.IsMemberAsync(serverId, userId)) return Forbid();

        var item = await _db.ArchiveItems.AsNoTracking().FirstOrDefaultAsync(i => i.Id == itemId && i.ServerId == serverId);
        if (item == null || !item.IsVideo) return NotFound();
        var path = _archive.ResolveVideoPath(item);
        if (path == null || !System.IO.File.Exists(path)) return NotFound();

        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return PhysicalFile(path, item.ContentType, enableRangeProcessing: true);
    }

    private string? ResolveMediaUserId(string? token)
    {
        if (string.IsNullOrEmpty(token))
            return User.FindFirstValue(ClaimTypes.NameIdentifier);
        try
        {
            var principal = new JwtSecurityTokenHandler().ValidateToken(token, _mediaTokenParams, out _);
            return principal.FindFirstValue(ClaimTypes.NameIdentifier);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>The hidden media-provider connection that watch parties use for archive videos.</summary>
    [HttpGet("connection")]
    public async Task<ActionResult<object>> GetConnection(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();
        var conn = await _archive.GetOrCreateConnectionAsync(serverId);
        return Ok(new { connectionId = conn.Id });
    }

    // ───────────── Chat gallery ─────────────

    [HttpGet("gallery")]
    public async Task<ActionResult<GalleryPageDto>> Gallery(Guid serverId,
        [FromQuery] Guid? channelId, [FromQuery] string? type, [FromQuery] string? cursor, [FromQuery] int limit = 60)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();
        limit = Math.Clamp(limit, 1, MaxPageSize);

        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverId && (channelId == null || c.Id == channelId))
            .Select(c => c.Id)
            .ToListAsync();
        const long needed = (long)(Permission.ViewChannel | Permission.ReadMessageHistory);
        var visible = new List<Guid>();
        foreach (var id in channelIds)
        {
            var perms = await _perms.GetChannelPermissionsAsync(id, UserId);
            if ((perms & needed) == needed) visible.Add(id);
        }
        if (visible.Count == 0) return Ok(new GalleryPageDto(new(), null));

        var query = _db.Attachments
            .Where(a => a.Message != null && visible.Contains(a.Message.ChannelId) && !a.Message.IsDeleted);
        query = type switch
        {
            "video" => query.Where(a => a.ContentType.StartsWith("video/")),
            "image" => query.Where(a => a.ContentType.StartsWith("image/")),
            _ => query.Where(a => a.ContentType.StartsWith("image/") || a.ContentType.StartsWith("video/")),
        };
        var before = ArchiveService.DecodeCursor(cursor);
        if (before != null) query = query.Where(a => a.Message!.CreatedAt < before);

        var rows = await query
            .OrderByDescending(a => a.Message!.CreatedAt)
            .Take(limit + 1)
            .Select(a => new
            {
                a.Id, a.MessageId, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size, a.Width, a.Height,
                a.Message!.ChannelId, ChannelName = a.Message.Channel.Name, a.Message.CreatedAt,
                Author = a.Message.Author,
            })
            .ToListAsync();

        string? next = null;
        if (rows.Count > limit)
        {
            rows.RemoveAt(limit);
            next = ArchiveService.EncodeCursor(rows[^1].CreatedAt);
        }

        var items = rows.Select(r => new GalleryItemDto(
            r.Id, r.MessageId!.Value, r.ChannelId, r.ChannelName ?? "",
            new UserDto(r.Author.Id, r.Author.UserName!, r.Author.DisplayName, r.Author.AvatarUrl, r.Author.Status, r.Author.Bio, r.Author.PresenceStatus),
            r.FileName, r.FilePath, r.PosterPath, r.ContentType, r.Size, r.Width, r.Height, r.CreatedAt)).ToList();
        return Ok(new GalleryPageDto(items, next));
    }
}
