using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Microsoft.AspNetCore.SignalR;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/admin")]
[Authorize]
public class AdminController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly Microsoft.AspNetCore.SignalR.IHubContext<Abyss.Api.Hubs.ChatHub> _hub;
    private readonly Services.PermissionService _perms;
    private readonly Services.LiveKitService _liveKit;
    private const string InviteOnlyKey = "InviteOnly";
    private const string MaxMessageLengthKey = "MaxMessageLength";
    private const string ForceRelayModeKey = "ForceRelayMode";
    private const int DefaultMaxMessageLength = 4000;
    private const int MaxMessageLengthUpperBound = 10000;
    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public AdminController(AppDbContext db, Microsoft.AspNetCore.SignalR.IHubContext<Abyss.Api.Hubs.ChatHub> hub, Services.PermissionService perms, Services.LiveKitService liveKit)
    {
        _db = db;
        _hub = hub;
        _perms = perms;
        _liveKit = liveKit;
    }

    private bool IsSysadmin() => User.HasClaim("sysadmin", "true");

    [HttpGet("overview")]
    public async Task<ActionResult<AdminOverviewStatsDto>> GetOverview()
    {
        if (!IsSysadmin()) return Forbid();

        var serverCount = await _db.Servers.CountAsync();
        var userCount = await _db.Users.CountAsync();
        var messageCount = await _db.Messages.CountAsync();

        return Ok(new AdminOverviewStatsDto(serverCount, userCount, messageCount));
    }

    [HttpGet("servers")]
    public async Task<ActionResult<AdminServersResponse>> GetServers(
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 50,
        [FromQuery] string? search = null,
        [FromQuery] string? sortBy = "name",
        [FromQuery] string? sortOrder = "asc")
    {
        if (!IsSysadmin()) return Forbid();

        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var query = _db.Servers
            .Include(s => s.Owner)
            .AsQueryable();

        // Search filtering
        if (!string.IsNullOrWhiteSpace(search))
        {
            var s = search.ToLower();
            query = query.Where(srv =>
                srv.Name.ToLower().Contains(s) ||
                srv.Owner.UserName!.ToLower().Contains(s) ||
                srv.Id.ToString().Contains(s));
        }

        var totalCount = await query.CountAsync();

        // Sorting
        query = sortBy?.ToLower() switch
        {
            "members" => sortOrder == "desc"
                ? query.OrderByDescending(s => s.Members.Count)
                : query.OrderBy(s => s.Members.Count),
            "channels" => sortOrder == "desc"
                ? query.OrderByDescending(s => s.Channels.Count)
                : query.OrderBy(s => s.Channels.Count),
            "created" => sortOrder == "desc"
                ? query.OrderByDescending(s => s.CreatedAt)
                : query.OrderBy(s => s.CreatedAt),
            _ => sortOrder == "desc"
                ? query.OrderByDescending(s => s.Name)
                : query.OrderBy(s => s.Name),
        };

        var servers = await query
            .Skip(offset)
            .Take(limit)
            .Select(s => new AdminServerDto(
                s.Id,
                s.Name,
                s.OwnerId,
                s.Owner.UserName ?? s.OwnerId,
                s.Members.Count,
                s.Channels.Count,
                s.CreatedAt))
            .ToListAsync();

        return Ok(new AdminServersResponse(servers, totalCount));
    }

    [HttpGet("users")]
    public async Task<ActionResult<AdminUsersResponse>> GetUsers(
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 50,
        [FromQuery] string? search = null,
        [FromQuery] string? sortBy = "username",
        [FromQuery] string? sortOrder = "asc")
    {
        if (!IsSysadmin()) return Forbid();

        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var query = _db.Users.AsQueryable();

        // Search filtering
        if (!string.IsNullOrWhiteSpace(search))
        {
            var s = search.ToLower();
            query = query.Where(u =>
                u.UserName!.ToLower().Contains(s) ||
                u.DisplayName.ToLower().Contains(s) ||
                u.Email!.ToLower().Contains(s) ||
                u.Id.Contains(s));
        }

        var totalCount = await query.CountAsync();

        // Sorting
        query = sortBy?.ToLower() switch
        {
            "displayname" => sortOrder == "desc"
                ? query.OrderByDescending(u => u.DisplayName)
                : query.OrderBy(u => u.DisplayName),
            "email" => sortOrder == "desc"
                ? query.OrderByDescending(u => u.Email)
                : query.OrderBy(u => u.Email),
            "created" => sortOrder == "desc"
                ? query.OrderByDescending(u => u.CreatedAt)
                : query.OrderBy(u => u.CreatedAt),
            _ => sortOrder == "desc"
                ? query.OrderByDescending(u => u.UserName)
                : query.OrderBy(u => u.UserName),
        };

        var users = await query
            .Skip(offset)
            .Take(limit)
            .Select(u => new AdminUserDto(
                u.Id,
                u.UserName!,
                u.DisplayName,
                u.Email,
                u.Status,
                u.AvatarUrl,
                u.CreatedAt))
            .ToListAsync();

        return Ok(new AdminUsersResponse(users, totalCount));
    }

    [HttpGet("settings")]
    public async Task<ActionResult<AdminSettingsDto>> GetSettings()
    {
        if (!IsSysadmin()) return Forbid();

        var inviteOnly = await GetInviteOnlyAsync();
        var maxMessageLength = await GetMaxMessageLengthAsync();
        var forceRelayMode = await GetForceRelayModeAsync();
        var codes = await _db.Invites
            .Where(i => i.ServerId == null)
            .OrderByDescending(c => c.CreatedAt)
            .Select(c => new InviteCodeDto(
                c.Id,
                c.Code,
                c.CreatorId,
                c.CreatedAt,
                c.ExpiresAt,
                c.MaxUses,
                c.Uses,
                c.LastUsedAt))
            .ToListAsync();

        return Ok(new AdminSettingsDto(inviteOnly, maxMessageLength, forceRelayMode, _liveKit.IsConfigured, codes));
    }

    [HttpPut("settings/invite-only")]
    public async Task<IActionResult> UpdateInviteOnly(UpdateInviteOnlyRequest request)
    {
        if (!IsSysadmin()) return Forbid();

        await SetInviteOnlyAsync(request.InviteOnly);
        return Ok(new { inviteOnly = request.InviteOnly });
    }

    [HttpPut("settings/max-message-length")]
    public async Task<IActionResult> UpdateMaxMessageLength(UpdateMaxMessageLengthRequest request)
    {
        if (!IsSysadmin()) return Forbid();
        var clamped = Math.Clamp(request.MaxMessageLength, 1, MaxMessageLengthUpperBound);
        await SetMaxMessageLengthAsync(clamped);
        await _hub.Clients.All.SendAsync("ConfigUpdated", new { maxMessageLength = clamped });
        return Ok(new { maxMessageLength = clamped });
    }

    [HttpPut("settings/force-relay-mode")]
    public async Task<IActionResult> UpdateForceRelayMode(UpdateForceRelayModeRequest request)
    {
        if (!IsSysadmin()) return Forbid();
        if (request.ForceRelayMode && !_liveKit.IsConfigured)
            return BadRequest("Cannot enable relay mode — LiveKit is not configured on this server.");

        await SetForceRelayModeAsync(request.ForceRelayMode);
        await _hub.Clients.All.SendAsync("ConfigUpdated", new { forceRelayMode = request.ForceRelayMode });
        return Ok(new { forceRelayMode = request.ForceRelayMode });
    }

    [HttpPost("invite-codes")]
    public async Task<ActionResult<InviteCodeDto>> CreateInviteCode(CreateInviteCodeRequest request)
    {
        if (!IsSysadmin()) return Forbid();

        var code = GenerateInviteCode();
        var userId = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;

        var invite = new Models.Invite
        {
            Code = code,
            CreatorId = userId,
            ExpiresAt = request.ExpiresAt,
            MaxUses = request.MaxUses
        };

        _db.Invites.Add(invite);
        await _db.SaveChangesAsync();

        return Ok(new InviteCodeDto(
            invite.Id,
            invite.Code,
            invite.CreatorId,
            invite.CreatedAt,
            invite.ExpiresAt,
            invite.MaxUses,
            invite.Uses,
            invite.LastUsedAt));
    }

    private async Task<bool> GetInviteOnlyAsync()
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == InviteOnlyKey);
        if (row == null) return false;
        return bool.TryParse(row.Value, out var value) && value;
    }

    private async Task<int> GetMaxMessageLengthAsync()
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == MaxMessageLengthKey);
        if (row == null || string.IsNullOrWhiteSpace(row.Value)) return DefaultMaxMessageLength;
        return int.TryParse(row.Value, out var value)
            ? Math.Clamp(value, 1, MaxMessageLengthUpperBound)
            : DefaultMaxMessageLength;
    }

    private async Task SetInviteOnlyAsync(bool enabled)
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == InviteOnlyKey);
        if (row == null)
        {
            row = new Models.AppConfig { Key = InviteOnlyKey, Value = enabled.ToString() };
            _db.AppConfigs.Add(row);
        }
        else
        {
            row.Value = enabled.ToString();
            row.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();
    }

    private async Task<bool> GetForceRelayModeAsync()
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == ForceRelayModeKey);
        if (row == null) return false;
        return bool.TryParse(row.Value, out var value) && value;
    }

    private async Task SetForceRelayModeAsync(bool enabled)
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == ForceRelayModeKey);
        if (row == null)
        {
            row = new Models.AppConfig { Key = ForceRelayModeKey, Value = enabled.ToString() };
            _db.AppConfigs.Add(row);
        }
        else
        {
            row.Value = enabled.ToString();
            row.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();
    }

    private async Task SetMaxMessageLengthAsync(int length)
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == MaxMessageLengthKey);
        if (row == null)
        {
            row = new Models.AppConfig { Key = MaxMessageLengthKey, Value = length.ToString() };
            _db.AppConfigs.Add(row);
        }
        else
        {
            row.Value = length.ToString();
            row.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();
    }

    private static string GenerateInviteCode()
    {

        var bytes = new byte[10];
        System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
        var chars = new char[10];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = Alphabet[bytes[i] % Alphabet.Length];
        }
        return new string(chars);
    }

    [HttpDelete("servers/{serverId:guid}")]
    public async Task<IActionResult> DeleteServer(Guid serverId)
    {
        if (!IsSysadmin()) return Forbid();

        var server = await _db.Servers.FindAsync(serverId);
        if (server == null) return NotFound("Server not found");

        // Notify all members BEFORE deletion
        await _hub.Clients.Group($"server:{serverId}").SendAsync("ServerDeleted", serverId.ToString());

        // Manual cleanup: Notifications (DeleteBehavior.NoAction)
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverId)
            .Select(c => c.Id)
            .ToListAsync();

        _db.Notifications.RemoveRange(
            _db.Notifications.Where(n => n.ServerId == serverId || channelIds.Contains(n.ChannelId))
        );

        // Cascade handles: ServerMembers, Channels→Messages→Reactions, Roles, Bans, Emojis, etc.
        _db.Servers.Remove(server);
        await _db.SaveChangesAsync();

        return Ok();
    }

    [HttpDelete("users/{userId}")]
    public async Task<IActionResult> DeleteUser(string userId)
    {
        if (!IsSysadmin()) return Forbid();

        // Prevent deleting other sysadmins
        var isSysadmin = await _db.UserClaims
            .AnyAsync(c => c.UserId == userId && c.ClaimType == "sysadmin" && c.ClaimValue == "true");

        if (isSysadmin)
            return BadRequest("Cannot delete a sysadmin user");

        var user = await _db.Users.FindAsync(userId);
        if (user == null) return NotFound("User not found");

        // Get affected entities for notifications
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == userId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        var friendIds = await _db.Friendships
            .Where(f => f.RequesterId == userId || f.AddresseeId == userId)
            .Select(f => f.RequesterId == userId ? f.AddresseeId : f.RequesterId)
            .Distinct()
            .ToListAsync();

        // Notify affected users BEFORE deletion
        foreach (var serverId in serverIds)
        {
            await _hub.Clients.Group($"server:{serverId}").SendAsync("MemberKicked", serverId.ToString(), userId);
        }

        foreach (var friendId in friendIds)
        {
            await _hub.Clients.Group($"user:{friendId}").SendAsync("FriendRemoved", userId);
        }

        // Manual cleanup (entities with NoAction or no User-side cascade)

        // 1. ServerMembers (required FK but doesn't cascade from User side)
        _db.ServerMembers.RemoveRange(_db.ServerMembers.Where(sm => sm.UserId == userId));

        // 2. Friendships (DeleteBehavior.NoAction)
        _db.Friendships.RemoveRange(
            _db.Friendships.Where(f => f.RequesterId == userId || f.AddresseeId == userId)
        );

        // 3. DM Channels (DeleteBehavior.NoAction)
        var dmChannels = await _db.Channels
            .Where(c => c.DmUser1Id == userId || c.DmUser2Id == userId)
            .ToListAsync();

        foreach (var dm in dmChannels)
        {
            var otherUserId = dm.DmUser1Id == userId ? dm.DmUser2Id : dm.DmUser1Id;
            var otherUserExists = await _db.Users.AnyAsync(u => u.Id == otherUserId);

            if (!otherUserExists)
            {
                // Both users gone - delete channel and messages
                var dmMessageIds = await _db.Messages.Where(m => m.ChannelId == dm.Id).Select(m => m.Id).ToListAsync();
                _db.Reactions.RemoveRange(_db.Reactions.Where(r => dmMessageIds.Contains(r.MessageId)));
                _db.Attachments.RemoveRange(_db.Attachments.Where(a => a.MessageId.HasValue && dmMessageIds.Contains(a.MessageId.Value)));
                _db.Messages.RemoveRange(_db.Messages.Where(m => m.ChannelId == dm.Id));
                _db.Channels.Remove(dm);
            }
            else
            {
                // Other user exists - nullify deleted user's reference
                if (dm.DmUser1Id == userId) dm.DmUser1Id = null;
                if (dm.DmUser2Id == userId) dm.DmUser2Id = null;
            }
        }

        // 4. Notifications (DeleteBehavior.NoAction)
        _db.Notifications.RemoveRange(_db.Notifications.Where(n => n.UserId == userId));

        // Note: Messages will be SET_NULL on AuthorId (already configured)
        // Note: DevicePushTokens, RefreshTokens, UserPreferences, UserCosmetics cascade automatically

        _db.Users.Remove(user);
        await _db.SaveChangesAsync();

        return Ok();
    }

    [HttpDelete("invite-codes/{codeId:guid}")]
    public async Task<IActionResult> DeleteInviteCode(Guid codeId)
    {
        if (!IsSysadmin()) return Forbid();

        var code = await _db.Invites.FindAsync(codeId);
        if (code == null || code.ServerId != null) return NotFound("Invite code not found");

        _db.Invites.Remove(code);
        await _db.SaveChangesAsync();

        return Ok();
    }

    [HttpPost("servers/{serverId:guid}/transfer-owner")]
    public async Task<IActionResult> TransferServerOwnership(Guid serverId, TransferServerOwnershipRequest request)
    {
        if (!IsSysadmin()) return Forbid();
        if (string.IsNullOrWhiteSpace(request.NewOwnerId))
            return BadRequest("NewOwnerId is required");

        var server = await _db.Servers
            .Include(s => s.Owner)
            .FirstOrDefaultAsync(s => s.Id == serverId);

        if (server == null) return NotFound("Server not found");

        var newOwner = await _db.Users.FindAsync(request.NewOwnerId);
        if (newOwner == null) return NotFound("New owner not found");

        if (server.OwnerId == request.NewOwnerId)
            return BadRequest("User is already the owner");

        var oldOwnerId = server.OwnerId;

        // Update old owner's membership (remove IsOwner flag)
        var oldOwnerMember = await _db.ServerMembers
            .FirstOrDefaultAsync(sm => sm.ServerId == serverId && sm.UserId == oldOwnerId);

        if (oldOwnerMember != null)
        {
            oldOwnerMember.IsOwner = false;
        }

        // Update or create new owner's membership
        var newOwnerMember = await _db.ServerMembers
            .FirstOrDefaultAsync(sm => sm.ServerId == serverId && sm.UserId == request.NewOwnerId);

        if (newOwnerMember == null)
        {
            // New owner not a member - create membership
            newOwnerMember = new Models.ServerMember
            {
                ServerId = serverId,
                UserId = request.NewOwnerId,
                IsOwner = true,
                JoinedAt = DateTime.UtcNow
            };
            _db.ServerMembers.Add(newOwnerMember);
        }
        else
        {
            newOwnerMember.IsOwner = true;
        }

        // Update server owner
        server.OwnerId = request.NewOwnerId;

        await _db.SaveChangesAsync();

        // Audit logging
        var currentUserId = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "system";
        await _perms.LogAsync(serverId, Models.AuditAction.ServerUpdated, currentUserId,
            targetId: request.NewOwnerId, targetName: newOwner.UserName, details: "Ownership transferred");

        // Notify server members of ownership change
        var updatedServer = await _db.Servers
            .Where(s => s.Id == serverId)
            .Select(s => new
            {
                s.Id,
                s.Name,
                s.IconUrl,
                s.OwnerId,
                s.DefaultNotificationLevel,
                s.JoinLeaveMessagesEnabled,
                s.JoinLeaveChannelId,
                s.CreatedAt
            })
            .FirstAsync();

        await _hub.Clients.Group($"server:{serverId}").SendAsync("ServerUpdated", serverId.ToString(), updatedServer);

        return Ok(new { message = "Ownership transferred successfully" });
    }
}
