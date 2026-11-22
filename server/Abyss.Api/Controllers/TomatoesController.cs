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
[Route("api/tomatoes")]
[Authorize]
public class TomatoesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly TomatoService _tomatoes;
    private readonly IHubContext<ChatHub> _hub;

    public TomatoesController(AppDbContext db, PermissionService perms, TomatoService tomatoes, IHubContext<ChatHub> hub)
    {
        _db = db;
        _perms = perms;
        _tomatoes = tomatoes;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet("ammo")]
    public async Task<ActionResult<TomatoAmmoDto>> GetAmmo()
    {
        return Ok(await _tomatoes.GetAmmoAsync(UserId));
    }

    [HttpPost("messages/{messageId}")]
    public async Task<ActionResult<ThrowTomatoResponse>> Throw(Guid messageId, [FromBody] ThrowTomatoRequest req)
    {
        if (!float.IsFinite(req.X) || !float.IsFinite(req.Y)) return BadRequest("Invalid position.");

        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == messageId);
        if (message == null || message.IsDeleted) return NotFound();
        if (message.IsSystem) return BadRequest("You can't throw tomatoes at the system.");
        if (!await CanThrowIn(message.Channel)) return Forbid();

        var alreadyHit = await _db.MessageSplats.AnyAsync(s =>
            s.MessageId == messageId && s.UserId == UserId && s.WipedAt == null);
        if (alreadyHit) return Conflict("You've already hit this message.");

        var ammo = await _tomatoes.GetAmmoAsync(UserId);
        if (ammo.Remaining <= 0) return StatusCode(StatusCodes.Status429TooManyRequests, ammo);

        var thrower = await _db.Users.FindAsync(UserId);
        if (thrower == null) return Unauthorized();

        var splat = new MessageSplat
        {
            Id = Guid.NewGuid(),
            MessageId = messageId,
            UserId = UserId,
            Kind = "tomato",
            X = Math.Clamp(req.X, 0f, 1f),
            Y = Math.Clamp(req.Y, 0f, 1f),
            Seed = Random.Shared.Next(),
            CreatedAt = DateTime.UtcNow,
        };
        _db.MessageSplats.Add(splat);
        await _db.SaveChangesAsync();

        var dto = new MessageSplatDto(splat.Id, splat.MessageId, splat.UserId, splat.Kind, splat.X, splat.Y,
            splat.Seed, splat.CreatedAt, null, thrower.DisplayName);
        await _hub.Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageSplatted", dto);

        return Ok(new ThrowTomatoResponse(dto, await _tomatoes.GetAmmoAsync(UserId)));
    }

    /// <summary>Wipe every live splat off a message. Author or ManageMessages only.</summary>
    [HttpDelete("messages/{messageId}")]
    public async Task<IActionResult> Wipe(Guid messageId)
    {
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == messageId);
        if (message == null) return NotFound();
        if (!await CanAccess(message.Channel)) return Forbid();

        var isAuthor = message.AuthorId == UserId;
        var canManage = message.Channel.ServerId.HasValue &&
            await _perms.HasChannelPermissionAsync(message.ChannelId, UserId, Permission.ManageMessages);
        if (!isAuthor && !canManage) return Forbid();

        var now = DateTime.UtcNow;
        var wiped = await _db.MessageSplats
            .Where(s => s.MessageId == messageId && s.WipedAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.WipedAt, now));
        if (wiped == 0) return NoContent();

        await _hub.Clients.Group($"channel:{message.ChannelId}")
            .SendAsync("MessageSplatsWiped", messageId.ToString(), DateTime.SpecifyKind(now, DateTimeKind.Utc));
        return NoContent();
    }

    private async Task<bool> CanAccess(Channel channel)
    {
        if (channel.Type == ChannelType.DM)
            return channel.DmUser1Id == UserId || channel.DmUser2Id == UserId;
        return channel.ServerId.HasValue &&
            await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.ViewChannel);
    }

    // Throwing rides on the reaction permission — it's a (very loud) reaction.
    private async Task<bool> CanThrowIn(Channel channel)
    {
        if (!await CanAccess(channel)) return false;
        return channel.Type == ChannelType.DM ||
            await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.AddReactions);
    }
}
