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
[Route("api/servers/{serverId}/roles")]
[Authorize]
public class RolesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;

    public RolesController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<ServerRoleDto>>> ListRoles(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var roles = await _db.ServerRoles
            .Where(r => r.ServerId == serverId)
            .OrderBy(r => r.Position)
            .Select(r => new ServerRoleDto(r.Id, r.Name, r.Color, r.Permissions, r.Position, r.IsDefault))
            .ToListAsync();
        return Ok(roles);
    }

    [HttpPost]
    public async Task<ActionResult<ServerRoleDto>> CreateRole(Guid serverId, CreateRoleRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageRoles)) return Forbid();

        var actor = await _perms.GetMemberAsync(serverId, UserId);
        if (actor == null) return Forbid();
        var actorPos = PermissionService.GetHighestPosition(actor);

        var maxPos = await _db.ServerRoles.Where(r => r.ServerId == serverId).MaxAsync(r => (int?)r.Position) ?? 0;
        var newPos = maxPos + 1;

        // Non-owners can't create roles above their own position
        if (!actor.IsOwner && newPos >= actorPos)
            newPos = actorPos - 1;
        if (newPos < 1) newPos = 1;

        var role = new ServerRole
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            Name = req.Name,
            Color = req.Color,
            Permissions = req.Permissions,
            Position = newPos,
            IsDefault = false,
        };
        _db.ServerRoles.Add(role);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.RoleCreated, UserId,
            targetName: role.Name);

        var dto = new ServerRoleDto(role.Id, role.Name, role.Color, role.Permissions, role.Position, role.IsDefault);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("RoleCreated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpPatch("{roleId}")]
    public async Task<ActionResult<ServerRoleDto>> UpdateRole(Guid serverId, Guid roleId, UpdateRoleRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageRoles)) return Forbid();

        var role = await _db.ServerRoles.FirstOrDefaultAsync(r => r.Id == roleId && r.ServerId == serverId);
        if (role == null) return NotFound();

        var actor = await _perms.GetMemberAsync(serverId, UserId);
        if (actor == null) return Forbid();
        var actorPos = PermissionService.GetHighestPosition(actor);

        // Can't edit roles at or above own position (unless owner)
        if (!actor.IsOwner && role.Position >= actorPos) return Forbid();

        if (req.Name != null) role.Name = req.Name;
        if (req.Color != null) role.Color = req.Color;
        if (req.Permissions.HasValue) role.Permissions = req.Permissions.Value;
        // Position changes handled via reorder endpoint

        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.RoleUpdated, UserId,
            targetName: role.Name);

        var dto = new ServerRoleDto(role.Id, role.Name, role.Color, role.Permissions, role.Position, role.IsDefault);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("RoleUpdated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpDelete("{roleId}")]
    public async Task<IActionResult> DeleteRole(Guid serverId, Guid roleId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageRoles)) return Forbid();

        var role = await _db.ServerRoles.FirstOrDefaultAsync(r => r.Id == roleId && r.ServerId == serverId);
        if (role == null) return NotFound();
        if (role.IsDefault) return BadRequest("Cannot delete the @everyone role.");

        var actor = await _perms.GetMemberAsync(serverId, UserId);
        if (actor == null) return Forbid();
        var actorPos = PermissionService.GetHighestPosition(actor);

        if (!actor.IsOwner && role.Position >= actorPos) return Forbid();

        // Remove role assignments first
        _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.RoleId == roleId));
        _db.ServerRoles.Remove(role);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.RoleDeleted, UserId,
            targetName: role.Name);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("RoleDeleted", serverId.ToString(), roleId.ToString());
        return Ok();
    }

    [HttpPatch("reorder")]
    public async Task<IActionResult> ReorderRoles(Guid serverId, ReorderRolesRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageRoles)) return Forbid();

        var roles = await _db.ServerRoles.Where(r => r.ServerId == serverId).ToListAsync();

        // Reassign positions sequentially; @everyone always stays at 0
        var position = 1;
        foreach (var roleId in req.RoleIds)
        {
            var role = roles.FirstOrDefault(r => r.Id == roleId);
            if (role != null && !role.IsDefault)
            {
                role.Position = position++;
            }
        }

        await _db.SaveChangesAsync();

        // Broadcast all roles
        var dtos = roles.OrderBy(r => r.Position)
            .Select(r => new ServerRoleDto(r.Id, r.Name, r.Color, r.Permissions, r.Position, r.IsDefault))
            .ToList();
        // Broadcast each role update so frontend can update
        foreach (var dto in dtos)
        {
            await _hub.Clients.Group($"server:{serverId}").SendAsync("RoleUpdated", serverId.ToString(), dto);
        }

        return Ok();
    }
}
