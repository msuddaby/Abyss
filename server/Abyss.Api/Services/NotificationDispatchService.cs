using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using FcmMessaging = FirebaseAdmin.Messaging;

namespace Abyss.Api.Services;

public class NotificationDispatchService : BackgroundService
{
    private static readonly Channel<Guid> _pushQueue =
        System.Threading.Channels.Channel.CreateUnbounded<Guid>(
            new UnboundedChannelOptions { SingleReader = true });

    private static readonly Channel<string> _offlineReplayQueue =
        System.Threading.Channels.Channel.CreateUnbounded<string>(
            new UnboundedChannelOptions { SingleReader = true });

    private readonly IServiceProvider _services;
    private readonly ILogger<NotificationDispatchService> _logger;

    public NotificationDispatchService(IServiceProvider services, ILogger<NotificationDispatchService> logger)
    {
        _services = services;
        _logger = logger;
    }

    public static void Enqueue(params Guid[] notificationIds)
    {
        foreach (var id in notificationIds)
            _pushQueue.Writer.TryWrite(id);
    }

    public static void EnqueueOfflineReplay(string userId)
    {
        _offlineReplayQueue.Writer.TryWrite(userId);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var queueTask = ProcessQueueAsync(stoppingToken);
        var sweepTask = ProcessSweepAsync(stoppingToken);
        var replayTask = ProcessOfflineReplayAsync(stoppingToken);

        await Task.WhenAll(queueTask, sweepTask, replayTask);
    }

    private async Task ProcessQueueAsync(CancellationToken ct)
    {
        await foreach (var notificationId in _pushQueue.Reader.ReadAllAsync(ct))
        {
            try
            {
                await SendPushForNotificationAsync(notificationId);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error sending push for notification {Id}", notificationId);
            }
        }
    }

    private async Task ProcessSweepAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);

            try
            {
                using var scope = _services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

                var pendingIds = await db.Notifications
                    .Where(n => n.PushStatus == PushStatus.Pending
                        && n.PushAttempts < 3
                        && !n.IsRead)
                    .OrderBy(n => n.CreatedAt)
                    .Select(n => n.Id)
                    .Take(100)
                    .ToListAsync(ct);

                if (pendingIds.Count > 0)
                {
                    _logger.LogInformation("Sweep: re-enqueuing {Count} pending notifications", pendingIds.Count);
                    Enqueue(pendingIds.ToArray());
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error during push sweep");
            }
        }
    }

    private async Task SendPushForNotificationAsync(Guid notificationId)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var fcm = scope.ServiceProvider.GetRequiredService<FcmMessaging.FirebaseMessaging>();

        var notification = await db.Notifications
            .Include(n => n.Message).ThenInclude(m => m.Author)
            .Include(n => n.Channel)
            .FirstOrDefaultAsync(n => n.Id == notificationId);

        if (notification == null) return;
        if (notification.IsRead || notification.PushStatus == PushStatus.Sent) return;

        // Check DND (PresenceStatus == 2)
        var user = await db.Users.FindAsync(notification.UserId);
        if (user == null) return;
        if (user.PresenceStatus == 2)
        {
            notification.PushStatus = PushStatus.None;
            await db.SaveChangesAsync();
            return;
        }

        if (fcm == null)
        {
            notification.PushStatus = PushStatus.Failed;
            await db.SaveChangesAsync();
            return;
        }

        // Get all device tokens for this user
        var pushTokens = await db.DevicePushTokens
            .Where(t => t.UserId == notification.UserId)
            .ToListAsync();

        if (pushTokens.Count == 0)
        {
            notification.PushStatus = PushStatus.None;
            await db.SaveChangesAsync();
            return;
        }

        notification.PushAttempts++;

        var author = notification.Message.Author;
        var channel = notification.Channel;
        var isDm = channel.Type == ChannelType.DM;
        var channelName = isDm ? $"@{author.DisplayName}" : $"#{channel.Name}";
        var contentPreview = notification.Message.Content.Length > 100
            ? notification.Message.Content[..100] + "..."
            : notification.Message.Content;
        var badgeCount = await db.Notifications
            .CountAsync(n => n.UserId == notification.UserId && !n.IsRead);

        var fcmMessages = pushTokens.Select(token => new FcmMessaging.Message
        {
            Token = token.Token,
            Notification = new FcmMessaging.Notification
            {
                Title = $"{author.DisplayName} in {channelName}",
                Body = contentPreview,
            },
            Data = new Dictionary<string, string>
            {
                ["channelId"] = notification.ChannelId.ToString(),
                ["serverId"] = notification.ServerId?.ToString() ?? "",
                ["messageId"] = notification.MessageId.ToString(),
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
        }).ToList();

        try
        {
            var response = await fcm.SendEachAsync(fcmMessages);

            // Auto-clean stale tokens
            var staleTokens = new List<DevicePushToken>();
            for (var i = 0; i < response.Responses.Count; i++)
            {
                var r = response.Responses[i];
                if (!r.IsSuccess &&
                    r.Exception?.MessagingErrorCode == FcmMessaging.MessagingErrorCode.Unregistered)
                {
                    var stale = pushTokens.FirstOrDefault(t => t.Token == fcmMessages[i].Token);
                    if (stale != null) staleTokens.Add(stale);
                }
            }

            if (staleTokens.Count > 0)
                db.DevicePushTokens.RemoveRange(staleTokens);

            notification.PushStatus = response.SuccessCount > 0 ? PushStatus.Sent : PushStatus.Failed;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "FCM send failed for notification {Id}", notificationId);
            notification.PushStatus = notification.PushAttempts >= 3 ? PushStatus.Failed : PushStatus.Pending;
        }

        await db.SaveChangesAsync();
    }

    private async Task ProcessOfflineReplayAsync(CancellationToken ct)
    {
        await foreach (var userId in _offlineReplayQueue.Reader.ReadAllAsync(ct))
        {
            try
            {
                // Grace period — wait 5 seconds then re-check if user is still offline
                _logger.LogInformation("[OfflineReplay] User {UserId} disconnected, waiting 5s grace period", userId);
                await Task.Delay(TimeSpan.FromSeconds(5), ct);

                if (ChatHub._connections.Values.Contains(userId))
                {
                    _logger.LogInformation("[OfflineReplay] User {UserId} reconnected within grace period — skipping", userId);
                    continue;
                }

                _logger.LogInformation("[OfflineReplay] User {UserId} still offline, running replay", userId);
                await SendOfflineReplayAsync(userId);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error processing offline replay for user {UserId}", userId);
            }
        }
    }

    private async Task SendOfflineReplayAsync(string userId)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var fcm = scope.ServiceProvider.GetRequiredService<FcmMessaging.FirebaseMessaging>();

        // Check DND
        var user = await db.Users.FindAsync(userId);
        if (user == null || user.PresenceStatus == 2)
        {
            _logger.LogInformation("[OfflineReplay] User {UserId} is null or DND (presence={Presence}) — skipping", userId, user?.PresenceStatus);
            return;
        }
        if (fcm == null)
        {
            _logger.LogInformation("[OfflineReplay] FCM not configured — skipping");
            return;
        }

        var cutoff = DateTime.UtcNow.AddHours(-1);
        var notifications = await db.Notifications
            .Include(n => n.Channel)
            .Where(n => n.UserId == userId
                && !n.IsRead
                && n.PushStatus == PushStatus.None
                && n.CreatedAt > cutoff)
            .ToListAsync();

        _logger.LogInformation("[OfflineReplay] User {UserId}: found {Count} unread notifications with PushStatus=None in last hour", userId, notifications.Count);
        if (notifications.Count == 0) return;

        // Group by channel for summary pushes
        var grouped = notifications.GroupBy(n => n.ChannelId);

        var pushTokens = await db.DevicePushTokens
            .Where(t => t.UserId == userId)
            .ToListAsync();

        if (pushTokens.Count == 0) return;

        var badgeCount = await db.Notifications
            .CountAsync(n => n.UserId == userId && !n.IsRead);

        foreach (var group in grouped)
        {
            var channel = group.First().Channel;
            var count = group.Count();
            var channelName = channel.Type == ChannelType.DM ? "a direct message" : $"#{channel.Name}";
            var body = $"{count} new message{(count == 1 ? "" : "s")} in {channelName}";

            var fcmMessages = pushTokens.Select(token => new FcmMessaging.Message
            {
                Token = token.Token,
                Notification = new FcmMessaging.Notification
                {
                    Title = "Abyss",
                    Body = body,
                },
                Data = new Dictionary<string, string>
                {
                    ["channelId"] = group.Key.ToString(),
                    ["serverId"] = group.First().ServerId?.ToString() ?? "",
                    ["type"] = "summary",
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
            }).ToList();

            try
            {
                var response = await fcm.SendEachAsync(fcmMessages);

                var staleTokens = new List<DevicePushToken>();
                for (var i = 0; i < response.Responses.Count; i++)
                {
                    if (!response.Responses[i].IsSuccess &&
                        response.Responses[i].Exception?.MessagingErrorCode == FcmMessaging.MessagingErrorCode.Unregistered)
                    {
                        var stale = pushTokens.FirstOrDefault(t => t.Token == fcmMessages[i].Token);
                        if (stale != null) staleTokens.Add(stale);
                    }
                }

                if (staleTokens.Count > 0)
                {
                    db.DevicePushTokens.RemoveRange(staleTokens);
                    // Remove from in-memory list so we don't try to send to them again
                    pushTokens.RemoveAll(t => staleTokens.Contains(t));
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "FCM offline replay failed for user {UserId}, channel {ChannelId}", userId, group.Key);
            }

            // Mark all as Sent regardless of individual token failures
            foreach (var n in group)
                n.PushStatus = PushStatus.Sent;
        }

        await db.SaveChangesAsync();
    }
}
