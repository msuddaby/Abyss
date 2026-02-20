using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Hubs;

[Authorize]
public class ChatHub : Hub
{
    private readonly AppDbContext _db;
    private readonly VoiceStateService _voiceState;
    private readonly PermissionService _perms;
    private readonly NotificationService _notifications;
    private readonly WatchPartyService _watchPartyService;
    private readonly CosmeticService _cosmetics;
    private readonly HubRateLimiter _rateLimiter;

    private const int DefaultMaxMessageLength = 4000;
    private const int MaxMessageLengthUpperBound = 10000;
    private const int MaxAttachmentsPerMessage = 10;
    private const int MaxPinnedMessagesPerChannel = 50;
    private const string MaxMessageLengthKey = "MaxMessageLength";
    private static readonly TimeSpan VoiceDisconnectGracePeriod = TimeSpan.FromSeconds(30);

    // Track online users: connectionId -> userId
    internal static readonly ConcurrentDictionary<string, string> _connections = new();
    // Track which channel each user is actively viewing: userId -> channelId
    private static readonly ConcurrentDictionary<string, Guid> _activeChannels = new();
    private static readonly ConcurrentDictionary<string, PendingVoiceDisconnect> _pendingVoiceDisconnects = new();

    // Guest activity tracking: userId -> last DB write time (throttle to once per hour)
    private static readonly ConcurrentDictionary<string, DateTime> _guestActivityWrites = new();

    // Heartbeat tracking for server-side idle detection
    internal static readonly ConcurrentDictionary<string, DateTime> _lastHeartbeats = new();
    // Users that were auto-set to Away by the server (so we can restore on reconnect)
    internal static readonly ConcurrentDictionary<string, byte> _serverAutoAway = new();

    private sealed class PendingVoiceDisconnect
    {
        public PendingVoiceDisconnect(string? expectedVoiceConnectionId)
        {
            ExpectedVoiceConnectionId = expectedVoiceConnectionId;
        }

        public string? ExpectedVoiceConnectionId { get; }
        public CancellationTokenSource Cancellation { get; } = new();
    }

    public ChatHub(AppDbContext db, VoiceStateService voiceState, PermissionService perms, NotificationService notifications, WatchPartyService watchPartyService, CosmeticService cosmetics, HubRateLimiter rateLimiter)
    {
        _db = db;
        _voiceState = voiceState;
        _perms = perms;
        _notifications = notifications;
        _watchPartyService = watchPartyService;
        _cosmetics = cosmetics;
        _rateLimiter = rateLimiter;
    }

    private string UserId => Context.User!.FindFirstValue(ClaimTypes.NameIdentifier)!;
    private string DisplayName => Context.User!.FindFirstValue("displayName") ?? "Unknown";

    private async Task<bool> CanAccessChannel(Channel channel)
    {
        if (channel.Type == ChannelType.DM)
            return channel.DmUser1Id == UserId || channel.DmUser2Id == UserId;
        if (channel.ServerId.HasValue)
            return await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.ViewChannel);
        return false;
    }

    private Task<List<string>> GetUserIdsWithChannelPermission(Guid channelId, Permission perm)
    {
        return _perms.GetUserIdsWithChannelPermissionAsync(channelId, perm);
    }

    private async Task<string?> GetSoundUrl(string userId, string type)
    {
        var prefs = await _db.UserPreferences.AsNoTracking()
            .Where(p => p.UserId == userId)
            .Select(p => type == "join" ? p.JoinSoundUrl : p.LeaveSoundUrl)
            .FirstOrDefaultAsync();
        return prefs;
    }

    private static void CancelPendingVoiceDisconnect(string userId)
    {
        if (_pendingVoiceDisconnects.TryRemove(userId, out var pending))
        {
            pending.Cancellation.Cancel();
        }
    }

    private static PendingVoiceDisconnect ReplacePendingVoiceDisconnect(string userId, string? expectedVoiceConnectionId)
    {
        var pending = new PendingVoiceDisconnect(expectedVoiceConnectionId);

        while (true)
        {
            if (_pendingVoiceDisconnects.TryAdd(userId, pending))
            {
                return pending;
            }

            if (_pendingVoiceDisconnects.TryRemove(userId, out var existing))
            {
                existing.Cancellation.Cancel();
            }
        }
    }

    private async Task SendCurrentVoiceChannelStateToCaller(Guid channelGuid, string channelId)
    {
        var users = _voiceState.GetChannelUsersDisplayNames(channelGuid);
        await Clients.Caller.SendAsync("VoiceChannelUsers", users);

        var currentSharers = _voiceState.GetScreenSharers(channelGuid);
        if (currentSharers.Count > 0)
        {
            await Clients.Caller.SendAsync("ActiveSharers", currentSharers);
        }

        var currentCameras = _voiceState.GetCameraUsers(channelGuid);
        if (currentCameras.Count > 0)
        {
            await Clients.Caller.SendAsync("ActiveCameras", currentCameras);
        }

        if (_voiceState.ChannelHasRelayUsers(channelGuid))
        {
            await Clients.Caller.SendAsync("ChannelRelayActive");
        }

        var watchParty = _watchPartyService.GetParty(channelGuid);
        if (watchParty != null)
        {
            var wpDto = new WatchPartyDto(
                watchParty.Id, watchParty.ChannelId, watchParty.MediaProviderConnectionId,
                watchParty.HostUserId, watchParty.ProviderItemId, watchParty.ItemTitle,
                watchParty.ItemThumbnail, watchParty.ItemDurationMs, watchParty.CurrentTimeMs,
                watchParty.IsPlaying, watchParty.LastSyncAt, watchParty.Queue, watchParty.StartedAt,
                watchParty.ProviderType);
            await Clients.Caller.SendAsync("WatchPartyActive", wpDto);
        }
    }

    private static bool TryNormalizeAndValidateMessageForSend(string content, int attachmentCount, int maxMessageLength, out string normalized, out string? error)
    {
        error = null;
        normalized = content;

        if (attachmentCount > MaxAttachmentsPerMessage)
        {
            error = $"Maximum {MaxAttachmentsPerMessage} attachments per message";
            return false;
        }

        if (string.IsNullOrWhiteSpace(content))
        {
            if (attachmentCount == 0)
            {
                error = $"Message must be 1-{maxMessageLength} characters";
                return false;
            }

            normalized = string.Empty;
        }

        if (normalized.Length > maxMessageLength)
        {
            error = $"Message must be 1-{maxMessageLength} characters";
            return false;
        }

        return true;
    }

    private static bool TryValidateMessageForEdit(string newContent, int maxMessageLength, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(newContent) || newContent.Length > maxMessageLength)
        {
            error = $"Message must be 1-{maxMessageLength} characters";
            return false;
        }

        return true;
    }

    private async Task<int> GetMaxMessageLengthAsync()
    {
        var row = await _db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(c => c.Key == MaxMessageLengthKey);
        if (row == null || string.IsNullOrWhiteSpace(row.Value)) return DefaultMaxMessageLength;
        return int.TryParse(row.Value, out var value)
            ? Math.Clamp(value, 1, MaxMessageLengthUpperBound)
            : DefaultMaxMessageLength;
    }

    private async Task SendSystemMessageAsync(Channel channel, string authorId, string content)
    {
        var message = new Message
        {
            Id = Guid.NewGuid(),
            Content = content,
            AuthorId = authorId,
            ChannelId = channel.Id,
            CreatedAt = DateTime.UtcNow,
            IsSystem = true,
        };

        _db.Messages.Add(message);

        if (channel.Type == ChannelType.DM)
        {
            channel.LastMessageAt = message.CreatedAt;
        }

        await _db.SaveChangesAsync();

        var author = await _db.Users.FindAsync(authorId);
        if (author == null) return;

        var authorDto = new UserDto(author.Id, author.UserName!, author.DisplayName, author.AvatarUrl, author.Status, author.Bio, author.PresenceStatus);
        var messageDto = new MessageDto(
            message.Id,
            message.Content,
            message.AuthorId,
            authorDto,
            message.ChannelId,
            message.CreatedAt,
            new List<AttachmentDto>(),
            null,
            false,
            true,
            new List<ReactionDto>(),
            null,
            null);

        await Clients.Group($"channel:{channel.Id}").SendAsync("ReceiveMessage", messageDto);

        if (channel.Type == ChannelType.DM)
        {
            var recipientId = channel.DmUser1Id == authorId ? channel.DmUser2Id : channel.DmUser1Id;
            if (!string.IsNullOrEmpty(recipientId))
            {
                await Clients.Group($"user:{recipientId}").SendAsync("NewUnreadMessage", channel.Id.ToString(), (string?)null);
            }
        }
        else if (channel.ServerId.HasValue)
        {
            var recipients = await GetUserIdsWithChannelPermission(channel.Id, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("NewUnreadMessage", channel.Id.ToString(), channel.ServerId.ToString());
            }
        }
    }

    public override async Task OnConnectedAsync()
    {
        _connections[Context.ConnectionId] = UserId;
        _lastHeartbeats[UserId] = DateTime.UtcNow;

        // Join per-user group for targeted notifications
        await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{UserId}");

        // Get user to check presence status
        var user = await _db.Users.FindAsync(UserId);
        if (user == null)
        {
            await base.OnConnectedAsync();
            return;
        }

        // Track guest activity
        if (user.IsGuest)
        {
            user.LastActiveAt = DateTime.UtcNow;
            _guestActivityWrites[UserId] = DateTime.UtcNow;
        }

        // Auto-restore from server-set away: if the server marked this user
        // as Away due to stale heartbeats, restore to Online on reconnect.
        // Check both in-memory dict and DB column (DB survives server restarts).
        var wasAutoAway = _serverAutoAway.TryRemove(UserId, out _) || user.IsAutoAway;
        if (wasAutoAway && user.PresenceStatus == 1)
        {
            user.PresenceStatus = 0;
            user.IsAutoAway = false;
            await _db.SaveChangesAsync();
        }

        // Notify all servers the user is in
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == UserId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        foreach (var serverId in serverIds)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"server:{serverId}");

            // Only broadcast UserOnline if NOT Invisible
            if (user.PresenceStatus != 3)
            {
                await Clients.Group($"server:{serverId}").SendAsync("UserOnline", UserId, DisplayName, user.PresenceStatus);
            }
        }

        // Join all DM channel groups
        var dmChannelIds = await _db.Channels
            .Where(c => c.Type == ChannelType.DM && (c.DmUser1Id == UserId || c.DmUser2Id == UserId))
            .Select(c => c.Id)
            .ToListAsync();

        foreach (var dmId in dmChannelIds)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"channel:{dmId}");
        }

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _connections.TryRemove(Context.ConnectionId, out _);

        // Check if user has no more connections
        bool stillOnline = _connections.Values.Contains(UserId);

        if (!stillOnline)
        {
            _activeChannels.TryRemove(UserId, out _);
            _lastHeartbeats.TryRemove(UserId, out _);
            _rateLimiter.RemoveUser(UserId);

            // Get user to check presence status
            var user = await _db.Users.FindAsync(UserId);

            // If the server auto-set this user to Away, reset to Online in the DB
            // so they don't appear as Away on their next login
            var wasAutoAway = _serverAutoAway.TryRemove(UserId, out _) || (user != null && user.IsAutoAway);
            if (wasAutoAway && user != null && user.PresenceStatus == 1)
            {
                user.PresenceStatus = 0;
                user.IsAutoAway = false;
                await _db.SaveChangesAsync();
            }

            var serverIds = await _db.ServerMembers
                .Where(sm => sm.UserId == UserId)
                .Select(sm => sm.ServerId)
                .ToListAsync();

            foreach (var serverId in serverIds)
            {
                // Only send UserOffline if they weren't Invisible
                // (if they were Invisible, we never sent UserOnline, so don't send UserOffline)
                if (user != null && user.PresenceStatus != 3)
                {
                    await Clients.Group($"server:{serverId}").SendAsync("UserOffline", UserId);
                }
            }

            // Enqueue offline replay for deferred push delivery
            NotificationDispatchService.EnqueueOfflineReplay(UserId);
        }

        // Leave voice if this was the voice connection (or user is fully offline).
        // Voice is tied to a specific connection (WebRTC peers), so clean up
        // even if the user has other connections open (e.g. another browser tab).
        var isVoiceConn = _voiceState.IsVoiceConnection(UserId, Context.ConnectionId);
        if (isVoiceConn || !stillOnline)
        {
            var initialVoiceChannel = _voiceState.GetUserChannel(UserId);
            if (initialVoiceChannel.HasValue)
            {
                var expectedVoiceConnectionId = _voiceState.GetVoiceConnectionId(UserId);
                var pendingDisconnect = ReplacePendingVoiceDisconnect(UserId, expectedVoiceConnectionId);

                try
                {
                    await Task.Delay(VoiceDisconnectGracePeriod, pendingDisconnect.Cancellation.Token);
                }
                catch (TaskCanceledException)
                {
                    await base.OnDisconnectedAsync(exception);
                    return;
                }
                finally
                {
                    if (_pendingVoiceDisconnects.TryGetValue(UserId, out var currentPending) &&
                        ReferenceEquals(currentPending, pendingDisconnect))
                    {
                        _pendingVoiceDisconnects.TryRemove(UserId, out _);
                    }

                    pendingDisconnect.Cancellation.Dispose();
                }

                // User rejoined voice before grace window ended.
                if (pendingDisconnect.ExpectedVoiceConnectionId is { } expectedConnId &&
                    !_voiceState.IsVoiceConnection(UserId, expectedConnId))
                {
                    await base.OnDisconnectedAsync(exception);
                    return;
                }

                var voiceChannel = _voiceState.GetUserChannel(UserId);
                if (!voiceChannel.HasValue || voiceChannel.Value != initialVoiceChannel.Value)
                {
                    await base.OnDisconnectedAsync(exception);
                    return;
                }

                // Atomically remove screen share / camera state (no TOCTOU)
                var wasSharing = _voiceState.RemoveScreenSharer(voiceChannel.Value, UserId);
                if (wasSharing)
                {
                    await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("ScreenShareStopped", UserId);
                }

                var hadCamera = _voiceState.RemoveCameraUser(voiceChannel.Value, UserId);
                if (hadCamera)
                {
                    await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("CameraStopped", UserId);
                }

                _voiceState.LeaveChannel(voiceChannel.Value, UserId);
                await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("UserLeftVoice", UserId);
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"channel:{voiceChannel.Value}");

                // Handle watch party host promotion or cleanup
                await HandleWatchPartyLeave(voiceChannel.Value);

                await CleanupVoiceChatIfEmpty(voiceChannel.Value);

                // Notify server group so sidebar updates
                var channel = await _db.Channels.FindAsync(voiceChannel.Value);
                if (channel?.ServerId != null)
                {
                    if (wasSharing)
                    {
                        var recipients = await GetUserIdsWithChannelPermission(voiceChannel.Value, Permission.ViewChannel);
                        foreach (var userId in recipients)
                        {
                            await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", voiceChannel.Value.ToString(), UserId);
                        }
                    }
                    if (hadCamera)
                    {
                        var camRecipients = await GetUserIdsWithChannelPermission(voiceChannel.Value, Permission.ViewChannel);
                        foreach (var userId in camRecipients)
                        {
                            await Clients.Group($"user:{userId}").SendAsync("CameraStoppedInChannel", voiceChannel.Value.ToString(), UserId);
                        }
                    }
                    var leaveSoundUrl = await GetSoundUrl(UserId, "leave");
                    var leftRecipients = await GetUserIdsWithChannelPermission(voiceChannel.Value, Permission.ViewChannel);
                    foreach (var userId in leftRecipients)
                    {
                        await Clients.Group($"user:{userId}").SendAsync("VoiceUserLeftChannel", voiceChannel.Value.ToString(), UserId, leaveSoundUrl);
                    }
                }
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    // Join a server's SignalR group (called after joining/creating a server)
    public async Task JoinServerGroup(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return;
        if (!await _perms.IsMemberAsync(serverGuid, UserId)) return;
        await Groups.AddToGroupAsync(Context.ConnectionId, $"server:{serverId}");
        await Clients.Group($"server:{serverId}").SendAsync("UserOnline", UserId, DisplayName);
    }

    // Text messaging
    public async Task JoinChannel(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await CanAccessChannel(channel)) return;

        _activeChannels[UserId] = channelGuid;
        await Groups.AddToGroupAsync(Context.ConnectionId, $"channel:{channelId}");
    }

    public async Task LeaveChannel(string channelId)
    {
        if (Guid.TryParse(channelId, out var channelGuid))
        {
            // Only remove if still tracking this channel (avoid race with JoinChannel on another channel)
            _activeChannels.TryRemove(new KeyValuePair<string, Guid>(UserId, channelGuid));
        }
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"channel:{channelId}");
    }

    // Lightweight connection health check — does NOT refresh presence heartbeat
    // so that PresenceMonitorService can detect idle users on all platforms.
    public string Ping()
    {
        return "pong";
    }

    // Explicit presence heartbeat — clients call this when the user is actively
    // interacting (mouse, keyboard, touch). Keeps the user's heartbeat fresh so
    // PresenceMonitorService doesn't mark them as Away.
    public async void ActivityHeartbeat()
    {
        _lastHeartbeats[UserId] = DateTime.UtcNow;

        // Throttled guest activity update (max once per hour)
        if (_guestActivityWrites.TryGetValue(UserId, out var lastWrite) &&
            (DateTime.UtcNow - lastWrite).TotalHours < 1)
            return;

        try
        {
            var user = await _db.Users.FindAsync(UserId);
            if (user is { IsGuest: true })
            {
                user.LastActiveAt = DateTime.UtcNow;
                _guestActivityWrites[UserId] = DateTime.UtcNow;
                await _db.SaveChangesAsync();
            }
        }
        catch
        {
            // Non-critical — ignore failures
        }
    }

    public async Task SendMessage(string channelId, string content, List<string> attachmentIds, string? replyToMessageId = null)
    {
        if (attachmentIds == null)
        {
            await Clients.Caller.SendAsync("Error", "Attachments list is required.");
            return;
        }

        var maxMessageLength = await GetMaxMessageLengthAsync();
        if (!TryNormalizeAndValidateMessageForSend(content, attachmentIds.Count, maxMessageLength, out var normalizedContent, out var error))
        {
            await Clients.Caller.SendAsync("Error", error);
            return;
        }

        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await CanAccessChannel(channel)) return;
        if (channel.Type != ChannelType.DM)
        {
            if (!await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.SendMessages))
            {
                await Clients.Caller.SendAsync("Error", "You do not have permission to send messages in this channel.");
                return;
            }

            if (attachmentIds.Count > 0 &&
                !await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.AttachFiles))
            {
                await Clients.Caller.SendAsync("Error", "You do not have permission to attach files in this channel.");
                return;
            }

            var mentionParse = _notifications.ParseMentions(normalizedContent);
            if ((mentionParse.HasEveryone || mentionParse.HasHere) &&
                !await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.MentionEveryone))
            {
                await Clients.Caller.SendAsync("Error", "You do not have permission to mention @everyone or @here.");
                return;
            }
        }

        // Validate reply target
        Guid? replyToGuid = null;
        if (!string.IsNullOrEmpty(replyToMessageId) && Guid.TryParse(replyToMessageId, out var parsedReplyId))
        {
            var replyTarget = await _db.Messages.FirstOrDefaultAsync(m => m.Id == parsedReplyId && m.ChannelId == channelGuid);
            if (replyTarget != null) replyToGuid = parsedReplyId;
        }

        var message = new Message
        {
            Id = Guid.NewGuid(),
            Content = normalizedContent,
            AuthorId = UserId,
            ChannelId = channelGuid,
            CreatedAt = DateTime.UtcNow,
            ReplyToMessageId = replyToGuid,
        };
        _db.Messages.Add(message);

        // Update LastMessageAt for DM channels
        if (channel.Type == ChannelType.DM)
        {
            channel.LastMessageAt = message.CreatedAt;
        }

        // Link attachments to message
        var attachments = new List<AttachmentDto>();
        foreach (var idStr in attachmentIds)
        {
            if (Guid.TryParse(idStr, out var attId))
            {
                var att = await _db.Attachments.FindAsync(attId);
                if (att != null)
                {
                    att.MessageId = message.Id;
                    attachments.Add(new AttachmentDto(att.Id, message.Id, att.FileName, att.FilePath, att.PosterPath, att.ContentType, att.Size));
                }
            }
        }

        await _db.SaveChangesAsync();

        var author = await _db.Users.FindAsync(UserId);
        var authorCosmetics = await _cosmetics.GetEquippedAsync(UserId);
        var authorDto = new UserDto(author!.Id, author.UserName!, author.DisplayName, author.AvatarUrl, author.Status, author.Bio, author.PresenceStatus, authorCosmetics);

        // Build reply reference DTO
        ReplyReferenceDto? replyDto = null;
        if (replyToGuid.HasValue)
        {
            var replyMsg = await _db.Messages.Include(m => m.Author).FirstOrDefaultAsync(m => m.Id == replyToGuid.Value);
            if (replyMsg != null)
            {
                var replyCosmetics = replyMsg.AuthorId == UserId ? authorCosmetics : await _cosmetics.GetEquippedAsync(replyMsg.AuthorId);
                var replyAuthorDto = new UserDto(replyMsg.Author.Id, replyMsg.Author.UserName!, replyMsg.Author.DisplayName, replyMsg.Author.AvatarUrl, replyMsg.Author.Status, replyMsg.Author.Bio, replyMsg.Author.PresenceStatus, replyCosmetics);
                replyDto = new ReplyReferenceDto(replyMsg.Id, replyMsg.IsDeleted ? "" : replyMsg.Content, replyMsg.AuthorId, replyAuthorDto, replyMsg.IsDeleted);
            }
        }

        var messageDto = new MessageDto(message.Id, message.Content, message.AuthorId, authorDto, message.ChannelId, message.CreatedAt, attachments, null, false, false, new List<ReactionDto>(), replyToGuid, replyDto);

        await Clients.Group($"channel:{channelId}").SendAsync("ReceiveMessage", messageDto);

        if (channel.Type == ChannelType.DM)
        {
            // DM: send unread notification to the other user
            var recipientId = channel.DmUser1Id == UserId ? channel.DmUser2Id! : channel.DmUser1Id!;
            await Clients.Group($"user:{recipientId}").SendAsync("NewUnreadMessage", channelId, (string?)null);

            // Create DM notification for the recipient
            // Away users should get push notifications just like offline users
            var isRecipientOffline = !_connections.Values.Contains(recipientId);
            var recipientUser = await _db.Users.FindAsync(recipientId);
            var needsPush = isRecipientOffline || recipientUser?.PresenceStatus == 1;
            var dmNotification = new Notification
            {
                Id = Guid.NewGuid(),
                UserId = recipientId,
                MessageId = message.Id,
                ChannelId = channelGuid,
                ServerId = null,
                Type = NotificationType.UserMention,
                PushStatus = needsPush ? PushStatus.Pending : PushStatus.None,
                CreatedAt = DateTime.UtcNow,
            };
            _db.Notifications.Add(dmNotification);
            await _db.SaveChangesAsync();

            // Enqueue push notification for async delivery
            if (dmNotification.PushStatus == PushStatus.Pending)
                NotificationDispatchService.Enqueue(dmNotification.Id);

            var dmNotifDto = new NotificationDto(dmNotification.Id, dmNotification.MessageId, dmNotification.ChannelId, null, dmNotification.Type.ToString(), dmNotification.CreatedAt);
            await Clients.Group($"user:{recipientId}").SendAsync("MentionReceived", dmNotifDto);
        }
        else if (channel.ServerId.HasValue)
        {
            // Server channel: broadcast unread indicator to users who can view the channel
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("NewUnreadMessage", channelId, channel.ServerId.ToString());
            }

            // Process mentions and send targeted notifications
            // Exclude Away users from "online" set so they get push notifications
            // (also correctly excludes them from @here mentions)
            var connectedIds = _connections.Values.ToHashSet();
            var awayIds = await _db.Users
                .Where(u => connectedIds.Contains(u.Id) && u.PresenceStatus == 1)
                .Select(u => u.Id)
                .ToHashSetAsync();
            var onlineUserIds = new HashSet<string>(connectedIds.Except(awayIds));
            var activeChannelUserIds = GetActiveChannelUserIds(channelGuid);

            var notifications = await _notifications.CreateMentionNotifications(message, channel.ServerId.Value, channelGuid, onlineUserIds, activeChannelUserIds);
            var notifiedUserIds = new HashSet<string>(notifications.Select(n => n.UserId));
            foreach (var notification in notifications)
            {
                var dto = new NotificationDto(notification.Id, notification.MessageId, notification.ChannelId, notification.ServerId, notification.Type.ToString(), notification.CreatedAt);
                await Clients.Group($"user:{notification.UserId}").SendAsync("MentionReceived", dto);
            }

            // Reply notification: if replying to someone else who wasn't already notified
            if (replyToGuid.HasValue && replyDto != null && replyDto.AuthorId != UserId && !notifiedUserIds.Contains(replyDto.AuthorId))
            {
                var isReplyTargetViewingChannel = activeChannelUserIds.Contains(replyDto.AuthorId);
                if (!isReplyTargetViewingChannel
                    && await _perms.HasChannelPermissionAsync(channelGuid, replyDto.AuthorId, Permission.ViewChannel)
                    && await _notifications.ShouldNotify(replyDto.AuthorId, channel.ServerId.Value, channelGuid, NotificationType.ReplyMention))
                {
                    var isReplyTargetOffline = !onlineUserIds.Contains(replyDto.AuthorId);
                    var replyNotification = new Notification
                    {
                        Id = Guid.NewGuid(),
                        UserId = replyDto.AuthorId,
                        MessageId = message.Id,
                        ChannelId = channelGuid,
                        ServerId = channel.ServerId,
                        Type = NotificationType.ReplyMention,
                        PushStatus = isReplyTargetOffline ? PushStatus.Pending : PushStatus.None,
                        CreatedAt = DateTime.UtcNow,
                    };
                    _db.Notifications.Add(replyNotification);
                    await _db.SaveChangesAsync();

                    if (replyNotification.PushStatus == PushStatus.Pending)
                        NotificationDispatchService.Enqueue(replyNotification.Id);

                    notifiedUserIds.Add(replyDto.AuthorId);
                    var replyNotifDto = new NotificationDto(replyNotification.Id, replyNotification.MessageId, replyNotification.ChannelId, replyNotification.ServerId, replyNotification.Type.ToString(), replyNotification.CreatedAt);
                    await Clients.Group($"user:{replyDto.AuthorId}").SendAsync("MentionReceived", replyNotifDto);
                }
            }

            // AllMessages notifications for users with that notification level
            var allMsgNotifications = await _notifications.CreateAllMessageNotifications(
                message, channel.ServerId.Value, channelGuid,
                onlineUserIds, activeChannelUserIds, notifiedUserIds);

            foreach (var notification in allMsgNotifications)
            {
                var dto = new NotificationDto(notification.Id, notification.MessageId, notification.ChannelId, notification.ServerId, notification.Type.ToString(), notification.CreatedAt);
                await Clients.Group($"user:{notification.UserId}").SendAsync("MentionReceived", dto);
            }
        }
    }

    public async Task EditMessage(string messageId, string newContent)
    {
        var maxMessageLength = await GetMaxMessageLengthAsync();
        if (!TryValidateMessageForEdit(newContent, maxMessageLength, out var error))
        {
            await Clients.Caller.SendAsync("Error", error);
            return;
        }

        if (!Guid.TryParse(messageId, out var msgGuid)) return;
        var message = await _db.Messages.FindAsync(msgGuid);
        if (message == null || message.AuthorId != UserId || message.IsDeleted || message.IsSystem) return;

        message.Content = newContent;
        message.EditedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageEdited", message.Id.ToString(), newContent, message.EditedAt);
    }

    public async Task DeleteMessage(string messageId)
    {
        if (!Guid.TryParse(messageId, out var msgGuid)) return;
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null || message.IsSystem) return;

        var pinned = await _db.PinnedMessages.FirstOrDefaultAsync(pm =>
            pm.ChannelId == message.ChannelId && pm.MessageId == message.Id);

        var isAuthor = message.AuthorId == UserId;

        if (message.Channel.Type == ChannelType.DM)
        {
            // In DMs, only the author can delete their own messages
            if (!isAuthor) return;
        }
        else
        {
            var canManageMessages = message.Channel.ServerId.HasValue && await _perms.HasPermissionAsync(message.Channel.ServerId.Value, UserId, Permission.ManageMessages);
            if (!isAuthor && !canManageMessages) return;

            // Log when admin deletes another user's message
            if (!isAuthor && canManageMessages && message.Channel.ServerId.HasValue)
            {
                var author = await _db.Users.FindAsync(message.AuthorId);
                await _perms.LogAsync(message.Channel.ServerId.Value, AuditAction.MessageDeleted, UserId,
                    targetId: message.AuthorId, targetName: author?.DisplayName);
            }
        }

        message.IsDeleted = true;
        if (pinned != null)
        {
            _db.PinnedMessages.Remove(pinned);
        }
        await _db.SaveChangesAsync();

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageDeleted", message.Id.ToString());

        if (pinned != null)
        {
            await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageUnpinned", message.ChannelId.ToString(), message.Id.ToString());
        }
    }

    // Reactions
    public async Task ToggleReaction(string messageId, string emoji)
    {
        if (!Guid.TryParse(messageId, out var msgGuid)) return;
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null || message.IsDeleted) return;
        if (!await CanAccessChannel(message.Channel)) return;
        if (message.Channel.Type != ChannelType.DM &&
            !await _perms.HasChannelPermissionAsync(message.Channel.Id, UserId, Permission.AddReactions))
        {
            return;
        }

        // Validate custom emoji exists in this server (only for server channels)
        if (emoji.StartsWith("custom:") && message.Channel.ServerId.HasValue)
        {
            var emojiIdStr = emoji.Substring(7);
            if (!Guid.TryParse(emojiIdStr, out var emojiGuid)) return;
            var exists = await _db.CustomEmojis.AnyAsync(e => e.Id == emojiGuid && e.ServerId == message.Channel.ServerId.Value);
            if (!exists) return;
        }

        var existing = await _db.Reactions
            .FirstOrDefaultAsync(r => r.MessageId == msgGuid && r.UserId == UserId && r.Emoji == emoji);

        if (existing != null)
        {
            _db.Reactions.Remove(existing);
            await _db.SaveChangesAsync();
            await Clients.Group($"channel:{message.ChannelId}").SendAsync("ReactionRemoved", messageId, UserId, emoji);
        }
        else
        {
            var reaction = new Reaction
            {
                Id = Guid.NewGuid(),
                MessageId = msgGuid,
                UserId = UserId,
                Emoji = emoji,
                CreatedAt = DateTime.UtcNow,
            };
            _db.Reactions.Add(reaction);
            await _db.SaveChangesAsync();
            var dto = new ReactionDto(reaction.Id, reaction.MessageId, reaction.UserId, reaction.Emoji);
            await Clients.Group($"channel:{message.ChannelId}").SendAsync("ReactionAdded", dto);
        }
    }

    // Pins
    public async Task PinMessage(string messageId)
    {
        if (!Guid.TryParse(messageId, out var msgGuid)) return;

        var message = await _db.Messages
            .Include(m => m.Channel)
            .Include(m => m.Author)
            .Include(m => m.Attachments)
            .Include(m => m.Reactions)
            .Include(m => m.ReplyToMessage).ThenInclude(r => r!.Author)
            .FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null || message.IsDeleted || message.IsSystem) return;
        if (!await CanAccessChannel(message.Channel)) return;

        if (message.Channel.Type != ChannelType.DM)
        {
            if (!message.Channel.ServerId.HasValue) return;
            if (!await _perms.HasPermissionAsync(message.Channel.ServerId.Value, UserId, Permission.ManageMessages)) return;
        }

        var existing = await _db.PinnedMessages.FirstOrDefaultAsync(pm =>
            pm.ChannelId == message.ChannelId && pm.MessageId == message.Id);
        if (existing != null) return;

        var pinCount = await _db.PinnedMessages.CountAsync(pm => pm.ChannelId == message.ChannelId);
        if (pinCount >= MaxPinnedMessagesPerChannel)
        {
            await Clients.Caller.SendAsync("Error", $"Maximum {MaxPinnedMessagesPerChannel} pinned messages per channel.");
            return;
        }

        var pin = new PinnedMessage
        {
            ChannelId = message.ChannelId,
            MessageId = message.Id,
            PinnedById = UserId,
            PinnedAt = DateTime.UtcNow,
        };
        _db.PinnedMessages.Add(pin);
        await _db.SaveChangesAsync();

        var pinnedBy = await _db.Users.FindAsync(UserId);
        if (pinnedBy == null) return;

        var messageDto = new MessageDto(
            message.Id,
            message.Content,
            message.AuthorId,
            new UserDto(message.Author.Id, message.Author.UserName!, message.Author.DisplayName, message.Author.AvatarUrl, message.Author.Status, message.Author.Bio, message.Author.PresenceStatus),
            message.ChannelId,
            message.CreatedAt,
            message.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size)).ToList(),
            message.EditedAt,
            message.IsDeleted,
            message.IsSystem,
            message.Reactions.Select(r => new ReactionDto(r.Id, r.MessageId, r.UserId, r.Emoji)).ToList(),
            message.ReplyToMessageId,
            message.ReplyToMessage == null ? null : new ReplyReferenceDto(
                message.ReplyToMessage.Id,
                message.ReplyToMessage.IsDeleted ? "" : message.ReplyToMessage.Content,
                message.ReplyToMessage.AuthorId,
                new UserDto(message.ReplyToMessage.Author.Id, message.ReplyToMessage.Author.UserName!, message.ReplyToMessage.Author.DisplayName, message.ReplyToMessage.Author.AvatarUrl, message.ReplyToMessage.Author.Status, message.ReplyToMessage.Author.Bio, message.ReplyToMessage.Author.PresenceStatus),
                message.ReplyToMessage.IsDeleted
            )
        );

        var pinDto = new PinnedMessageDto(
            messageDto,
            pin.PinnedAt,
            new UserDto(pinnedBy.Id, pinnedBy.UserName!, pinnedBy.DisplayName, pinnedBy.AvatarUrl, pinnedBy.Status, pinnedBy.Bio, pinnedBy.PresenceStatus)
        );

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessagePinned", pinDto);

        if (message.Channel.ServerId.HasValue)
        {
            await _perms.LogAsync(message.Channel.ServerId.Value, AuditAction.MessagePinned, UserId,
                targetId: message.AuthorId, targetName: message.Author.DisplayName);
        }

        await SendSystemMessageAsync(message.Channel, UserId, "pinned a message to this channel.");
    }

    public async Task UnpinMessage(string messageId)
    {
        if (!Guid.TryParse(messageId, out var msgGuid)) return;

        var pinned = await _db.PinnedMessages
            .Include(pm => pm.Message).ThenInclude(m => m.Channel)
            .Include(pm => pm.Message).ThenInclude(m => m.Author)
            .FirstOrDefaultAsync(pm => pm.MessageId == msgGuid);
        if (pinned == null) return;

        var channel = pinned.Message.Channel;
        if (!await CanAccessChannel(channel)) return;

        if (channel.Type != ChannelType.DM)
        {
            if (!channel.ServerId.HasValue) return;
            if (!await _perms.HasPermissionAsync(channel.ServerId.Value, UserId, Permission.ManageMessages)) return;
        }

        _db.PinnedMessages.Remove(pinned);
        await _db.SaveChangesAsync();

        await Clients.Group($"channel:{channel.Id}").SendAsync("MessageUnpinned", channel.Id.ToString(), messageId);

        if (channel.ServerId.HasValue)
        {
            await _perms.LogAsync(channel.ServerId.Value, AuditAction.MessageUnpinned, UserId,
                targetId: pinned.Message.AuthorId, targetName: pinned.Message.Author.DisplayName);
        }

        await SendSystemMessageAsync(channel, UserId, "unpinned a message from this channel.");
    }

    // Typing indicator
    public async Task UserTyping(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await CanAccessChannel(channel)) return;

        await Clients.OthersInGroup($"channel:{channelId}").SendAsync("UserIsTyping", UserId, DisplayName);
    }

    // Get online users for a server
    public async Task<Dictionary<string, int>> GetOnlineUsers(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new Dictionary<string, int>();
        var onlineUserIds = new HashSet<string>(_connections.Values);

        var onlineMembers = await _db.ServerMembers
            .Where(sm => sm.ServerId == serverGuid && onlineUserIds.Contains(sm.UserId))
            .Join(_db.Users, sm => sm.UserId, u => u.Id, (sm, u) => new { u.Id, u.PresenceStatus })
            .Where(u => u.PresenceStatus != 3) // Exclude Invisible users
            .ToDictionaryAsync(u => u.Id, u => u.PresenceStatus);

        return onlineMembers;
    }

    // Get voice users for all channels in a server (for sidebar display)
    public async Task<Dictionary<Guid, Dictionary<string, VoiceUserStateDto>>> GetServerVoiceUsers(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new Dictionary<Guid, Dictionary<string, VoiceUserStateDto>>();
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        var allowedChannelIds = new List<Guid>();
        foreach (var channelId in channelIds)
        {
            if (await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel))
                allowedChannelIds.Add(channelId);
        }
        return _voiceState.GetUsersForChannels(allowedChannelIds);
    }

    // Voice channels
    public async Task JoinVoiceChannel(string channelId, bool isMuted = false, bool isDeafened = false)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;

        // Membership check
        var voiceChannel = await _db.Channels.FindAsync(channelGuid);
        if (voiceChannel == null || !voiceChannel.ServerId.HasValue) return;
        if (!await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.Connect)) return;

        // Enforce user limit (skip if user is already in this channel — reconnect)
        if (voiceChannel.UserLimit is > 0)
        {
            var currentInChannel = _voiceState.GetUserChannel(UserId);
            if (!currentInChannel.HasValue || currentInChannel.Value != channelGuid)
            {
                var currentCount = _voiceState.GetChannelUserIds(channelGuid).Count;
                if (currentCount >= voiceChannel.UserLimit.Value)
                {
                    throw new HubException("Channel is full.");
                }
            }
        }

        var canSpeak = await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.Speak);
        CancelPendingVoiceDisconnect(UserId);

        var effectiveMuted = isMuted || !canSpeak;
        var currentChannel = _voiceState.GetUserChannel(UserId);
        var currentVoiceConnectionId = _voiceState.GetVoiceConnectionId(UserId);
        var reconnectingToSameChannel =
            currentChannel.HasValue &&
            currentChannel.Value == channelGuid &&
            !string.Equals(currentVoiceConnectionId, Context.ConnectionId, StringComparison.Ordinal) &&
            (string.IsNullOrEmpty(currentVoiceConnectionId) || !_connections.ContainsKey(currentVoiceConnectionId));

        if (reconnectingToSameChannel)
        {
            // Lightweight reconnect: just update the connection ID.
            // Don't remove screen share / camera state — WebRTC tracks are
            // independent of SignalR and may still be flowing (especially in
            // Electron or during background re-registration while gaming).
            // The client reconciles these on visibility change if needed.
            _voiceState.JoinChannel(channelGuid, UserId, DisplayName, effectiveMuted, isDeafened, Context.ConnectionId);
            if (!canSpeak)
            {
                _voiceState.UpdateUserState(channelGuid, UserId, effectiveMuted, isDeafened, true, null);
            }

            await Groups.AddToGroupAsync(Context.ConnectionId, $"voice:{channelId}");
            await Groups.AddToGroupAsync(Context.ConnectionId, $"channel:{channelId}");

            await SendCurrentVoiceChannelStateToCaller(channelGuid, channelId);

            // Trigger fresh WebRTC negotiation for this recovered session without a synthetic leave event.
            await Clients.OthersInGroup($"voice:{channelId}").SendAsync("UserJoinedVoice", UserId, DisplayName);

            var state = new VoiceUserStateDto(DisplayName, effectiveMuted, isDeafened, !canSpeak, false);
            var reconnectRecipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in reconnectRecipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("VoiceUserStateUpdated", channelId, UserId, state);
            }

            return;
        }

        // Enforce single voice session: if user is already in voice, notify other sessions to disconnect
        if (currentChannel.HasValue)
        {
            // Remove displaced connection from voice group so it stops receiving voice traffic
            if (!string.IsNullOrEmpty(currentVoiceConnectionId) && currentVoiceConnectionId != Context.ConnectionId)
            {
                await Groups.RemoveFromGroupAsync(currentVoiceConnectionId, $"voice:{currentChannel.Value}");
                await Groups.RemoveFromGroupAsync(currentVoiceConnectionId, $"channel:{currentChannel.Value}");
            }
            // Notify all other sessions for this user to leave voice
            await Clients.OthersInGroup($"user:{UserId}").SendAsync("VoiceSessionReplaced", "You have joined voice from another device.");
        }

        // Leave any existing voice channel from THIS connection
        if (currentChannel.HasValue)
        {
            // Atomically remove screen share / camera state (no TOCTOU)
            var wasSharing = _voiceState.RemoveScreenSharer(currentChannel.Value, UserId);
            if (wasSharing)
            {
                await Clients.Group($"voice:{currentChannel.Value}").SendAsync("ScreenShareStopped", UserId);
            }

            var hadCamera = _voiceState.RemoveCameraUser(currentChannel.Value, UserId);
            if (hadCamera)
            {
                await Clients.Group($"voice:{currentChannel.Value}").SendAsync("CameraStopped", UserId);
            }

            _voiceState.LeaveChannel(currentChannel.Value, UserId);
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"voice:{currentChannel.Value}");
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"channel:{currentChannel.Value}");
            await Clients.Group($"voice:{currentChannel.Value}").SendAsync("UserLeftVoice", UserId);

            await CleanupVoiceChatIfEmpty(currentChannel.Value);

            // Notify the server group so sidebar updates for non-participants
            var prevChannel = await _db.Channels.FindAsync(currentChannel.Value);
            if (prevChannel?.ServerId != null)
            {
                if (wasSharing)
                {
                    var recipients = await GetUserIdsWithChannelPermission(currentChannel.Value, Permission.ViewChannel);
                    foreach (var userId in recipients)
                    {
                        await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", currentChannel.Value.ToString(), UserId);
                    }
                }
                if (hadCamera)
                {
                    var camRecipients = await GetUserIdsWithChannelPermission(currentChannel.Value, Permission.ViewChannel);
                    foreach (var userId in camRecipients)
                    {
                        await Clients.Group($"user:{userId}").SendAsync("CameraStoppedInChannel", currentChannel.Value.ToString(), UserId);
                    }
                }
                var moveLeaveSoundUrl = await GetSoundUrl(UserId, "leave");
                var leftRecipients = await GetUserIdsWithChannelPermission(currentChannel.Value, Permission.ViewChannel);
                foreach (var userId in leftRecipients)
                {
                    await Clients.Group($"user:{userId}").SendAsync("VoiceUserLeftChannel", currentChannel.Value.ToString(), UserId, moveLeaveSoundUrl);
                }
            }
        }

        _voiceState.JoinChannel(channelGuid, UserId, DisplayName, effectiveMuted, isDeafened, Context.ConnectionId);
        if (!canSpeak)
        {
            _voiceState.UpdateUserState(channelGuid, UserId, effectiveMuted, isDeafened, true, null);
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, $"voice:{channelId}");
        await Groups.AddToGroupAsync(Context.ConnectionId, $"channel:{channelId}");
        await SendCurrentVoiceChannelStateToCaller(channelGuid, channelId);

        // Notify voice group for WebRTC setup
        await Clients.OthersInGroup($"voice:{channelId}").SendAsync("UserJoinedVoice", UserId, DisplayName);

        // Notify the server group so sidebar updates for non-participants
        if (voiceChannel.ServerId != null)
        {
            var state = new VoiceUserStateDto(DisplayName, effectiveMuted, isDeafened, !canSpeak, false);
            var joinSoundUrl = await GetSoundUrl(UserId, "join");
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("VoiceUserJoinedChannel", channelId, UserId, state, joinSoundUrl);
            }
        }
    }

    public async Task UpdateVoiceState(bool isMuted, bool isDeafened)
    {
        var channelId = _voiceState.GetUserChannel(UserId);
        if (!channelId.HasValue) return;

        var canSpeak = await _perms.HasChannelPermissionAsync(channelId.Value, UserId, Permission.Speak);
        var effectiveMuted = isMuted || !canSpeak;
        var updated = _voiceState.UpdateUserState(channelId.Value, UserId, effectiveMuted, isDeafened, canSpeak ? null : true, null);
        if (updated == null) return;

        var channel = await _db.Channels.FindAsync(channelId.Value);
        if (channel?.ServerId != null)
        {
            var recipients = await GetUserIdsWithChannelPermission(channelId.Value, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("VoiceUserStateUpdated", channelId.Value.ToString(), UserId, updated);
            }
        }
    }

    public async Task ModerateVoiceState(string targetUserId, bool isMuted, bool isDeafened)
    {
        var channelId = _voiceState.GetUserChannel(targetUserId);
        if (!channelId.HasValue) return;

        var channel = await _db.Channels.FindAsync(channelId.Value);
        if (channel?.ServerId == null) return;

        if (!await _perms.CanMuteAsync(channel.ServerId.Value, UserId, targetUserId)) return;

        var updated = _voiceState.UpdateUserState(channelId.Value, targetUserId, isMuted, isDeafened, isMuted, isDeafened);
        if (updated == null) return;

        var recipients = await GetUserIdsWithChannelPermission(channelId.Value, Permission.ViewChannel);
        foreach (var userId in recipients)
        {
            await Clients.Group($"user:{userId}").SendAsync("VoiceUserStateUpdated", channelId.Value.ToString(), targetUserId, updated);
        }
    }

    public async Task LeaveVoiceChannel(string channelId)
    {
        CancelPendingVoiceDisconnect(UserId);
        var currentChannel = _voiceState.GetUserChannel(UserId);
        if (!currentChannel.HasValue) return;
        var channelGuid = currentChannel.Value;
        var resolvedChannelId = channelGuid.ToString();

        // Atomically remove screen share / camera state (no TOCTOU)
        var wasSharing = _voiceState.RemoveScreenSharer(channelGuid, UserId);
        if (wasSharing)
        {
            await Clients.Group($"voice:{resolvedChannelId}").SendAsync("ScreenShareStopped", UserId);
        }

        var hadCamera = _voiceState.RemoveCameraUser(channelGuid, UserId);
        if (hadCamera)
        {
            await Clients.Group($"voice:{resolvedChannelId}").SendAsync("CameraStopped", UserId);
        }

        _voiceState.LeaveChannel(channelGuid, UserId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"voice:{resolvedChannelId}");
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"channel:{resolvedChannelId}");
        await Clients.Group($"voice:{resolvedChannelId}").SendAsync("UserLeftVoice", UserId);

        // Handle watch party host promotion or cleanup
        await HandleWatchPartyLeave(channelGuid);

        await CleanupVoiceChatIfEmpty(channelGuid);

        // Notify the server group so sidebar updates for non-participants
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel?.ServerId != null)
        {
            if (wasSharing)
            {
                var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
                foreach (var userId in recipients)
                {
                    await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", resolvedChannelId, UserId);
                }
            }
            if (hadCamera)
            {
                var camRecipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
                foreach (var userId in camRecipients)
                {
                    await Clients.Group($"user:{userId}").SendAsync("CameraStoppedInChannel", resolvedChannelId, UserId);
                }
            }
            var explicitLeaveSoundUrl = await GetSoundUrl(UserId, "leave");
            var leftRecipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in leftRecipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("VoiceUserLeftChannel", resolvedChannelId, UserId, explicitLeaveSoundUrl);
            }
        }
    }

    // Screen sharing
    public async Task NotifyScreenShare(string channelId, bool isSharing)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        if (!_voiceState.IsUserInChannel(channelGuid, UserId)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null || !channel.ServerId.HasValue) return;
        if (!await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.Stream)) return;

        if (isSharing)
        {
            _voiceState.AddScreenSharer(channelGuid, UserId, DisplayName);
            await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareStarted", UserId, DisplayName);
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("ScreenShareStartedInChannel", channelId, UserId);
            }
        }
        else
        {
            _voiceState.RemoveScreenSharer(channelGuid, UserId);
            await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareStopped", UserId);
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", channelId, UserId);
            }
        }
    }

    // Viewer requests to watch a sharer's stream
    public async Task RequestWatchStream(string sharerUserId)
    {
        // Verify both users are in the same voice channel
        var viewerChannel = _voiceState.GetUserChannel(UserId);
        var sharerChannel = _voiceState.GetUserChannel(sharerUserId);
        if (!viewerChannel.HasValue || !sharerChannel.HasValue || viewerChannel.Value != sharerChannel.Value) return;

        // Verify the target is actually sharing
        if (!_voiceState.IsScreenSharing(sharerChannel.Value, sharerUserId)) return;

        // Relay watch request to the sharer's connections
        var sharerConnections = _connections.Where(c => c.Value == sharerUserId).Select(c => c.Key).ToList();

        foreach (var connId in sharerConnections)
        {
            await Clients.Client(connId).SendAsync("WatchStreamRequested", UserId);
        }
    }

    // Viewer stops watching a sharer's stream
    public async Task StopWatchingStream(string sharerUserId)
    {
        // Relay stop request to the sharer's connections
        var sharerConnections = _connections.Where(c => c.Value == sharerUserId).Select(c => c.Key).ToList();

        foreach (var connId in sharerConnections)
        {
            await Clients.Client(connId).SendAsync("StopWatchingRequested", UserId);
        }
    }

    public async Task SendSignal(string targetUserId, string signal)
    {
        if (string.IsNullOrWhiteSpace(signal) || signal.Length > 100_000) return;

        // Verify sender is in a voice channel (membership was checked at join time)
        var senderChannel = _voiceState.GetUserChannel(UserId);
        if (!senderChannel.HasValue) return;

        // Refresh voice activity timestamp
        _voiceState.TouchUser(UserId);

        // Verify target is in the same voice channel
        var targetChannel = _voiceState.GetUserChannel(targetUserId);
        if (!targetChannel.HasValue || targetChannel.Value != senderChannel.Value) return;

        // Route only to the target user's voice connection — not all their connections.
        // If signals are sent to non-voice connections (e.g. a browser tab), those
        // connections create broken peer connections that interfere with the real session.
        var voiceConnId = _voiceState.GetVoiceConnectionId(targetUserId);
        if (voiceConnId == null || !_connections.ContainsKey(voiceConnId)) return;

        await Clients.Client(voiceConnId).SendAsync("ReceiveSignal", UserId, signal);
    }

    public void VoiceHeartbeat()
    {
        _voiceState.TouchUser(UserId);
    }

    public Dictionary<string, string> GetVoiceChannelUsers(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return new Dictionary<string, string>();
        return _voiceState.GetChannelUsersDisplayNames(channelGuid);
    }

    // Get screen sharers for all voice channels in a server (for sidebar LIVE indicators)
    public async Task<Dictionary<Guid, HashSet<string>>> GetServerVoiceSharers(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new Dictionary<Guid, HashSet<string>>();
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        var allowedChannelIds = new List<Guid>();
        foreach (var channelId in channelIds)
        {
            if (await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel))
                allowedChannelIds.Add(channelId);
        }
        return _voiceState.GetSharersForChannels(allowedChannelIds);
    }

    // Camera sharing
    public async Task NotifyCamera(string channelId, bool isOn)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        if (!_voiceState.IsUserInChannel(channelGuid, UserId)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null || !channel.ServerId.HasValue) return;
        if (!await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.Stream)) return;

        if (isOn)
        {
            _voiceState.AddCameraUser(channelGuid, UserId, DisplayName);
            await Clients.Group($"voice:{channelId}").SendAsync("CameraStarted", UserId, DisplayName);
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("CameraStartedInChannel", channelId, UserId);
            }
        }
        else
        {
            _voiceState.RemoveCameraUser(channelGuid, UserId);
            await Clients.Group($"voice:{channelId}").SendAsync("CameraStopped", UserId);
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("CameraStoppedInChannel", channelId, UserId);
            }
        }
    }

    // Relay mode notification
    public async Task NotifyRelayMode(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        if (!_voiceState.IsUserInChannel(channelGuid, UserId)) return;

        _voiceState.AddRelayUser(channelGuid, UserId);
        await Clients.OthersInGroup($"voice:{channelId}").SendAsync("ChannelRelayActive");
    }

    // Get camera users for all voice channels in a server (for sidebar indicators)
    public async Task<Dictionary<Guid, HashSet<string>>> GetServerVoiceCameras(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new Dictionary<Guid, HashSet<string>>();
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        var allowedChannelIds = new List<Guid>();
        foreach (var channelId in channelIds)
        {
            if (await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel))
                allowedChannelIds.Add(channelId);
        }
        return _voiceState.GetCamerasForChannels(allowedChannelIds);
    }

    // Mark a channel as read for the current user
    public async Task MarkChannelRead(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        if (!await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.ViewChannel)) return;
        await _notifications.MarkChannelRead(UserId, channelGuid);
    }

    // Get unread state for all channels in a server
    public async Task<List<ChannelUnreadDto>> GetUnreadState(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new List<ChannelUnreadDto>();
        return await _notifications.GetUnreadChannels(UserId, serverGuid);
    }

    // Get unread state for all user's servers (called on app init)
    public async Task<List<ServerUnreadDto>> GetAllServerUnreads()
    {
        return await _notifications.GetAllServerUnreads(UserId);
    }

    // Get DM channels for the current user
    public async Task<List<DmChannelDto>> GetDmChannels(int offset = 0, int limit = 50)
    {
        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var channels = await _db.Channels
            .Include(c => c.DmUser1)
            .Include(c => c.DmUser2)
            .Where(c => c.Type == ChannelType.DM && (c.DmUser1Id == UserId || c.DmUser2Id == UserId))
            .OrderByDescending(c => c.LastMessageAt)
            .Skip(offset)
            .Take(limit)
            .ToListAsync();

        var channelIds = channels.Select(c => c.Id).ToList();
        var lastMessages = await _db.Messages
            .Where(m => channelIds.Contains(m.ChannelId) && !m.IsDeleted)
            .GroupBy(m => m.ChannelId)
            .Select(g => new { ChannelId = g.Key, Message = g.OrderByDescending(m => m.CreatedAt).First() })
            .ToListAsync();

        var authorIds = lastMessages.Select(x => x.Message.AuthorId).Distinct().ToList();
        var authors = await _db.Users
            .Where(u => authorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName);

        var lastMessageMap = lastMessages.ToDictionary(
            x => x.ChannelId,
            x => new { x.Message.Content, AuthorName = authors.GetValueOrDefault(x.Message.AuthorId, "Unknown") });

        return channels.Select(c =>
        {
            var other = c.DmUser1Id == UserId ? c.DmUser2! : c.DmUser1!;
            var otherDto = new UserDto(other.Id, other.UserName!, other.DisplayName, other.AvatarUrl, other.Status, other.Bio, other.PresenceStatus);
            lastMessageMap.TryGetValue(c.Id, out var lastMsg);
            return new DmChannelDto(c.Id, otherDto, c.LastMessageAt, c.LastMessageAt ?? DateTime.UtcNow, lastMsg?.Content, lastMsg?.AuthorName);
        }).ToList();
    }

    // Get DM unread state
    public async Task<List<DmUnreadDto>> GetDmUnreads()
    {
        return await _notifications.GetDmUnreads(UserId);
    }

    // Watch party: host or moderator sends playback commands (play/pause/seek) to all viewers
    public async Task NotifyPlaybackCommand(string channelId, string command, double timeMs)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var party = _watchPartyService.GetParty(channelGuid);
        if (party == null) return;

        // Must be host, have ModerateWatchTogether, or have ManageChannels
        if (party.HostUserId != UserId
            && !await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.ModerateWatchTogether))
        {
            var channel = await _db.Channels.FindAsync(channelGuid);
            if (channel?.ServerId == null || !await _perms.HasPermissionAsync(channel.ServerId.Value, UserId, Permission.ManageChannels))
                return;
        }

        var isPlaying = command != "pause";
        _watchPartyService.UpdatePlaybackState(channelGuid, timeMs, isPlaying);

        await Clients.OthersInGroup($"voice:{channelId}").SendAsync("PlaybackCommand", command, timeMs);
    }

    // Watch party: viewer requests current sync position from host
    public async Task RequestSync(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var party = _watchPartyService.GetParty(channelGuid);
        if (party == null) return;

        await Clients.Caller.SendAsync("SyncPosition", party.CurrentTimeMs, party.IsPlaying);
    }

    // Watch party: host periodically reports playback position
    public async Task ReportPlaybackPosition(string channelId, double timeMs, bool isPlaying)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var party = _watchPartyService.GetParty(channelGuid);
        if (party == null || party.HostUserId != UserId) return;

        _watchPartyService.UpdatePlaybackState(channelGuid, timeMs, isPlaying);

        await Clients.OthersInGroup($"voice:{channelId}").SendAsync("SyncPosition", timeMs, isPlaying);
    }

    // Watch party: host voluntarily transfers host role to another user
    public async Task TransferWatchPartyHost(string channelId, string newHostUserId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var party = _watchPartyService.GetParty(channelGuid);
        if (party == null || party.HostUserId != UserId) return;

        // Verify new host is in the voice channel
        if (!_voiceState.IsUserInChannel(channelGuid, newHostUserId)) return;

        _watchPartyService.TransferHost(channelGuid, newHostUserId);

        var dbEntity = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelGuid);
        if (dbEntity != null)
        {
            dbEntity.HostUserId = newHostUserId;
            await _db.SaveChangesAsync();
        }

        await Clients.Group($"voice:{channelId}").SendAsync("WatchPartyHostChanged", newHostUserId);
    }

    // Get active watch parties for a server (for sidebar WATCH badges)
    public async Task<Dictionary<Guid, string>> GetServerWatchParties(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new Dictionary<Guid, string>();
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        var allowedChannelIds = new List<Guid>();
        foreach (var channelId in channelIds)
        {
            if (await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel))
                allowedChannelIds.Add(channelId);
        }
        return _watchPartyService.GetServerWatchParties(allowedChannelIds);
    }

    // Watch party host promotion or cleanup when a user leaves voice
    private async Task HandleWatchPartyLeave(Guid channelId)
    {
        var party = _watchPartyService.GetParty(channelId);
        if (party == null) return;

        // Only act if the leaving user is the host
        if (party.HostUserId != UserId) return;

        var remainingUsers = _voiceState.GetChannelUserIds(channelId);
        if (remainingUsers.Count == 0)
        {
            // No users left — stop the watch party
            _watchPartyService.StopParty(channelId);
            var dbEntity = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelId);
            if (dbEntity != null)
            {
                _db.WatchParties.Remove(dbEntity);
                await _db.SaveChangesAsync();
            }

            await Clients.Group($"voice:{channelId}").SendAsync("WatchPartyStopped", channelId.ToString());
            var channel = await _db.Channels.FindAsync(channelId);
            if (channel?.ServerId != null)
            {
                await Clients.Group($"server:{channel.ServerId}").SendAsync("WatchPartyStoppedInChannel", channelId.ToString());
            }
        }
        else
        {
            // Auto-promote next user as host
            var newHostId = remainingUsers[0];
            _watchPartyService.TransferHost(channelId, newHostId);

            var dbEntity = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelId);
            if (dbEntity != null)
            {
                dbEntity.HostUserId = newHostId;
                await _db.SaveChangesAsync();
            }

            await Clients.Group($"voice:{channelId}").SendAsync("WatchPartyHostChanged", newHostId);
        }
    }

    private async Task CleanupVoiceChatIfEmpty(Guid channelId)
    {
        if (!_voiceState.IsChannelEmpty(channelId)) return;

        // Clean up watch party if channel is empty
        if (_watchPartyService.IsActive(channelId))
        {
            _watchPartyService.StopParty(channelId);
            var wpEntity = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelId);
            if (wpEntity != null)
            {
                _db.WatchParties.Remove(wpEntity);
                await _db.SaveChangesAsync();
            }
            var ch = await _db.Channels.FindAsync(channelId);
            if (ch?.ServerId != null)
            {
                await Clients.Group($"server:{ch.ServerId}").SendAsync("WatchPartyStoppedInChannel", channelId.ToString());
            }
        }

        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || channel.PersistentChat) return;

        // Use raw SQL for efficient bulk delete (avoids loading entities into memory)
        await _db.Database.ExecuteSqlInterpolatedAsync($@"
            DELETE FROM ""Reactions""
            WHERE ""MessageId"" IN (SELECT ""Id"" FROM ""Messages"" WHERE ""ChannelId"" = {channelId});

            DELETE FROM ""Attachments""
            WHERE ""MessageId"" IN (SELECT ""Id"" FROM ""Messages"" WHERE ""ChannelId"" = {channelId});

            DELETE FROM ""PinnedMessages""
            WHERE ""MessageId"" IN (SELECT ""Id"" FROM ""Messages"" WHERE ""ChannelId"" = {channelId});

            DELETE FROM ""Notifications""
            WHERE ""MessageId"" IN (SELECT ""Id"" FROM ""Messages"" WHERE ""ChannelId"" = {channelId});

            DELETE FROM ""Messages""
            WHERE ""ChannelId"" = {channelId};
        ");
    }

    // Soundboard
    public async Task PlaySoundboardClip(string channelId, string clipId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        if (!Guid.TryParse(clipId, out var clipGuid)) return;

        // Verify user is in voice channel
        var userChannel = _voiceState.GetUserChannel(UserId);
        if (!userChannel.HasValue || userChannel.Value != channelGuid) return;

        // Get channel → server
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null || !channel.ServerId.HasValue) return;

        // Check UseSoundboard permission
        if (!await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.UseSoundboard)) return;

        // Load clip and verify it belongs to this server
        var clip = await _db.SoundboardClips.FirstOrDefaultAsync(sc => sc.Id == clipGuid && sc.ServerId == channel.ServerId.Value);
        if (clip == null) return;

        await Clients.Group($"voice:{channelId}").SendAsync("SoundboardClipPlayed", channelId, clip.Url, clip.Name, UserId);
    }

    // Get online user IDs (for @here mention resolution)
    public static HashSet<string> GetOnlineUserIds()
    {
        return new HashSet<string>(_connections.Values);
    }

    // Get user IDs currently viewing a specific channel
    public static HashSet<string> GetActiveChannelUserIds(Guid channelId)
    {
        var result = new HashSet<string>();
        foreach (var kvp in _activeChannels)
        {
            if (kvp.Value == channelId)
                result.Add(kvp.Key);
        }
        return result;
    }
}
