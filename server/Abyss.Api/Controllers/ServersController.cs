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
public class ServersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;

    public ServersController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<ServerDto>>> GetMyServers()
    {
        var servers = await _db.ServerMembers
            .Where(sm => sm.UserId == UserId)
            .Select(sm => sm.Server)
            .Select(s => new ServerDto(s.Id, s.Name, s.IconUrl, s.OwnerId))
            .ToListAsync();
        return Ok(servers);
    }

    [HttpPost]
    public async Task<ActionResult<ServerDto>> Create(CreateServerRequest req)
    {
        var server = new Server
        {
            Id = Guid.NewGuid(),
            Name = req.Name,
            OwnerId = UserId,
        };
        _db.Servers.Add(server);

        // Seed @everyone role
        var everyoneRole = new ServerRole
        {
            Id = Guid.NewGuid(),
            ServerId = server.Id,
            Name = "@everyone",
            Permissions = 0,
            Position = 0,
            IsDefault = true,
        };
        _db.ServerRoles.Add(everyoneRole);

        _db.ServerMembers.Add(new ServerMember
        {
            ServerId = server.Id,
            UserId = UserId,
            IsOwner = true,
        });

        // Create default text channel
        _db.Channels.Add(new Channel
        {
            Id = Guid.NewGuid(),
            Name = "general",
            Type = ChannelType.Text,
            ServerId = server.Id,
            Position = 0,
        });

        await _db.SaveChangesAsync();
        return Ok(new ServerDto(server.Id, server.Name, server.IconUrl, server.OwnerId));
    }

    [HttpGet("{serverId}/channels")]
    public async Task<ActionResult<List<ChannelDto>>> GetChannels(Guid serverId)
    {
        var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == serverId && sm.UserId == UserId);
        if (!isMember) return Forbid();

        var channels = await _db.Channels
            .Where(c => c.ServerId == serverId)
            .OrderBy(c => c.Position)
            .Select(c => new ChannelDto(c.Id, c.Name, c.Type.ToString(), c.ServerId, c.Position))
            .ToListAsync();
        return Ok(channels);
    }

    [HttpPost("{serverId}/channels")]
    public async Task<ActionResult<ChannelDto>> CreateChannel(Guid serverId, CreateChannelRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();

        var maxPos = await _db.Channels.Where(c => c.ServerId == serverId).MaxAsync(c => (int?)c.Position) ?? -1;
        var channelType = Enum.Parse<ChannelType>(req.Type);

        var channel = new Channel
        {
            Id = Guid.NewGuid(),
            Name = req.Name,
            Type = channelType,
            ServerId = serverId,
            Position = maxPos + 1,
        };
        _db.Channels.Add(channel);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.ChannelCreated, UserId,
            targetName: $"#{channel.Name}", details: channelType.ToString());

        var dto = new ChannelDto(channel.Id, channel.Name, channel.Type.ToString(), channel.ServerId, channel.Position);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ChannelCreated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpGet("{serverId}/members")]
    public async Task<ActionResult<List<ServerMemberDto>>> GetMembers(Guid serverId)
    {
        var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == serverId && sm.UserId == UserId);
        if (!isMember) return Forbid();

        var members = await _db.ServerMembers
            .Include(sm => sm.User)
            .Include(sm => sm.MemberRoles)
                .ThenInclude(mr => mr.Role)
            .Where(sm => sm.ServerId == serverId)
            .ToListAsync();

        var dtos = members.Select(sm => new ServerMemberDto(
            sm.ServerId,
            sm.UserId,
            new UserDto(sm.User.Id, sm.User.UserName!, sm.User.DisplayName, sm.User.AvatarUrl, sm.User.Status, sm.User.Bio),
            sm.IsOwner,
            sm.MemberRoles.Select(mr => new ServerRoleDto(mr.Role.Id, mr.Role.Name, mr.Role.Color, mr.Role.Permissions, mr.Role.Position, mr.Role.IsDefault)).ToList(),
            sm.JoinedAt)).ToList();
        return Ok(dtos);
    }

    [HttpPost("{serverId}/invites")]
    public async Task<ActionResult<InviteDto>> CreateInvite(Guid serverId)
    {
        var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == serverId && sm.UserId == UserId);
        if (!isMember) return Forbid();

        var invite = new Invite
        {
            Id = Guid.NewGuid(),
            Code = Guid.NewGuid().ToString("N")[..8],
            ServerId = serverId,
            CreatorId = UserId,
        };
        _db.Invites.Add(invite);
        await _db.SaveChangesAsync();

        return Ok(new InviteDto(invite.Id, invite.Code, invite.ServerId, invite.CreatorId, invite.ExpiresAt, invite.MaxUses, invite.Uses));
    }

    [HttpPatch("{serverId}/members/{userId}/roles")]
    public async Task<IActionResult> UpdateMemberRoles(Guid serverId, string userId, UpdateMemberRolesRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageRoles)) return Forbid();

        var actor = await _perms.GetMemberAsync(serverId, UserId);
        var target = await _perms.GetMemberAsync(serverId, userId);
        if (actor == null || target == null) return NotFound();
        if (target.IsOwner && UserId != userId) return BadRequest("Cannot change the owner's roles.");

        // Hierarchy check: can't assign roles at or above own position
        var actorPos = PermissionService.GetHighestPosition(actor);
        var requestedRoles = await _db.ServerRoles.Where(r => r.ServerId == serverId && req.RoleIds.Contains(r.Id)).ToListAsync();
        if (requestedRoles.Any(r => r.Position >= actorPos && !actor.IsOwner))
            return BadRequest("Cannot assign roles at or above your own position.");

        // Remove existing non-default role assignments
        var existingAssignments = await _db.ServerMemberRoles
            .Where(smr => smr.ServerId == serverId && smr.UserId == userId)
            .Include(smr => smr.Role)
            .ToListAsync();
        var toRemove = existingAssignments.Where(smr => !smr.Role.IsDefault).ToList();
        _db.ServerMemberRoles.RemoveRange(toRemove);

        // Add new role assignments (exclude default role, it's implicit)
        foreach (var role in requestedRoles.Where(r => !r.IsDefault))
        {
            _db.ServerMemberRoles.Add(new ServerMemberRole
            {
                ServerId = serverId,
                UserId = userId,
                RoleId = role.Id,
            });
        }
        await _db.SaveChangesAsync();

        var targetUser = await _db.Users.FindAsync(userId);
        var roleNames = string.Join(", ", requestedRoles.Select(r => r.Name));
        await _perms.LogAsync(serverId, AuditAction.MemberRolesUpdated, UserId,
            targetId: userId, targetName: targetUser?.DisplayName, details: roleNames);

        // Fetch updated roles for broadcast
        var updatedMember = await _perms.GetMemberAsync(serverId, userId);
        var roleDtos = updatedMember!.MemberRoles.Select(mr => new ServerRoleDto(mr.Role.Id, mr.Role.Name, mr.Role.Color, mr.Role.Permissions, mr.Role.Position, mr.Role.IsDefault)).ToArray();
        await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberRolesUpdated", serverId.ToString(), userId, roleDtos);

        return Ok();
    }

    [HttpDelete("{serverId}/members/{userId}")]
    public async Task<IActionResult> KickMember(Guid serverId, string userId)
    {
        if (!await _perms.CanKickAsync(serverId, UserId, userId)) return Forbid();

        var target = await _perms.GetMemberAsync(serverId, userId);
        if (target == null) return NotFound();

        var targetUser = await _db.Users.FindAsync(userId);

        // Remove role assignments
        _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.ServerId == serverId && smr.UserId == userId));
        _db.ServerMembers.Remove(target);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.MemberKicked, UserId,
            targetId: userId, targetName: targetUser?.DisplayName);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberKicked", serverId.ToString(), userId);
        return Ok();
    }

    [HttpDelete("{serverId}/channels/{channelId}")]
    public async Task<IActionResult> DeleteChannel(Guid serverId, Guid channelId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();

        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ServerId == serverId);
        if (channel == null) return NotFound();

        // Prevent deleting last text channel
        if (channel.Type == ChannelType.Text)
        {
            var textCount = await _db.Channels.CountAsync(c => c.ServerId == serverId && c.Type == ChannelType.Text);
            if (textCount <= 1) return BadRequest("Cannot delete the last text channel.");
        }

        _db.Channels.Remove(channel);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.ChannelDeleted, UserId,
            targetName: $"#{channel.Name}", details: channel.Type.ToString());

        await _hub.Clients.Group($"server:{serverId}").SendAsync("ChannelDeleted", serverId.ToString(), channelId.ToString());
        return Ok();
    }

    [HttpDelete("{serverId}")]
    public async Task<IActionResult> DeleteServer(Guid serverId)
    {
        if (!await _perms.IsOwnerAsync(serverId, UserId)) return Forbid();

        // Notify before deleting
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ServerDeleted", serverId.ToString());

        var server = await _db.Servers.FindAsync(serverId);
        if (server == null) return NotFound();

        // Cascade: remove all related data
        var channelIds = await _db.Channels.Where(c => c.ServerId == serverId).Select(c => c.Id).ToListAsync();
        var messageIds = await _db.Messages.Where(m => channelIds.Contains(m.ChannelId)).Select(m => m.Id).ToListAsync();

        _db.Reactions.RemoveRange(_db.Reactions.Where(r => messageIds.Contains(r.MessageId)));
        _db.Attachments.RemoveRange(_db.Attachments.Where(a => a.MessageId.HasValue && messageIds.Contains(a.MessageId.Value)));
        _db.Messages.RemoveRange(_db.Messages.Where(m => channelIds.Contains(m.ChannelId)));
        _db.Channels.RemoveRange(_db.Channels.Where(c => c.ServerId == serverId));
        _db.Invites.RemoveRange(_db.Invites.Where(i => i.ServerId == serverId));
        _db.AuditLogs.RemoveRange(_db.AuditLogs.Where(a => a.ServerId == serverId));
        _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.ServerId == serverId));
        _db.ServerRoles.RemoveRange(_db.ServerRoles.Where(r => r.ServerId == serverId));
        _db.ServerBans.RemoveRange(_db.ServerBans.Where(b => b.ServerId == serverId));
        _db.ServerMembers.RemoveRange(_db.ServerMembers.Where(sm => sm.ServerId == serverId));
        _db.Servers.Remove(server);

        await _db.SaveChangesAsync();
        return Ok();
    }

    [HttpGet("{serverId}/audit-logs")]
    public async Task<ActionResult<List<AuditLogDto>>> GetAuditLogs(Guid serverId, [FromQuery] int limit = 50)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ViewAuditLog)) return Forbid();

        var logs = await _db.AuditLogs
            .Include(a => a.Actor)
            .Where(a => a.ServerId == serverId)
            .OrderByDescending(a => a.CreatedAt)
            .Take(limit)
            .Select(a => new AuditLogDto(
                a.Id,
                a.Action.ToString(),
                a.ActorId,
                new UserDto(a.Actor.Id, a.Actor.UserName!, a.Actor.DisplayName, a.Actor.AvatarUrl, a.Actor.Status, a.Actor.Bio),
                a.TargetId,
                a.TargetName,
                a.Details,
                a.CreatedAt))
            .ToListAsync();
        return Ok(logs);
    }
}
