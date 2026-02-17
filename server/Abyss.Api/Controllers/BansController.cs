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
[Route("api/servers/{serverId}/bans")]
[Authorize]
public class BansController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly SystemMessageService _systemMessages;

    public BansController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub, SystemMessageService systemMessages)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _systemMessages = systemMessages;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<ServerBanDto>>> ListBans(Guid serverId)
    {
        var canBan = await _perms.HasPermissionAsync(serverId, UserId, Permission.BanMembers);
        var canViewAudit = await _perms.HasPermissionAsync(serverId, UserId, Permission.ViewAuditLog);
        if (!canBan && !canViewAudit) return Forbid();

        var bans = await _db.ServerBans
            .Include(b => b.User)
            .Include(b => b.BannedBy)
            .Where(b => b.ServerId == serverId)
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new ServerBanDto(
                b.Id,
                b.UserId,
                new UserDto(b.User.Id, b.User.UserName!, b.User.DisplayName, b.User.AvatarUrl, b.User.Status, b.User.Bio, b.User.PresenceStatus),
                b.BannedById,
                new UserDto(b.BannedBy.Id, b.BannedBy.UserName!, b.BannedBy.DisplayName, b.BannedBy.AvatarUrl, b.BannedBy.Status, b.BannedBy.Bio, b.BannedBy.PresenceStatus),
                b.Reason,
                b.CreatedAt))
            .ToListAsync();
        return Ok(bans);
    }

    [HttpPost("{userId}")]
    public async Task<IActionResult> BanMember(Guid serverId, string userId, [FromBody] BanMemberRequest? req)
    {
        if (!await _perms.CanBanAsync(serverId, UserId, userId)) return Forbid();

        // Check if already banned
        if (await _perms.IsBannedAsync(serverId, userId))
            return BadRequest("User is already banned.");

        var targetUser = await _db.Users.FindAsync(userId);
        if (targetUser == null) return NotFound();

        // Create ban record
        _db.ServerBans.Add(new ServerBan
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            UserId = userId,
            BannedById = UserId,
            Reason = req?.Reason,
            CreatedAt = DateTime.UtcNow,
        });

        // Remove from server
        var member = await _db.ServerMembers.FirstOrDefaultAsync(sm => sm.ServerId == serverId && sm.UserId == userId);
        if (member != null)
        {
            _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.ServerId == serverId && smr.UserId == userId));
            _db.ServerMembers.Remove(member);
        }

        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.MemberBanned, UserId,
            targetId: userId, targetName: targetUser.DisplayName, details: req?.Reason);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberBanned", serverId.ToString(), userId);

        if (member != null)
        {
            await _systemMessages.SendMemberJoinLeaveAsync(serverId, userId, joined: false, action: "banned", reason: req?.Reason);
        }
        return Ok();
    }

    [HttpDelete("{userId}")]
    public async Task<IActionResult> UnbanMember(Guid serverId, string userId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.BanMembers)) return Forbid();

        var ban = await _db.ServerBans.FirstOrDefaultAsync(b => b.ServerId == serverId && b.UserId == userId);
        if (ban == null) return NotFound();

        var targetUser = await _db.Users.FindAsync(userId);
        _db.ServerBans.Remove(ban);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.MemberUnbanned, UserId,
            targetId: userId, targetName: targetUser?.DisplayName);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberUnbanned", serverId.ToString(), userId);
        return Ok();
    }
}
