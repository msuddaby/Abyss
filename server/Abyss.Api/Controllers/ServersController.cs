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
    private readonly ImageService _imageService;
    private readonly SystemMessageService _systemMessages;

    public ServersController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub, ImageService imageService, SystemMessageService systemMessages)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _imageService = imageService;
        _systemMessages = systemMessages;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<ServerDto>>> GetMyServers()
    {
        var servers = await _db.ServerMembers
            .Where(sm => sm.UserId == UserId)
            .Select(sm => sm.Server)
            .Select(s => new ServerDto(s.Id, s.Name, s.IconUrl, s.OwnerId, s.JoinLeaveMessagesEnabled, s.JoinLeaveChannelId, (int)s.DefaultNotificationLevel))
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
            Permissions = (long)(
                Permission.ViewChannel |
                Permission.ReadMessageHistory |
                Permission.SendMessages |
                Permission.AddReactions |
                Permission.AttachFiles |
                Permission.MentionEveryone |
                Permission.Connect |
                Permission.Speak |
                Permission.Stream),
            Position = 0,
            IsDefault = true,
            DisplaySeparately = false,
        };
        _db.ServerRoles.Add(everyoneRole);

        _db.ServerMembers.Add(new ServerMember
        {
            ServerId = server.Id,
            UserId = UserId,
            IsOwner = true,
        });

        // Create default text channel
        var generalChannel = new Channel
        {
            Id = Guid.NewGuid(),
            Name = "general",
            Type = ChannelType.Text,
            ServerId = server.Id,
            Position = 0,
        };
        _db.Channels.Add(generalChannel);
        server.JoinLeaveMessagesEnabled = true;
        server.JoinLeaveChannelId = generalChannel.Id;

        await _db.SaveChangesAsync();
        return Ok(new ServerDto(server.Id, server.Name, server.IconUrl, server.OwnerId, server.JoinLeaveMessagesEnabled, server.JoinLeaveChannelId, (int)server.DefaultNotificationLevel));
    }

    [HttpPatch("{serverId}")]
    public async Task<ActionResult<ServerDto>> UpdateServer(Guid serverId, [FromForm] UpdateServerRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageServer)) return Forbid();

        var server = await _db.Servers.FindAsync(serverId);
        if (server == null) return NotFound();

        var didChange = false;

        if (req.Name != null)
        {
            var trimmed = req.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmed)) return BadRequest("Server name is required.");
            if (!string.Equals(server.Name, trimmed, StringComparison.Ordinal))
            {
                server.Name = trimmed;
                didChange = true;
            }
        }

        if (req.RemoveIcon == true)
        {
            if (!string.IsNullOrEmpty(server.IconUrl))
            {
                server.IconUrl = null;
                didChange = true;
            }
        }
        else if (req.Icon != null)
        {
            if (req.Icon.Length == 0) return BadRequest("No file");
            if (req.Icon.Length > 5 * 1024 * 1024) return BadRequest("File too large (max 5MB)");
            var imageError = ImageService.ValidateImageFile(req.Icon);
            if (imageError != null) return BadRequest(imageError);
            server.IconUrl = await _imageService.ProcessAvatarAsync(req.Icon);
            didChange = true;
        }

        if (req.JoinLeaveMessagesEnabled.HasValue || req.JoinLeaveChannelId.HasValue)
        {
            if (req.JoinLeaveMessagesEnabled.HasValue &&
                server.JoinLeaveMessagesEnabled != req.JoinLeaveMessagesEnabled.Value)
            {
                server.JoinLeaveMessagesEnabled = req.JoinLeaveMessagesEnabled.Value;
                didChange = true;
            }

            if (req.JoinLeaveChannelId.HasValue)
            {
                var channelId = req.JoinLeaveChannelId.Value;
                var channel = await _db.Channels.FirstOrDefaultAsync(c =>
                    c.Id == channelId &&
                    c.ServerId == serverId &&
                    c.Type == ChannelType.Text);
                if (channel == null) return BadRequest("Join/leave channel must be a text channel in this server.");

                if (server.JoinLeaveChannelId != channelId)
                {
                    server.JoinLeaveChannelId = channelId;
                    didChange = true;
                }
            }
        }

        if (!didChange) return Ok(new ServerDto(server.Id, server.Name, server.IconUrl, server.OwnerId, server.JoinLeaveMessagesEnabled, server.JoinLeaveChannelId, (int)server.DefaultNotificationLevel));

        await _db.SaveChangesAsync();
        await _perms.LogAsync(serverId, AuditAction.ServerUpdated, UserId, targetName: server.Name);

        var dto = new ServerDto(server.Id, server.Name, server.IconUrl, server.OwnerId, server.JoinLeaveMessagesEnabled, server.JoinLeaveChannelId, (int)server.DefaultNotificationLevel);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ServerUpdated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpGet("{serverId}/channels")]
    public async Task<ActionResult<List<ChannelDto>>> GetChannels(Guid serverId)
    {
        var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == serverId && sm.UserId == UserId);
        if (!isMember) return Forbid();

        var channels = await _db.Channels
            .Where(c => c.ServerId == serverId)
            .OrderBy(c => c.Type)
            .ThenBy(c => c.Position)
            .ToListAsync();

        var result = new List<ChannelDto>();
        foreach (var channel in channels)
        {
            var perms = await _perms.GetChannelPermissionsAsync(channel.Id, UserId);
            if ((perms & (long)Permission.ViewChannel) != (long)Permission.ViewChannel) continue;

            result.Add(new ChannelDto(
                channel.Id,
                channel.Name,
                channel.Type.ToString(),
                channel.ServerId,
                channel.Position,
                perms & PermissionService.ChannelPermissionMask,
                channel.PersistentChat));
        }

        return Ok(result);
    }

    [HttpPost("{serverId}/channels")]
    public async Task<ActionResult<ChannelDto>> CreateChannel(Guid serverId, CreateChannelRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();

        if (!Enum.TryParse<ChannelType>(req.Type, ignoreCase: true, out var channelType))
            return BadRequest("Invalid channel type");

        var maxPos = await _db.Channels
            .Where(c => c.ServerId == serverId && c.Type == channelType)
            .MaxAsync(c => (int?)c.Position) ?? -1;

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

        var dto = new ChannelDto(channel.Id, channel.Name, channel.Type.ToString(), channel.ServerId, channel.Position, null, channel.PersistentChat);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ChannelCreated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpPatch("{serverId}/channels/{channelId}")]
    public async Task<ActionResult<ChannelDto>> UpdateChannel(Guid serverId, Guid channelId, UpdateChannelRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();
        if (string.IsNullOrWhiteSpace(req.Name)) return BadRequest("Channel name is required.");

        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ServerId == serverId);
        if (channel == null) return NotFound();

        channel.Name = req.Name.Trim();
        if (req.PersistentChat.HasValue && channel.Type == ChannelType.Voice)
            channel.PersistentChat = req.PersistentChat.Value;
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.ChannelUpdated, UserId,
            targetName: $"#{channel.Name}", details: channel.Type.ToString());

        var dto = new ChannelDto(channel.Id, channel.Name, channel.Type.ToString(), channel.ServerId, channel.Position, null, channel.PersistentChat);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ChannelUpdated", serverId.ToString(), dto);
        return Ok(dto);
    }

    [HttpGet("{serverId}/channels/{channelId}/permissions")]
    public async Task<ActionResult<ChannelPermissionsDto>> GetChannelPermissions(Guid serverId, Guid channelId)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();

        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ServerId == serverId);
        if (channel == null) return NotFound();

        var overrides = await _db.ChannelPermissionOverrides
            .Where(o => o.ChannelId == channelId)
            .Select(o => new ChannelPermissionOverrideDto(o.RoleId, o.Allow, o.Deny))
            .ToListAsync();

        return Ok(new ChannelPermissionsDto(overrides));
    }

    [HttpPut("{serverId}/channels/{channelId}/permissions")]
    public async Task<ActionResult> UpdateChannelPermissions(Guid serverId, Guid channelId, ChannelPermissionsDto dto)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();

        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ServerId == serverId);
        if (channel == null) return NotFound();

        var overrides = dto.Overrides ?? new List<ChannelPermissionOverrideDto>();
        var roleIds = overrides.Select(o => o.RoleId).Distinct().ToList();

        var roles = await _db.ServerRoles
            .Where(r => r.ServerId == serverId && roleIds.Contains(r.Id))
            .Select(r => r.Id)
            .ToListAsync();

        if (roles.Count != roleIds.Count) return BadRequest("One or more roles are invalid.");

        var existing = await _db.ChannelPermissionOverrides
            .Where(o => o.ChannelId == channelId)
            .ToListAsync();

        _db.ChannelPermissionOverrides.RemoveRange(existing);

        foreach (var ov in overrides)
        {
            _db.ChannelPermissionOverrides.Add(new ChannelPermissionOverride
            {
                ChannelId = channelId,
                RoleId = ov.RoleId,
                Allow = ov.Allow & PermissionService.ChannelPermissionMask,
                Deny = ov.Deny & PermissionService.ChannelPermissionMask,
            });
        }

        await _db.SaveChangesAsync();

        await _hub.Clients.Group($"server:{serverId}")
            .SendAsync("ChannelPermissionsUpdated", serverId.ToString(), channelId.ToString());

        return Ok();
    }

    [HttpPatch("{serverId}/channels/reorder")]
    public async Task<IActionResult> ReorderChannels(Guid serverId, ReorderChannelsRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels)) return Forbid();
        if (!Enum.TryParse<ChannelType>(req.Type, ignoreCase: true, out var channelType))
            return BadRequest("Invalid channel type");

        var channels = await _db.Channels
            .Where(c => c.ServerId == serverId && c.Type == channelType)
            .ToListAsync();

        if (req.ChannelIds.Count != channels.Count) return BadRequest("Channel list does not match server channels.");

        var position = 0;
        foreach (var channelId in req.ChannelIds)
        {
            var channel = channels.FirstOrDefault(c => c.Id == channelId);
            if (channel == null) return BadRequest("Channel list contains invalid channel.");
            channel.Position = position++;
        }

        await _db.SaveChangesAsync();

        var allChannels = await _db.Channels
            .Where(c => c.ServerId == serverId)
            .OrderBy(c => c.Type)
            .ThenBy(c => c.Position)
            .Select(c => new ChannelDto(c.Id, c.Name, c.Type.ToString(), c.ServerId, c.Position, null, c.PersistentChat))
            .ToListAsync();

        await _hub.Clients.Group($"server:{serverId}").SendAsync("ChannelsReordered", serverId.ToString(), allChannels);
        return Ok();
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
            sm.MemberRoles.Select(mr => new ServerRoleDto(mr.Role.Id, mr.Role.Name, mr.Role.Color, mr.Role.Permissions, mr.Role.Position, mr.Role.IsDefault, mr.Role.DisplaySeparately)).ToList(),
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
        var roleDtos = updatedMember!.MemberRoles.Select(mr => new ServerRoleDto(mr.Role.Id, mr.Role.Name, mr.Role.Color, mr.Role.Permissions, mr.Role.Position, mr.Role.IsDefault, mr.Role.DisplaySeparately)).ToArray();
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

        // Remove role assignments and notification settings
        _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.ServerId == serverId && smr.UserId == userId));
        _db.UserServerNotificationSettings.RemoveRange(_db.UserServerNotificationSettings.Where(s => s.ServerId == serverId && s.UserId == userId));
        var channelIds = await _db.Channels.Where(c => c.ServerId == serverId).Select(c => c.Id).ToListAsync();
        _db.UserChannelNotificationSettings.RemoveRange(_db.UserChannelNotificationSettings.Where(s => s.UserId == userId && channelIds.Contains(s.ChannelId)));
        _db.ServerMembers.Remove(target);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.MemberKicked, UserId,
            targetId: userId, targetName: targetUser?.DisplayName);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberKicked", serverId.ToString(), userId);
        await _systemMessages.SendMemberJoinLeaveAsync(serverId, userId, joined: false);
        return Ok();
    }

    [HttpDelete("{serverId}/leave")]
    public async Task<IActionResult> LeaveServer(Guid serverId)
    {
        var member = await _perms.GetMemberAsync(serverId, UserId);
        if (member == null) return NotFound();
        if (member.IsOwner) return BadRequest("Server owner cannot leave.");

        _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.ServerId == serverId && smr.UserId == UserId));
        _db.UserServerNotificationSettings.RemoveRange(_db.UserServerNotificationSettings.Where(s => s.ServerId == serverId && s.UserId == UserId));
        var leaveChannelIds = await _db.Channels.Where(c => c.ServerId == serverId).Select(c => c.Id).ToListAsync();
        _db.UserChannelNotificationSettings.RemoveRange(_db.UserChannelNotificationSettings.Where(s => s.UserId == UserId && leaveChannelIds.Contains(s.ChannelId)));
        _db.ServerMembers.Remove(member);
        await _db.SaveChangesAsync();

        var targetUser = await _db.Users.FindAsync(UserId);
        await _perms.LogAsync(serverId, AuditAction.MemberLeft, UserId, targetId: UserId, targetName: targetUser?.DisplayName);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberKicked", serverId.ToString(), UserId);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("UserOffline", UserId);

        await _systemMessages.SendMemberJoinLeaveAsync(serverId, UserId, joined: false);

        var userConnections = ChatHub._connections
            .Where(c => c.Value == UserId)
            .Select(c => c.Key)
            .ToList();
        foreach (var connectionId in userConnections)
        {
            await _hub.Groups.RemoveFromGroupAsync(connectionId, $"server:{serverId}");
        }

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

        if (channel.Type == ChannelType.Text)
        {
            var server = await _db.Servers.FindAsync(serverId);
            if (server != null && server.JoinLeaveChannelId == channelId)
            {
                var replacement = await _db.Channels
                    .Where(c => c.ServerId == serverId && c.Type == ChannelType.Text && c.Id != channelId)
                    .OrderBy(c => c.Position)
                    .Select(c => (Guid?)c.Id)
                    .FirstOrDefaultAsync();
                server.JoinLeaveChannelId = replacement;
            }
        }

        _db.UserChannelNotificationSettings.RemoveRange(
            _db.UserChannelNotificationSettings.Where(s => s.ChannelId == channelId));
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
        _db.UserChannelNotificationSettings.RemoveRange(_db.UserChannelNotificationSettings.Where(s => channelIds.Contains(s.ChannelId)));
        _db.Channels.RemoveRange(_db.Channels.Where(c => c.ServerId == serverId));
        _db.Invites.RemoveRange(_db.Invites.Where(i => i.ServerId == serverId));
        _db.AuditLogs.RemoveRange(_db.AuditLogs.Where(a => a.ServerId == serverId));
        _db.ServerMemberRoles.RemoveRange(_db.ServerMemberRoles.Where(smr => smr.ServerId == serverId));
        _db.ServerRoles.RemoveRange(_db.ServerRoles.Where(r => r.ServerId == serverId));
        _db.ServerBans.RemoveRange(_db.ServerBans.Where(b => b.ServerId == serverId));
        _db.UserServerNotificationSettings.RemoveRange(_db.UserServerNotificationSettings.Where(s => s.ServerId == serverId));
        _db.ServerMembers.RemoveRange(_db.ServerMembers.Where(sm => sm.ServerId == serverId));
        _db.Servers.Remove(server);

        await _db.SaveChangesAsync();
        return Ok();
    }

    [HttpGet("{serverId}/search")]
    public async Task<ActionResult<SearchResponseDto>> SearchMessages(
        Guid serverId,
        [FromQuery] string q,
        [FromQuery] Guid? channelId = null,
        [FromQuery] string? authorId = null,
        [FromQuery] bool? hasAttachment = null,
        [FromQuery] DateTime? before = null,
        [FromQuery] DateTime? after = null,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 25)
    {
        if (string.IsNullOrWhiteSpace(q)) return BadRequest("Query is required.");
        limit = Math.Clamp(limit, 1, 50);

        var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == serverId && sm.UserId == UserId);
        if (!isMember) return Forbid();

        var textChannelIds = await _db.Channels
            .Where(c => c.ServerId == serverId && c.Type == ChannelType.Text)
            .Select(c => c.Id)
            .ToListAsync();

        if (channelId.HasValue && !textChannelIds.Contains(channelId.Value))
            return BadRequest("Channel not in this server.");

        var allowedChannelIds = new List<Guid>();
        foreach (var textChannelId in textChannelIds)
        {
            if (!await _perms.HasChannelPermissionAsync(textChannelId, UserId, Permission.ViewChannel)) continue;
            if (!await _perms.HasChannelPermissionAsync(textChannelId, UserId, Permission.ReadMessageHistory)) continue;
            allowedChannelIds.Add(textChannelId);
        }

        if (channelId.HasValue && !allowedChannelIds.Contains(channelId.Value))
            return Forbid();

        var targetChannels = channelId.HasValue ? new List<Guid> { channelId.Value } : allowedChannelIds;
        if (targetChannels.Count == 0)
            return Ok(new SearchResponseDto(new List<SearchResultDto>(), 0));

        var query = _db.Messages
            .Where(m => targetChannels.Contains(m.ChannelId) && !m.IsDeleted)
            .Where(m => EF.Functions.ILike(m.Content, $"%{q}%"));

        if (!string.IsNullOrEmpty(authorId))
            query = query.Where(m => m.AuthorId == authorId);
        if (hasAttachment == true)
            query = query.Where(m => m.Attachments.Any());
        if (before.HasValue)
            query = query.Where(m => m.CreatedAt < before.Value);
        if (after.HasValue)
            query = query.Where(m => m.CreatedAt > after.Value);

        var totalCount = await query.CountAsync();

        var messages = await query
            .OrderByDescending(m => m.CreatedAt)
            .Skip(offset)
            .Take(limit)
            .Include(m => m.Author)
            .Include(m => m.Channel)
            .Include(m => m.Attachments)
            .Select(m => new SearchResultDto(
                new MessageDto(
                    m.Id, m.Content, m.AuthorId,
                    new UserDto(m.Author.Id, m.Author.UserName!, m.Author.DisplayName, m.Author.AvatarUrl, m.Author.Status, m.Author.Bio),
                    m.ChannelId, m.CreatedAt,
                    m.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size)).ToList(),
                    m.EditedAt, m.IsDeleted, m.IsSystem,
                    new List<ReactionDto>(), null, null),
                m.Channel.Name ?? ""))
            .ToListAsync();

        return Ok(new SearchResponseDto(messages, totalCount));
    }

    [HttpGet("{serverId}/audit-logs")]
    public async Task<ActionResult<List<AuditLogDto>>> GetAuditLogs(Guid serverId, [FromQuery] int limit = 50)
    {
        //TODO: pagination would be nice here
        limit = Math.Clamp(limit, 1, 100);
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
