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
[Route("api/[controller]")]
[Authorize]
public class InvitesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly SystemMessageService _systemMessages;
    private readonly IHubContext<ChatHub> _hub;

    public InvitesController(AppDbContext db, PermissionService perms, SystemMessageService systemMessages, IHubContext<ChatHub> hub)
    {
        _db = db;
        _perms = perms;
        _systemMessages = systemMessages;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpPost("{code}/join")]
    public async Task<ActionResult<ServerDto>> Join(string code)
    {
        var invite = await _db.Invites.Include(i => i.Server).FirstOrDefaultAsync(i => i.Code == code);
        if (invite == null || invite.ServerId == null) return NotFound("Invalid invite code");

        if (invite.ExpiresAt.HasValue && invite.ExpiresAt < DateTime.UtcNow)
            return BadRequest("Invite has expired");

        if (invite.MaxUses.HasValue && invite.Uses >= invite.MaxUses)
            return BadRequest("Invite has reached max uses");

        // Check if banned
        if (await _perms.IsBannedAsync(invite.ServerId.Value, UserId))
            return BadRequest("You are banned from this server.");

        var alreadyMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == invite.ServerId && sm.UserId == UserId);
        if (alreadyMember)
            return Ok(new ServerDto(invite.Server!.Id, invite.Server.Name, invite.Server.IconUrl, invite.Server.OwnerId, invite.Server.JoinLeaveMessagesEnabled, invite.Server.JoinLeaveChannelId, (int)invite.Server.DefaultNotificationLevel));

        _db.ServerMembers.Add(new ServerMember
        {
            ServerId = invite.ServerId.Value,
            UserId = UserId,
        });

        invite.Uses++;
        invite.LastUsedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        // Broadcast the new member to all connected clients in the server
        var user = await _db.Users.FindAsync(UserId);
        if (user != null)
        {
            var defaultRoles = await _db.ServerRoles
                .Where(r => r.ServerId == invite.ServerId.Value && r.IsDefault)
                .Select(r => new ServerRoleDto(r.Id, r.Name, r.Color, r.Permissions, r.Position, r.IsDefault, r.DisplaySeparately))
                .ToListAsync();

            var memberDto = new ServerMemberDto(
                invite.ServerId.Value,
                UserId,
                new UserDto(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio, user.PresenceStatus),
                false,
                defaultRoles,
                DateTime.UtcNow);

            await _hub.Clients.Group($"server:{invite.ServerId}").SendAsync("MemberJoined", invite.ServerId.ToString(), memberDto);
        }

        await _systemMessages.SendMemberJoinLeaveAsync(invite.ServerId.Value, UserId, joined: true);

        return Ok(new ServerDto(invite.Server!.Id, invite.Server.Name, invite.Server.IconUrl, invite.Server.OwnerId, invite.Server.JoinLeaveMessagesEnabled, invite.Server.JoinLeaveChannelId, (int)invite.Server.DefaultNotificationLevel));
    }
}
