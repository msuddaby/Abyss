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
[Route("api/servers/{serverId}/emojis")]
[Authorize]
public class EmojisController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly MediaUploadService _mediaUploadService;

    private static readonly Regex NameRegex = new(@"^[a-zA-Z0-9_]{2,32}$", RegexOptions.Compiled);
    private const int MaxEmojisPerServer = 50;

    public EmojisController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub, MediaUploadService mediaUploadService)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _mediaUploadService = mediaUploadService;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<CustomEmojiDto>>> ListEmojis(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var emojis = await _db.CustomEmojis
            .Where(e => e.ServerId == serverId)
            .OrderBy(e => e.CreatedAt)
            .Select(e => new CustomEmojiDto(e.Id, e.ServerId, e.Name, e.ImageUrl, e.CreatedById, e.CreatedAt))
            .ToListAsync();
        return Ok(emojis);
    }

    [HttpPost]
    public async Task<ActionResult<CustomEmojiDto>> UploadEmoji(Guid serverId, IFormFile file, [FromForm] string name)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageEmojis)) return Forbid();

        if (string.IsNullOrWhiteSpace(name) || !NameRegex.IsMatch(name))
            return BadRequest("Emoji name must be 2-32 characters, alphanumeric or underscore.");

        if (file == null || file.Length == 0)
            return BadRequest("No file provided.");

        var count = await _db.CustomEmojis.CountAsync(e => e.ServerId == serverId);
        if (count >= MaxEmojisPerServer)
            return BadRequest($"Server has reached the maximum of {MaxEmojisPerServer} emojis.");

        var nameExists = await _db.CustomEmojis.AnyAsync(e => e.ServerId == serverId && e.Name == name);
        if (nameExists)
            return BadRequest($"An emoji with the name '{name}' already exists in this server.");

        var upload = await _mediaUploadService.StoreEmojiAsync(file);
        if (!upload.IsValid || upload.Url is null)
            return BadRequest(upload.ErrorMessage);

        var imageUrl = upload.Url;

        var emoji = new CustomEmoji
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            Name = name,
            ImageUrl = imageUrl,
            CreatedById = UserId,
            CreatedAt = DateTime.UtcNow,
        };
        _db.CustomEmojis.Add(emoji);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.EmojiCreated, UserId, targetName: name);

        var dto = new CustomEmojiDto(emoji.Id, emoji.ServerId, emoji.Name, emoji.ImageUrl, emoji.CreatedById, emoji.CreatedAt);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("EmojiCreated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpPatch("{emojiId}")]
    public async Task<ActionResult<CustomEmojiDto>> RenameEmoji(Guid serverId, Guid emojiId, RenameEmojiRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageEmojis)) return Forbid();

        var emoji = await _db.CustomEmojis.FirstOrDefaultAsync(e => e.Id == emojiId && e.ServerId == serverId);
        if (emoji == null) return NotFound();

        var nameExists = await _db.CustomEmojis.AnyAsync(e => e.ServerId == serverId && e.Name == req.Name && e.Id != emojiId);
        if (nameExists)
            return BadRequest($"An emoji with the name '{req.Name}' already exists in this server.");

        emoji.Name = req.Name;
        await _db.SaveChangesAsync();

        var dto = new CustomEmojiDto(emoji.Id, emoji.ServerId, emoji.Name, emoji.ImageUrl, emoji.CreatedById, emoji.CreatedAt);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("EmojiUpdated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpDelete("{emojiId}")]
    public async Task<IActionResult> DeleteEmoji(Guid serverId, Guid emojiId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageEmojis)) return Forbid();

        var emoji = await _db.CustomEmojis.FirstOrDefaultAsync(e => e.Id == emojiId && e.ServerId == serverId);
        if (emoji == null) return NotFound();

        _db.CustomEmojis.Remove(emoji);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.EmojiDeleted, UserId, targetName: emoji.Name);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("EmojiDeleted", serverId.ToString(), emojiId.ToString());
        return Ok();
    }
}
