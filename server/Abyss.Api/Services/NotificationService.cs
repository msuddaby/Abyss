using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Models;
using FcmMessaging = FirebaseAdmin.Messaging;

namespace Abyss.Api.Services;

public class NotificationService
{
    private readonly AppDbContext _db;
    private readonly FcmMessaging.FirebaseMessaging? _fcm;
    private readonly PermissionService _perms;
    private static readonly Regex MentionRegex = new(@"<@([a-zA-Z0-9-]+)>", RegexOptions.Compiled);

    public NotificationService(AppDbContext db, FcmMessaging.FirebaseMessaging? fcm, PermissionService perms)
    {
        _db = db;
        _fcm = fcm;
        _perms = perms;
    }

    public record MentionParseResult(
        List<string> UserIds,
        bool HasEveryone,
        bool HasHere
    );

    public MentionParseResult ParseMentions(string content)
    {
        var userIds = new List<string>();
        foreach (Match match in MentionRegex.Matches(content))
        {
            userIds.Add(match.Groups[1].Value);
        }

        var hasEveryone = content.Contains("@everyone");
        var hasHere = content.Contains("@here");

        return new MentionParseResult(userIds, hasEveryone, hasHere);
    }

    public async Task<bool> ShouldNotify(
        string userId, Guid serverId, Guid channelId, NotificationType type)
    {
        // 1. Channel muted?
        var channelSetting = await _db.UserChannelNotificationSettings
            .FirstOrDefaultAsync(s => s.ChannelId == channelId && s.UserId == userId);
        if (channelSetting?.MuteUntil != null && channelSetting.MuteUntil > DateTime.UtcNow)
            return false;

        // 2. Server muted?
        var serverSetting = await _db.UserServerNotificationSettings
            .FirstOrDefaultAsync(s => s.ServerId == serverId && s.UserId == userId);
        if (serverSetting?.MuteUntil != null && serverSetting.MuteUntil > DateTime.UtcNow)
            return false;

        // 3. SuppressEveryone + @everyone/@here type?
        if (serverSetting?.SuppressEveryone == true &&
            (type == NotificationType.EveryoneMention || type == NotificationType.HereMention))
            return false;

        // 4. Resolve effective level
        var server = await _db.Servers.AsNoTracking().FirstOrDefaultAsync(s => s.Id == serverId);
        var defaultLevel = server?.DefaultNotificationLevel ?? NotificationLevel.AllMessages;
        var effectiveLevel = channelSetting?.NotificationLevel
            ?? serverSetting?.NotificationLevel
            ?? defaultLevel;

        // 5. Apply level
        return effectiveLevel switch
        {
            NotificationLevel.Nothing => false,
            NotificationLevel.OnlyMentions => type == NotificationType.UserMention || type == NotificationType.ReplyMention,
            _ => true // AllMessages
        };
    }

    public async Task<List<Notification>> CreateMentionNotifications(
        Message message, Guid serverId, Guid channelId,
        HashSet<string> onlineUserIds)
    {
        var mentions = ParseMentions(message.Content);
        var notifications = new List<Notification>();
        var notifiedUsers = new HashSet<string>();

        // Batch-load notification settings for all server members
        var serverSettings = await _db.UserServerNotificationSettings
            .Where(s => s.ServerId == serverId)
            .ToDictionaryAsync(s => s.UserId);
        var channelSettings = await _db.UserChannelNotificationSettings
            .Where(s => s.ChannelId == channelId)
            .ToDictionaryAsync(s => s.UserId);
        var server = await _db.Servers.AsNoTracking().FirstOrDefaultAsync(s => s.Id == serverId);
        var defaultLevel = server?.DefaultNotificationLevel ?? NotificationLevel.AllMessages;

        bool ShouldNotifyLocal(string userId, NotificationType type)
        {
            channelSettings.TryGetValue(userId, out var chSetting);
            serverSettings.TryGetValue(userId, out var svSetting);

            if (chSetting?.MuteUntil != null && chSetting.MuteUntil > DateTime.UtcNow) return false;
            if (svSetting?.MuteUntil != null && svSetting.MuteUntil > DateTime.UtcNow) return false;
            if (svSetting?.SuppressEveryone == true &&
                (type == NotificationType.EveryoneMention || type == NotificationType.HereMention))
                return false;

            var effectiveLevel = chSetting?.NotificationLevel ?? svSetting?.NotificationLevel ?? defaultLevel;
            return effectiveLevel switch
            {
                NotificationLevel.Nothing => false,
                NotificationLevel.OnlyMentions => type == NotificationType.UserMention || type == NotificationType.ReplyMention,
                _ => true
            };
        }

        // Direct user mentions
        foreach (var userId in mentions.UserIds)
        {
            if (userId == message.AuthorId) continue;
            if (!notifiedUsers.Add(userId)) continue;

            // Verify user is a server member
            var isMember = await _db.ServerMembers
                .AnyAsync(sm => sm.ServerId == serverId && sm.UserId == userId);
            if (!isMember) continue;
            if (!await _perms.HasChannelPermissionAsync(channelId, userId, Permission.ViewChannel)) continue;
            if (!ShouldNotifyLocal(userId, NotificationType.UserMention)) continue;

            notifications.Add(new Notification
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                MessageId = message.Id,
                ChannelId = channelId,
                ServerId = serverId,
                Type = NotificationType.UserMention,
                IsRead = false,
                CreatedAt = DateTime.UtcNow
            });
        }

        // @everyone — all server members except author
        if (mentions.HasEveryone)
        {
            var memberIds = await _db.ServerMembers
                .Where(sm => sm.ServerId == serverId && sm.UserId != message.AuthorId)
                .Select(sm => sm.UserId)
                .ToListAsync();

            foreach (var userId in memberIds)
            {
                if (!notifiedUsers.Add(userId)) continue;
                if (!await _perms.HasChannelPermissionAsync(channelId, userId, Permission.ViewChannel)) continue;
                if (!ShouldNotifyLocal(userId, NotificationType.EveryoneMention)) continue;
                notifications.Add(new Notification
                {
                    Id = Guid.NewGuid(),
                    UserId = userId,
                    MessageId = message.Id,
                    ChannelId = channelId,
                    ServerId = serverId,
                    Type = NotificationType.EveryoneMention,
                    IsRead = false,
                    CreatedAt = DateTime.UtcNow
                });
            }
        }

        // @here — online server members except author
        if (mentions.HasHere)
        {
            var memberIds = await _db.ServerMembers
                .Where(sm => sm.ServerId == serverId && sm.UserId != message.AuthorId)
                .Select(sm => sm.UserId)
                .ToListAsync();

            var onlineMembers = memberIds.Where(id => onlineUserIds.Contains(id));

            foreach (var userId in onlineMembers)
            {
                if (!notifiedUsers.Add(userId)) continue;
                if (!await _perms.HasChannelPermissionAsync(channelId, userId, Permission.ViewChannel)) continue;
                if (!ShouldNotifyLocal(userId, NotificationType.HereMention)) continue;
                notifications.Add(new Notification
                {
                    Id = Guid.NewGuid(),
                    UserId = userId,
                    MessageId = message.Id,
                    ChannelId = channelId,
                    ServerId = serverId,
                    Type = NotificationType.HereMention,
                    IsRead = false,
                    CreatedAt = DateTime.UtcNow
                });
            }
        }

        if (notifications.Count > 0)
        {
            _db.Notifications.AddRange(notifications);
            await _db.SaveChangesAsync();

            // Send push notifications to offline users
            await SendPushNotifications(notifications, onlineUserIds, message);
        }

        return notifications;
    }

    public async Task SendPushNotifications(
        List<Notification> notifications,
        HashSet<string> onlineUserIds,
        Message message)
    {
        if (_fcm == null) return;

        // Only send push to offline users
        var offlineUserIds = notifications
            .Select(n => n.UserId)
            .Where(userId => !onlineUserIds.Contains(userId))
            .Distinct()
            .ToList();

        if (offlineUserIds.Count == 0) return;

        // Get push tokens for offline users
        var pushTokens = await _db.DevicePushTokens
            .Where(t => offlineUserIds.Contains(t.UserId))
            .Include(t => t.User)
            .ToListAsync();

        if (pushTokens.Count == 0) return;

        // Get author info
        var author = await _db.Users.FindAsync(message.AuthorId);
        if (author == null) return;

        // Get channel info
        var channel = await _db.Channels.FindAsync(message.ChannelId);
        if (channel == null) return;

        // Prepare FCM messages
        var fcmMessages = new List<FcmMessaging.Message>();
        foreach (var token in pushTokens)
        {
            var userNotifications = notifications
                .Where(n => n.UserId == token.UserId)
                .ToList();

            if (userNotifications.Count == 0) continue;

            var isDm = channel.Type == ChannelType.DM;
            var channelName = isDm ? $"@{author.DisplayName}" : $"#{channel.Name}";
            var contentPreview = message.Content.Length > 100
                ? message.Content[..100] + "..."
                : message.Content;
            var badgeCount = await GetUnreadMentionCount(token.UserId);

            fcmMessages.Add(new FcmMessaging.Message
            {
                Token = token.Token,
                Notification = new FcmMessaging.Notification
                {
                    Title = $"{author.DisplayName} in {channelName}",
                    Body = contentPreview,
                },
                Data = new Dictionary<string, string>
                {
                    ["channelId"] = message.ChannelId.ToString(),
                    ["serverId"] = channel.ServerId?.ToString() ?? "",
                    ["messageId"] = message.Id.ToString(),
                    ["type"] = "message",
                },
                Android = new FcmMessaging.AndroidConfig
                {
                    Notification = new FcmMessaging.AndroidNotification
                    {
                        Sound = "default",
                        ChannelId = "messages",
                    },
                },
                Apns = new FcmMessaging.ApnsConfig
                {
                    Aps = new FcmMessaging.Aps
                    {
                        Badge = badgeCount,
                        Sound = "default",
                    },
                },
            });
        }

        if (fcmMessages.Count == 0) return;

        try
        {
            var response = await _fcm.SendEachAsync(fcmMessages);

            // Auto-clean stale/unregistered tokens
            var staleTokens = new List<DevicePushToken>();
            for (var i = 0; i < response.Responses.Count; i++)
            {
                var r = response.Responses[i];
                if (!r.IsSuccess && r.Exception?.MessagingErrorCode == FcmMessaging.MessagingErrorCode.Unregistered)
                {
                    var staleTokenValue = fcmMessages[i].Token;
                    var stale = pushTokens.FirstOrDefault(t => t.Token == staleTokenValue);
                    if (stale != null) staleTokens.Add(stale);
                }
            }

            if (staleTokens.Count > 0)
            {
                _db.DevicePushTokens.RemoveRange(staleTokens);
                await _db.SaveChangesAsync();
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error sending FCM push notification: {ex.Message}");
        }
    }


    private async Task<int> GetUnreadMentionCount(string userId)
    {
        return await _db.Notifications
            .CountAsync(n => n.UserId == userId && !n.IsRead);
    }

    public async Task MarkChannelRead(string userId, Guid channelId)
    {
        var existing = await _db.ChannelReads
            .FirstOrDefaultAsync(cr => cr.ChannelId == channelId && cr.UserId == userId);

        if (existing != null)
        {
            existing.LastReadAt = DateTime.UtcNow;
        }
        else
        {
            _db.ChannelReads.Add(new ChannelRead
            {
                ChannelId = channelId,
                UserId = userId,
                LastReadAt = DateTime.UtcNow
            });
        }

        // Mark all unread notifications for this channel as read
        var unreadNotifications = await _db.Notifications
            .Where(n => n.UserId == userId && n.ChannelId == channelId && !n.IsRead)
            .ToListAsync();

        foreach (var n in unreadNotifications)
            n.IsRead = true;

        await _db.SaveChangesAsync();
    }

    public async Task<List<ChannelUnreadDto>> GetUnreadChannels(string userId, Guid serverId)
    {
        var channels = await _db.Channels
            .Where(c => c.ServerId == serverId && c.Type == ChannelType.Text)
            .Select(c => new { c.Id })
            .ToListAsync();

        var channelIds = new List<Guid>();
        foreach (var channel in channels)
        {
            if (await _perms.HasChannelPermissionAsync(channel.Id, userId, Permission.ViewChannel))
                channelIds.Add(channel.Id);
        }

        if (channelIds.Count == 0) return new List<ChannelUnreadDto>();

        // Get user's read timestamps
        var reads = await _db.ChannelReads
            .Where(cr => cr.UserId == userId && channelIds.Contains(cr.ChannelId))
            .ToDictionaryAsync(cr => cr.ChannelId, cr => cr.LastReadAt);

        // Get latest message timestamp per channel
        var latestMessages = await _db.Messages
            .Where(m => channelIds.Contains(m.ChannelId) && !m.IsDeleted)
            .GroupBy(m => m.ChannelId)
            .Select(g => new { ChannelId = g.Key, LatestAt = g.Max(m => m.CreatedAt) })
            .ToDictionaryAsync(x => x.ChannelId, x => x.LatestAt);

        // Get unread mention counts per channel
        var mentionCounts = await _db.Notifications
            .Where(n => n.UserId == userId && n.ServerId == serverId && !n.IsRead)
            .GroupBy(n => n.ChannelId)
            .Select(g => new { ChannelId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.ChannelId, x => x.Count);

        var result = new List<ChannelUnreadDto>();
        foreach (var ch in channels.Where(c => channelIds.Contains(c.Id)))
        {
            var hasLatest = latestMessages.TryGetValue(ch.Id, out var latestAt);
            var hasRead = reads.TryGetValue(ch.Id, out var readAt);
            var hasUnread = hasLatest && (!hasRead || latestAt > readAt);
            mentionCounts.TryGetValue(ch.Id, out var mentions);

            result.Add(new ChannelUnreadDto(ch.Id, hasUnread, mentions));
        }

        return result;
    }

    public async Task<List<ServerUnreadDto>> GetAllServerUnreads(string userId)
    {
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == userId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        var result = new List<ServerUnreadDto>();

        foreach (var serverId in serverIds)
        {
            var channelUnreads = await GetUnreadChannels(userId, serverId);
            var hasUnread = channelUnreads.Any(c => c.HasUnread);
            var mentionCount = channelUnreads.Sum(c => c.MentionCount);
            result.Add(new ServerUnreadDto(serverId, hasUnread, mentionCount));
        }

        return result;
    }

    public async Task<List<DmUnreadDto>> GetDmUnreads(string userId)
    {
        var dmChannels = await _db.Channels
            .Where(c => c.Type == ChannelType.DM && (c.DmUser1Id == userId || c.DmUser2Id == userId))
            .Select(c => new { c.Id })
            .ToListAsync();

        var channelIds = dmChannels.Select(c => c.Id).ToList();

        var reads = await _db.ChannelReads
            .Where(cr => cr.UserId == userId && channelIds.Contains(cr.ChannelId))
            .ToDictionaryAsync(cr => cr.ChannelId, cr => cr.LastReadAt);

        var latestMessages = await _db.Messages
            .Where(m => channelIds.Contains(m.ChannelId) && !m.IsDeleted)
            .GroupBy(m => m.ChannelId)
            .Select(g => new { ChannelId = g.Key, LatestAt = g.Max(m => m.CreatedAt) })
            .ToDictionaryAsync(x => x.ChannelId, x => x.LatestAt);

        var mentionCounts = await _db.Notifications
            .Where(n => n.UserId == userId && n.ServerId == null && !n.IsRead)
            .GroupBy(n => n.ChannelId)
            .Select(g => new { ChannelId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.ChannelId, x => x.Count);

        var result = new List<DmUnreadDto>();
        foreach (var ch in dmChannels)
        {
            var hasLatest = latestMessages.TryGetValue(ch.Id, out var latestAt);
            var hasRead = reads.TryGetValue(ch.Id, out var readAt);
            var hasUnread = hasLatest && (!hasRead || latestAt > readAt);
            mentionCounts.TryGetValue(ch.Id, out var mentions);

            result.Add(new DmUnreadDto(ch.Id, hasUnread, mentions));
        }

        return result;
    }
}
