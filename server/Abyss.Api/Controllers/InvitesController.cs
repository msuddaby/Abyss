using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
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

    public InvitesController(AppDbContext db, PermissionService perms)
    {
        _db = db;
        _perms = perms;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpPost("{code}/join")]
    public async Task<ActionResult<ServerDto>> Join(string code)
    {
        var invite = await _db.Invites.Include(i => i.Server).FirstOrDefaultAsync(i => i.Code == code);
        if (invite == null) return NotFound("Invalid invite code");

        if (invite.ExpiresAt.HasValue && invite.ExpiresAt < DateTime.UtcNow)
            return BadRequest("Invite has expired");

        if (invite.MaxUses.HasValue && invite.Uses >= invite.MaxUses)
            return BadRequest("Invite has reached max uses");

        // Check if banned
        if (await _perms.IsBannedAsync(invite.ServerId, UserId))
            return BadRequest("You are banned from this server.");

        var alreadyMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == invite.ServerId && sm.UserId == UserId);
        if (alreadyMember)
            return Ok(new ServerDto(invite.Server.Id, invite.Server.Name, invite.Server.IconUrl, invite.Server.OwnerId));

        _db.ServerMembers.Add(new ServerMember
        {
            ServerId = invite.ServerId,
            UserId = UserId,
        });

        invite.Uses++;
        await _db.SaveChangesAsync();

        return Ok(new ServerDto(invite.Server.Id, invite.Server.Name, invite.Server.IconUrl, invite.Server.OwnerId));
    }
}
