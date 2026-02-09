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

    private const int DefaultMaxMessageLength = 4000;
    private const int MaxMessageLengthUpperBound = 10000;
    private const int MaxAttachmentsPerMessage = 10;
    private const int MaxPinnedMessagesPerChannel = 50;
    private const string MaxMessageLengthKey = "MaxMessageLength";

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
            return await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.ViewChannel);
        return false;
    }

    private async Task<List<string>> GetUserIdsWithChannelPermission(Guid channelId, Permission perm)
    {
        var channel = await _db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
        if (channel?.ServerId == null) return new List<string>();

        var memberIds = await _db.ServerMembers
            .Where(sm => sm.ServerId == channel.ServerId)
            .Select(sm => sm.UserId)
            .ToListAsync();

        var allowed = new List<string>();
        foreach (var userId in memberIds)
        {
            if (await _perms.HasChannelPermissionAsync(channelId, userId, perm))
                allowed.Add(userId);
        }

        return allowed;
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

        var authorDto = new UserDto(author.Id, author.UserName!, author.DisplayName, author.AvatarUrl, author.Status, author.Bio);
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
                        var recipients = await GetUserIdsWithChannelPermission(voiceChannel.Value, Permission.ViewChannel);
                        foreach (var userId in recipients)
                        {
                            await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", voiceChannel.Value.ToString(), UserId);
                        }
                    }
                    var leftRecipients = await GetUserIdsWithChannelPermission(voiceChannel.Value, Permission.ViewChannel);
                    foreach (var userId in leftRecipients)
                    {
                        await Clients.Group($"user:{userId}").SendAsync("VoiceUserLeftChannel", voiceChannel.Value.ToString(), UserId);
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

        var messageDto = new MessageDto(message.Id, message.Content, message.AuthorId, authorDto, message.ChannelId, message.CreatedAt, attachments, null, false, false, new List<ReactionDto>(), replyToGuid, replyDto);

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
            // Server channel: broadcast unread indicator to users who can view the channel
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("NewUnreadMessage", channelId, channel.ServerId.ToString());
            }

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
                if (await _perms.HasChannelPermissionAsync(channelGuid, replyDto.AuthorId, Permission.ViewChannel))
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
            new UserDto(message.Author.Id, message.Author.UserName!, message.Author.DisplayName, message.Author.AvatarUrl, message.Author.Status, message.Author.Bio),
            message.ChannelId,
            message.CreatedAt,
            message.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.ContentType, a.Size)).ToList(),
            message.EditedAt,
            message.IsDeleted,
            message.IsSystem,
            message.Reactions.Select(r => new ReactionDto(r.Id, r.MessageId, r.UserId, r.Emoji)).ToList(),
            message.ReplyToMessageId,
            message.ReplyToMessage == null ? null : new ReplyReferenceDto(
                message.ReplyToMessage.Id,
                message.ReplyToMessage.IsDeleted ? "" : message.ReplyToMessage.Content,
                message.ReplyToMessage.AuthorId,
                new UserDto(message.ReplyToMessage.Author.Id, message.ReplyToMessage.Author.UserName!, message.ReplyToMessage.Author.DisplayName, message.ReplyToMessage.Author.AvatarUrl, message.ReplyToMessage.Author.Status, message.ReplyToMessage.Author.Bio),
                message.ReplyToMessage.IsDeleted
            )
        );

        var pinDto = new PinnedMessageDto(
            messageDto,
            pin.PinnedAt,
            new UserDto(pinnedBy.Id, pinnedBy.UserName!, pinnedBy.DisplayName, pinnedBy.AvatarUrl, pinnedBy.Status, pinnedBy.Bio)
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
        var canSpeak = await _perms.HasChannelPermissionAsync(channelGuid, UserId, Permission.Speak);

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
                    var recipients = await GetUserIdsWithChannelPermission(currentChannel.Value, Permission.ViewChannel);
                    foreach (var userId in recipients)
                    {
                        await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", currentChannel.Value.ToString(), UserId);
                    }
                }
                var leftRecipients = await GetUserIdsWithChannelPermission(currentChannel.Value, Permission.ViewChannel);
                foreach (var userId in leftRecipients)
                {
                    await Clients.Group($"user:{userId}").SendAsync("VoiceUserLeftChannel", currentChannel.Value.ToString(), UserId);
                }
            }
        }

        var effectiveMuted = isMuted || !canSpeak;
        _voiceState.JoinChannel(channelGuid, UserId, DisplayName, effectiveMuted, isDeafened, Context.ConnectionId);
        if (!canSpeak)
        {
            _voiceState.UpdateUserState(channelGuid, UserId, effectiveMuted, isDeafened, true, null);
        }
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
            var state = new VoiceUserStateDto(DisplayName, effectiveMuted, isDeafened, !canSpeak, false);
            var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in recipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("VoiceUserJoinedChannel", channelId, UserId, state);
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
                var recipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
                foreach (var userId in recipients)
                {
                    await Clients.Group($"user:{userId}").SendAsync("ScreenShareStoppedInChannel", channelId, UserId);
                }
            }
            var leftRecipients = await GetUserIdsWithChannelPermission(channelGuid, Permission.ViewChannel);
            foreach (var userId in leftRecipients)
            {
                await Clients.Group($"user:{userId}").SendAsync("VoiceUserLeftChannel", channelId, UserId);
            }
        }
    }

    // Screen sharing
    public async Task NotifyScreenShare(string channelId, bool isSharing)
    {
        if (!Guid.TryParse(channelId, out var channelGuid)) return;
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
        var allowedChannelIds = new List<Guid>();
        foreach (var channelId in channelIds)
        {
            if (await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel))
                allowedChannelIds.Add(channelId);
        }
        return _voiceState.GetSharersForChannels(allowedChannelIds);
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
