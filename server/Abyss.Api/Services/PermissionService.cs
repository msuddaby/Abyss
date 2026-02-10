using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public class PermissionService
{
    private readonly AppDbContext _db;
    public const long ChannelPermissionMask = (long)(
        Permission.ViewChannel |
        Permission.ReadMessageHistory |
        Permission.SendMessages |
        Permission.AddReactions |
        Permission.AttachFiles |
        Permission.MentionEveryone |
        Permission.Connect |
        Permission.Speak |
        Permission.Stream);

    public PermissionService(AppDbContext db) => _db = db;

    public Task<ServerMember?> GetMemberAsync(Guid serverId, string userId) =>
        _db.ServerMembers
            .Include(sm => sm.MemberRoles)
                .ThenInclude(mr => mr.Role)
            .FirstOrDefaultAsync(sm => sm.ServerId == serverId && sm.UserId == userId);

    public Task<bool> IsMemberAsync(Guid serverId, string userId) =>
        _db.ServerMembers.AnyAsync(sm => sm.ServerId == serverId && sm.UserId == userId);

    public Task<bool> IsBannedAsync(Guid serverId, string userId) =>
        _db.ServerBans.AnyAsync(b => b.ServerId == serverId && b.UserId == userId);

    public async Task<long> GetServerPermissionsAsync(Guid serverId, string userId)
    {
        var member = await GetMemberAsync(serverId, userId);
        if (member == null) return 0;
        if (member.IsOwner) return ~0L;
        return await ComputePermissionsAsync(serverId, member);
    }

    public Task<long> GetPermissionsAsync(Guid serverId, string userId) =>
        GetServerPermissionsAsync(serverId, userId);

    public async Task<long> GetChannelPermissionsAsync(Guid channelId, string userId)
    {
        var channel = await _db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
        if (channel == null) return 0;

        if (channel.Type == ChannelType.DM)
        {
            return channel.DmUser1Id == userId || channel.DmUser2Id == userId ? ~0L : 0;
        }

        if (!channel.ServerId.HasValue) return 0;

        var member = await GetMemberAsync(channel.ServerId.Value, userId);
        if (member == null) return 0;
        if (member.IsOwner) return ~0L;

        var perms = await ComputePermissionsAsync(channel.ServerId.Value, member);

        var roleIds = new HashSet<Guid>();
        var defaultRole = await _db.ServerRoles.AsNoTracking()
            .FirstOrDefaultAsync(r => r.ServerId == channel.ServerId.Value && r.IsDefault);
        if (defaultRole != null) roleIds.Add(defaultRole.Id);
        if (member.MemberRoles != null)
        {
            foreach (var mr in member.MemberRoles)
                roleIds.Add(mr.RoleId);
        }

        if (roleIds.Count == 0) return perms;

        var overrides = await _db.ChannelPermissionOverrides.AsNoTracking()
            .Where(o => o.ChannelId == channelId && roleIds.Contains(o.RoleId))
            .ToListAsync();

        if ((perms & ChannelPermissionMask) == 0)
        {
            // Default channel perms to enabled when nothing is explicitly set.
            perms |= ChannelPermissionMask;
        }

        if (defaultRole != null)
        {
            var everyoneOverride = overrides.FirstOrDefault(o => o.RoleId == defaultRole.Id);
            if (everyoneOverride != null)
            {
                perms = ApplyChannelOverride(perms, everyoneOverride.Allow, everyoneOverride.Deny);
            }
        }

        long combinedAllow = 0;
        long combinedDeny = 0;
        foreach (var ov in overrides)
        {
            if (defaultRole != null && ov.RoleId == defaultRole.Id) continue;
            combinedAllow |= ov.Allow;
            combinedDeny |= ov.Deny;
        }

        if (combinedAllow != 0 || combinedDeny != 0)
            perms = ApplyChannelOverride(perms, combinedAllow, combinedDeny);

        return perms;
    }

    public async Task<bool> HasPermissionAsync(Guid serverId, string userId, Permission perm)
    {
        var perms = await GetServerPermissionsAsync(serverId, userId);
        return (perms & (long)perm) == (long)perm;
    }

    public async Task<bool> HasChannelPermissionAsync(Guid channelId, string userId, Permission perm)
    {
        var perms = await GetChannelPermissionsAsync(channelId, userId);
        return (perms & (long)perm) == (long)perm;
    }

    public async Task<bool> IsOwnerAsync(Guid serverId, string userId)
    {
        var member = await _db.ServerMembers.FirstOrDefaultAsync(sm => sm.ServerId == serverId && sm.UserId == userId);
        return member is { IsOwner: true };
    }

    public static int GetHighestPosition(ServerMember member)
    {
        if (member.IsOwner) return int.MaxValue;
        if (member.MemberRoles == null || !member.MemberRoles.Any()) return 0;
        return member.MemberRoles.Max(mr => mr.Role.Position);
    }

    public async Task<bool> CanActOnAsync(Guid serverId, string actorId, string targetId)
    {
        if (actorId == targetId) return false;
        var actor = await GetMemberAsync(serverId, actorId);
        var target = await GetMemberAsync(serverId, targetId);
        if (actor == null || target == null) return false;
        if (target.IsOwner) return false;
        return GetHighestPosition(actor) > GetHighestPosition(target);
    }

    public async Task<bool> CanKickAsync(Guid serverId, string actorId, string targetId)
    {
        if (!await HasPermissionAsync(serverId, actorId, Permission.KickMembers)) return false;
        return await CanActOnAsync(serverId, actorId, targetId);
    }

    public async Task<bool> CanBanAsync(Guid serverId, string actorId, string targetId)
    {
        if (!await HasPermissionAsync(serverId, actorId, Permission.BanMembers)) return false;
        return await CanActOnAsync(serverId, actorId, targetId);
    }

    public async Task<bool> CanMuteAsync(Guid serverId, string actorId, string targetId)
    {
        if (!await HasPermissionAsync(serverId, actorId, Permission.MuteMembers)) return false;
        return await CanActOnAsync(serverId, actorId, targetId);
    }

    public Task<ServerRole?> GetDefaultRoleAsync(Guid serverId) =>
        _db.ServerRoles.FirstOrDefaultAsync(r => r.ServerId == serverId && r.IsDefault);

    public async Task LogAsync(Guid serverId, AuditAction action, string actorId,
        string? targetId = null, string? targetName = null, string? details = null)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            Action = action,
            ActorId = actorId,
            TargetId = targetId,
            TargetName = targetName,
            Details = details,
            CreatedAt = DateTime.UtcNow,
        });
        await _db.SaveChangesAsync();
    }

    private async Task<long> ComputePermissionsAsync(Guid serverId, ServerMember member)
    {
        long perms = 0;

        // Include @everyone role permissions
        var defaultRole = await _db.ServerRoles.AsNoTracking()
            .FirstOrDefaultAsync(r => r.ServerId == serverId && r.IsDefault);
        if (defaultRole != null)
            perms |= defaultRole.Permissions;

        // Union all assigned role permissions
        if (member.MemberRoles != null)
        {
            foreach (var mr in member.MemberRoles)
                perms |= mr.Role.Permissions;
        }

        return perms;
    }

    /// <summary>
    /// Batch-compute channel permissions for all members of the channel's server.
    /// Returns list of userIds that have the given permission.
    /// Loads all members + roles in a single query instead of N+1.
    /// </summary>
    public async Task<List<string>> GetUserIdsWithChannelPermissionAsync(Guid channelId, Permission perm)
    {
        var channel = await _db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
        if (channel?.ServerId == null) return new List<string>();

        var serverId = channel.ServerId.Value;

        // Single query: load all members with their roles
        var members = await _db.ServerMembers
            .Include(sm => sm.MemberRoles)
                .ThenInclude(mr => mr.Role)
            .Where(sm => sm.ServerId == serverId)
            .AsNoTracking()
            .ToListAsync();

        var defaultRole = await _db.ServerRoles.AsNoTracking()
            .FirstOrDefaultAsync(r => r.ServerId == serverId && r.IsDefault);

        var overrides = await _db.ChannelPermissionOverrides.AsNoTracking()
            .Where(o => o.ChannelId == channelId)
            .ToListAsync();

        var allowed = new List<string>();
        foreach (var member in members)
        {
            if (member.IsOwner)
            {
                allowed.Add(member.UserId);
                continue;
            }

            // Compute base server permissions
            long perms = 0;
            if (defaultRole != null)
                perms |= defaultRole.Permissions;
            if (member.MemberRoles != null)
            {
                foreach (var mr in member.MemberRoles)
                    perms |= mr.Role.Permissions;
            }

            // Gather role IDs for this member
            var roleIds = new HashSet<Guid>();
            if (defaultRole != null) roleIds.Add(defaultRole.Id);
            if (member.MemberRoles != null)
            {
                foreach (var mr in member.MemberRoles)
                    roleIds.Add(mr.RoleId);
            }

            // Apply channel overrides
            if ((perms & ChannelPermissionMask) == 0)
                perms |= ChannelPermissionMask;

            if (defaultRole != null)
            {
                var everyoneOverride = overrides.FirstOrDefault(o => o.RoleId == defaultRole.Id);
                if (everyoneOverride != null)
                    perms = ApplyChannelOverride(perms, everyoneOverride.Allow, everyoneOverride.Deny);
            }

            long combinedAllow = 0;
            long combinedDeny = 0;
            foreach (var ov in overrides)
            {
                if (!roleIds.Contains(ov.RoleId)) continue;
                if (defaultRole != null && ov.RoleId == defaultRole.Id) continue;
                combinedAllow |= ov.Allow;
                combinedDeny |= ov.Deny;
            }

            if (combinedAllow != 0 || combinedDeny != 0)
                perms = ApplyChannelOverride(perms, combinedAllow, combinedDeny);

            if ((perms & (long)perm) == (long)perm)
                allowed.Add(member.UserId);
        }

        return allowed;
    }

    private static long ApplyChannelOverride(long perms, long allow, long deny)
    {
        var allowMask = allow & ChannelPermissionMask;
        var denyMask = deny & ChannelPermissionMask;
        perms &= ~denyMask;
        perms |= allowMask;
        return perms;
    }
}
