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

    private const int MaxMessageLength = 4000;
    private const int MaxAttachmentsPerMessage = 10;

    // Track online users: connectionId -> userId
    internal static readonly Dictionary<string, string> _connections = new();
    internal static readonly object _lock = new();

    public ChatHub(AppDbContext db, VoiceStateService voiceState, PermissionService perms, NotificationService notifications)
    {
        _db = db;
        _voiceState = voiceState;
        _perms = perms;
        _notifications = notifications;
    }

    private string UserId => Context.User!.FindFirstValue(ClaimTypes.NameIdentifier)!;
    private string DisplayName => Context.User!.FindFirstValue("displayName") ?? "Unknown";

    private async Task<bool> CanAccessChannel(Channel channel)
    {
        if (channel.Type == ChannelType.DM)
            return channel.DmUser1Id == UserId || channel.DmUser2Id == UserId;
        if (channel.ServerId.HasValue)
            return await _perms.IsMemberAsync(channel.ServerId.Value, UserId);
        return false;
    }

    private static bool TryNormalizeAndValidateMessageForSend(string content, int attachmentCount, out string normalized, out string? error)
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
                error = $"Message must be 1-{MaxMessageLength} characters";
                return false;
            }

            normalized = string.Empty;
        }

        if (normalized.Length > MaxMessageLength)
        {
            error = $"Message must be 1-{MaxMessageLength} characters";
            return false;
        }

        return true;
    }

    private static bool TryValidateMessageForEdit(string newContent, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(newContent) || newContent.Length > MaxMessageLength)
        {
            error = $"Message must be 1-{MaxMessageLength} characters";
            return false;
        }

        return true;
    }

    public override async Task OnConnectedAsync()
    {
        lock (_lock) { _connections[Context.ConnectionId] = UserId; }

        // Join per-user group for targeted notifications
        await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{UserId}");

        // Notify all servers the user is in
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == UserId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        foreach (var serverId in serverIds)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"server:{serverId}");
            await Clients.Group($"server:{serverId}").SendAsync("UserOnline", UserId, DisplayName);
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
        lock (_lock) { _connections.Remove(Context.ConnectionId); }

        // Check if user has no more connections
        bool stillOnline;
        lock (_lock) { stillOnline = _connections.ContainsValue(UserId); }

        if (!stillOnline)
        {
            var serverIds = await _db.ServerMembers
                .Where(sm => sm.UserId == UserId)
                .Select(sm => sm.ServerId)
                .ToListAsync();

            foreach (var serverId in serverIds)
            {
                await Clients.Group($"server:{serverId}").SendAsync("UserOffline", UserId);
            }
        }

        // Leave voice if this was the voice connection (or user is fully offline).
        // Voice is tied to a specific connection (WebRTC peers), so clean up
        // even if the user has other connections open (e.g. another browser tab).
        var isVoiceConn = _voiceState.IsVoiceConnection(UserId, Context.ConnectionId);
        if (isVoiceConn || !stillOnline)
        {
            var voiceChannel = _voiceState.GetUserChannel(UserId);
            if (voiceChannel.HasValue)
            {
                // Check if user was screen sharing before leaving
                var wasSharing = _voiceState.IsScreenSharing(voiceChannel.Value, UserId);
                if (wasSharing)
                {
                    _voiceState.RemoveScreenSharer(voiceChannel.Value, UserId);
                    await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("ScreenShareStopped", UserId);
                }

                _voiceState.LeaveChannel(voiceChannel.Value, UserId);
                await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("UserLeftVoice", UserId);

                // Notify server group so sidebar updates
                var channel = await _db.Channels.FindAsync(voiceChannel.Value);
                if (channel?.ServerId != null)
                {
                    if (wasSharing)
                    {
                        await Clients.Group($"server:{channel.ServerId}").SendAsync("ScreenShareStoppedInChannel", voiceChannel.Value.ToString(), UserId);
                    }
                    await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserLeftChannel", voiceChannel.Value.ToString(), UserId);
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
        await Groups.AddToGroupAsync(Context.ConnectionId, $"channel:{channelId}");
    }

    public async Task LeaveChannel(string channelId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"channel:{channelId}");
    }

    // Lightweight health check for clients.
    public string Ping()
    {
        return "pong";
    }

    public async Task SendMessage(string channelId, string content, List<string> attachmentIds, string? replyToMessageId = null)
    {
        if (attachmentIds == null)
        {
            await Clients.Caller.SendAsync("Error", "Attachments list is required.");
            return;
        }

        if (!TryNormalizeAndValidateMessageForSend(content, attachmentIds.Count, out var normalizedContent, out var error))
        {
            await Clients.Caller.SendAsync("Error", error);
            return;
        }

        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await CanAccessChannel(channel)) return;

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
                    attachments.Add(new AttachmentDto(att.Id, message.Id, att.FileName, att.FilePath, att.ContentType, att.Size));
                }
            }
        }

        await _db.SaveChangesAsync();

        var author = await _db.Users.FindAsync(UserId);
        var authorDto = new UserDto(author!.Id, author.UserName!, author.DisplayName, author.AvatarUrl, author.Status, author.Bio);

        // Build reply reference DTO
        ReplyReferenceDto? replyDto = null;
        if (replyToGuid.HasValue)
        {
            var replyMsg = await _db.Messages.Include(m => m.Author).FirstOrDefaultAsync(m => m.Id == replyToGuid.Value);
            if (replyMsg != null)
            {
                var replyAuthorDto = new UserDto(replyMsg.Author.Id, replyMsg.Author.UserName!, replyMsg.Author.DisplayName, replyMsg.Author.AvatarUrl, replyMsg.Author.Status, replyMsg.Author.Bio);
                replyDto = new ReplyReferenceDto(replyMsg.Id, replyMsg.IsDeleted ? "" : replyMsg.Content, replyMsg.AuthorId, replyAuthorDto, replyMsg.IsDeleted);
            }
        }

        var messageDto = new MessageDto(message.Id, message.Content, message.AuthorId, authorDto, message.ChannelId, message.CreatedAt, attachments, null, false, new List<ReactionDto>(), replyToGuid, replyDto);

        await Clients.Group($"channel:{channelId}").SendAsync("ReceiveMessage", messageDto);

        if (channel.Type == ChannelType.DM)
        {
            // DM: send unread notification to the other user
            var recipientId = channel.DmUser1Id == UserId ? channel.DmUser2Id! : channel.DmUser1Id!;
            await Clients.Group($"user:{recipientId}").SendAsync("NewUnreadMessage", channelId, (string?)null);

            // Create DM notification for the recipient
            var dmNotification = new Notification
            {
                Id = Guid.NewGuid(),
                UserId = recipientId,
                MessageId = message.Id,
                ChannelId = channelGuid,
                ServerId = null,
                Type = NotificationType.UserMention,
                CreatedAt = DateTime.UtcNow,
            };
            _db.Notifications.Add(dmNotification);
            await _db.SaveChangesAsync();

            var dmNotifDto = new NotificationDto(dmNotification.Id, dmNotification.MessageId, dmNotification.ChannelId, null, dmNotification.Type.ToString(), dmNotification.CreatedAt);
            await Clients.Group($"user:{recipientId}").SendAsync("MentionReceived", dmNotifDto);
        }
        else if (channel.ServerId.HasValue)
        {
            // Server channel: broadcast unread indicator to all server members
            await Clients.Group($"server:{channel.ServerId}").SendAsync("NewUnreadMessage", channelId, channel.ServerId.ToString());

            // Process mentions and send targeted notifications
            HashSet<string> onlineUserIds;
            lock (_lock) { onlineUserIds = new HashSet<string>(_connections.Values); }

            var notifications = await _notifications.CreateMentionNotifications(message, channel.ServerId.Value, channelGuid, onlineUserIds);
            var notifiedUserIds = new HashSet<string>(notifications.Select(n => n.UserId));
            foreach (var notification in notifications)
            {
                var dto = new NotificationDto(notification.Id, notification.MessageId, notification.ChannelId, notification.ServerId, notification.Type.ToString(), notification.CreatedAt);
                await Clients.Group($"user:{notification.UserId}").SendAsync("MentionReceived", dto);
            }

            // Reply notification: if replying to someone else who wasn't already notified
            if (replyToGuid.HasValue && replyDto != null && replyDto.AuthorId != UserId && !notifiedUserIds.Contains(replyDto.AuthorId))
            {
                var replyNotification = new Notification
                {
                    Id = Guid.NewGuid(),
                    UserId = replyDto.AuthorId,
                    MessageId = message.Id,
                    ChannelId = channelGuid,
                    ServerId = channel.ServerId,
                    Type = NotificationType.ReplyMention,
                    CreatedAt = DateTime.UtcNow,
                };
                _db.Notifications.Add(replyNotification);
                await _db.SaveChangesAsync();

                var replyNotifDto = new NotificationDto(replyNotification.Id, replyNotification.MessageId, replyNotification.ChannelId, replyNotification.ServerId, replyNotification.Type.ToString(), replyNotification.CreatedAt);
                await Clients.Group($"user:{replyDto.AuthorId}").SendAsync("MentionReceived", replyNotifDto);
            }
        }
    }

    public async Task EditMessage(string messageId, string newContent)
    {
        if (!TryValidateMessageForEdit(newContent, out var error))
        {
            await Clients.Caller.SendAsync("Error", error);
            return;
        }

        if (!Guid.TryParse(messageId, out var msgGuid)) return;
        var message = await _db.Messages.FindAsync(msgGuid);
        if (message == null || message.AuthorId != UserId || message.IsDeleted) return;

        message.Content = newContent;
        message.EditedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageEdited", message.Id.ToString(), newContent, message.EditedAt);
    }

    public async Task DeleteMessage(string messageId)
    {
        if (!Guid.TryParse(messageId, out var msgGuid)) return;
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null) return;

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
        await _db.SaveChangesAsync();

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageDeleted", message.Id.ToString());
    }

    // Reactions
    public async Task ToggleReaction(string messageId, string emoji)
    {
        if (!Guid.TryParse(messageId, out var msgGuid)) return;
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null || message.IsDeleted) return;
        if (!await CanAccessChannel(message.Channel)) return;

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
    public async Task<List<string>> GetOnlineUsers(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new List<string>();
        var memberUserIds = await _db.ServerMembers
            .Where(sm => sm.ServerId == serverGuid)
            .Select(sm => sm.UserId)
            .ToListAsync();

        HashSet<string> onlineUserIds;
        lock (_lock)
        {
            onlineUserIds = new HashSet<string>(_connections.Values);
        }

        return memberUserIds.Where(uid => onlineUserIds.Contains(uid)).ToList();
    }

    // Get voice users for all channels in a server (for sidebar display)
    public async Task<Dictionary<Guid, Dictionary<string, VoiceUserStateDto>>> GetServerVoiceUsers(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new Dictionary<Guid, Dictionary<string, VoiceUserStateDto>>();
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        return _voiceState.GetUsersForChannels(channelIds);
    }

    // Voice channels
    public async Task JoinVoiceChannel(string channelId, bool isMuted = false, bool isDeafened = false)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;

        // Membership check
        var voiceChannel = await _db.Channels.FindAsync(channelGuid);
        if (voiceChannel == null || !voiceChannel.ServerId.HasValue) return;
        if (!await _perms.IsMemberAsync(voiceChannel.ServerId.Value, UserId)) return;

        // Enforce single voice session: if user is already in voice, notify other sessions to disconnect
        var currentChannel = _voiceState.GetUserChannel(UserId);
        if (currentChannel.HasValue)
        {
            // Notify all other sessions for this user to leave voice
            await Clients.OthersInGroup($"user:{UserId}").SendAsync("VoiceSessionReplaced", "You have joined voice from another device.");
        }

        // Leave any existing voice channel from THIS connection
        if (currentChannel.HasValue)
        {
            // Clear screen share if leaving while sharing
            var wasSharing = _voiceState.IsScreenSharing(currentChannel.Value, UserId);
            if (wasSharing)
            {
                _voiceState.RemoveScreenSharer(currentChannel.Value, UserId);
                await Clients.Group($"voice:{currentChannel.Value}").SendAsync("ScreenShareStopped", UserId);
            }

            _voiceState.LeaveChannel(currentChannel.Value, UserId);
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"voice:{currentChannel.Value}");
            await Clients.Group($"voice:{currentChannel.Value}").SendAsync("UserLeftVoice", UserId);

            // Notify the server group so sidebar updates for non-participants
            var prevChannel = await _db.Channels.FindAsync(currentChannel.Value);
            if (prevChannel?.ServerId != null)
            {
                if (wasSharing)
                {
                    await Clients.Group($"server:{prevChannel.ServerId}").SendAsync("ScreenShareStoppedInChannel", currentChannel.Value.ToString(), UserId);
                }
                await Clients.Group($"server:{prevChannel.ServerId}").SendAsync("VoiceUserLeftChannel", currentChannel.Value.ToString(), UserId);
            }
        }

        _voiceState.JoinChannel(channelGuid, UserId, DisplayName, isMuted, isDeafened, Context.ConnectionId);
        await Groups.AddToGroupAsync(Context.ConnectionId, $"voice:{channelId}");

        // Send current participants to the joining user
        var users = _voiceState.GetChannelUsersDisplayNames(channelGuid);
        await Clients.Caller.SendAsync("VoiceChannelUsers", users);

        // Send current screen sharers to the joining user
        var currentSharers = _voiceState.GetScreenSharers(channelGuid);
        if (currentSharers.Count > 0)
        {
            await Clients.Caller.SendAsync("ActiveSharers", currentSharers);
        }

        // Notify voice group for WebRTC setup
        await Clients.OthersInGroup($"voice:{channelId}").SendAsync("UserJoinedVoice", UserId, DisplayName);

        // Notify the server group so sidebar updates for non-participants
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel?.ServerId != null)
        {
            var state = new VoiceUserStateDto(DisplayName, isMuted, isDeafened, false, false);
            await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserJoinedChannel", channelId, UserId, state);
        }
    }

    public async Task UpdateVoiceState(bool isMuted, bool isDeafened)
    {
        var channelId = _voiceState.GetUserChannel(UserId);
        if (!channelId.HasValue) return;

        var updated = _voiceState.UpdateUserState(channelId.Value, UserId, isMuted, isDeafened);
        if (updated == null) return;

        var channel = await _db.Channels.FindAsync(channelId.Value);
        if (channel?.ServerId != null)
        {
            await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserStateUpdated", channelId.Value.ToString(), UserId, updated);
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

        await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserStateUpdated", channelId.Value.ToString(), targetUserId, updated);
    }

    public async Task LeaveVoiceChannel(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;

        // Clear screen share if leaving while sharing
        var wasSharing = _voiceState.IsScreenSharing(channelGuid, UserId);
        if (wasSharing)
        {
            _voiceState.RemoveScreenSharer(channelGuid, UserId);
            await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareStopped", UserId);
        }

        _voiceState.LeaveChannel(channelGuid, UserId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"voice:{channelId}");
        await Clients.Group($"voice:{channelId}").SendAsync("UserLeftVoice", UserId);

        // Notify the server group so sidebar updates for non-participants
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel?.ServerId != null)
        {
            if (wasSharing)
            {
                await Clients.Group($"server:{channel.ServerId}").SendAsync("ScreenShareStoppedInChannel", channelId, UserId);
            }
            await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserLeftChannel", channelId, UserId);
        }
    }

    // Screen sharing
    public async Task NotifyScreenShare(string channelId, bool isSharing)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null || !channel.ServerId.HasValue) return;
        if (!await _perms.IsMemberAsync(channel.ServerId.Value, UserId)) return;

        if (isSharing)
        {
            _voiceState.AddScreenSharer(channelGuid, UserId, DisplayName);
            await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareStarted", UserId, DisplayName);
            await Clients.Group($"server:{channel.ServerId}").SendAsync("ScreenShareStartedInChannel", channelId, UserId);
        }
        else
        {
            _voiceState.RemoveScreenSharer(channelGuid, UserId);
            await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareStopped", UserId);
            await Clients.Group($"server:{channel.ServerId}").SendAsync("ScreenShareStoppedInChannel", channelId, UserId);
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
        List<string> sharerConnections;
        lock (_lock)
        {
            sharerConnections = _connections.Where(c => c.Value == sharerUserId).Select(c => c.Key).ToList();
        }

        foreach (var connId in sharerConnections)
        {
            await Clients.Client(connId).SendAsync("WatchStreamRequested", UserId);
        }
    }

    // Viewer stops watching a sharer's stream
    public async Task StopWatchingStream(string sharerUserId)
    {
        // Relay stop request to the sharer's connections
        List<string> sharerConnections;
        lock (_lock)
        {
            sharerConnections = _connections.Where(c => c.Value == sharerUserId).Select(c => c.Key).ToList();
        }

        foreach (var connId in sharerConnections)
        {
            await Clients.Client(connId).SendAsync("StopWatchingRequested", UserId);
        }
    }

    public async Task SendSignal(string targetUserId, string signal)
    {
        // Verify sender is in a voice channel (membership was checked at join time)
        var senderChannel = _voiceState.GetUserChannel(UserId);
        if (!senderChannel.HasValue) return;

        // Find connection(s) for target user
        List<string> targetConnections;
        lock (_lock)
        {
            targetConnections = _connections.Where(c => c.Value == targetUserId).Select(c => c.Key).ToList();
        }

        foreach (var connId in targetConnections)
        {
            await Clients.Client(connId).SendAsync("ReceiveSignal", UserId, signal);
        }
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
        return _voiceState.GetSharersForChannels(channelIds);
    }

    // Mark a channel as read for the current user
    public async Task MarkChannelRead(string channelId)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
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
    public async Task<List<DmChannelDto>> GetDmChannels()
    {
        var channels = await _db.Channels
            .Include(c => c.DmUser1)
            .Include(c => c.DmUser2)
            .Where(c => c.Type == ChannelType.DM && (c.DmUser1Id == UserId || c.DmUser2Id == UserId))
            .ToListAsync();

        // Sort by LastMessageAt descending, with nulls at end
        channels = channels.OrderByDescending(c => c.LastMessageAt ?? DateTime.MinValue).ToList();

        return channels.Select(c =>
        {
            var other = c.DmUser1Id == UserId ? c.DmUser2! : c.DmUser1!;
            var otherDto = new UserDto(other.Id, other.UserName!, other.DisplayName, other.AvatarUrl, other.Status, other.Bio);
            // Use a derived CreatedAt from the channel Id (sequential GUIDs) — or just use LastMessageAt
            return new DmChannelDto(c.Id, otherDto, c.LastMessageAt, c.LastMessageAt ?? DateTime.UtcNow);
        }).ToList();
    }

    // Get DM unread state
    public async Task<List<DmUnreadDto>> GetDmUnreads()
    {
        return await _notifications.GetDmUnreads(UserId);
    }

    // Get online user IDs (for @here mention resolution)
    public static HashSet<string> GetOnlineUserIds()
    {
        lock (_lock)
        {
            return new HashSet<string>(_connections.Values);
        }
    }
}
