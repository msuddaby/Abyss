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

    // Track online users: connectionId -> userId
    private static readonly Dictionary<string, string> _connections = new();
    private static readonly object _lock = new();

    public ChatHub(AppDbContext db, VoiceStateService voiceState, PermissionService perms)
    {
        _db = db;
        _voiceState = voiceState;
        _perms = perms;
    }

    private string UserId => Context.User!.FindFirstValue(ClaimTypes.NameIdentifier)!;
    private string DisplayName => Context.User!.FindFirstValue("displayName") ?? "Unknown";

    public override async Task OnConnectedAsync()
    {
        lock (_lock) { _connections[Context.ConnectionId] = UserId; }

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

            // Leave voice if connected
            var voiceChannel = _voiceState.GetUserChannel(UserId);
            if (voiceChannel.HasValue)
            {
                // Check if user was screen sharing before leaving
                var sharer = _voiceState.GetScreenSharer(voiceChannel.Value);
                if (sharer.HasValue && sharer.Value.UserId == UserId)
                {
                    _voiceState.ClearScreenSharer(voiceChannel.Value);
                    await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("ScreenShareChanged", UserId, false, "");
                }

                _voiceState.LeaveChannel(voiceChannel.Value, UserId);
                await Clients.Group($"voice:{voiceChannel.Value}").SendAsync("UserLeftVoice", UserId);

                // Notify server group so sidebar updates
                var channel = await _db.Channels.FindAsync(voiceChannel.Value);
                if (channel != null)
                {
                    await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserLeftChannel", voiceChannel.Value.ToString(), UserId);
                }
            }
        }

        await base.OnDisconnectedAsync(exception);
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

    public async Task SendMessage(string channelId, string content, List<string> attachmentIds)
    {
        var channelGuid = Guid.Parse(channelId);
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await _perms.IsMemberAsync(channel.ServerId, UserId)) return;

        var message = new Message
        {
            Id = Guid.NewGuid(),
            Content = content,
            AuthorId = UserId,
            ChannelId = channelGuid,
            CreatedAt = DateTime.UtcNow,
        };
        _db.Messages.Add(message);

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
        var messageDto = new MessageDto(message.Id, message.Content, message.AuthorId, authorDto, message.ChannelId, message.CreatedAt, attachments, null, false, new List<ReactionDto>());

        await Clients.Group($"channel:{channelId}").SendAsync("ReceiveMessage", messageDto);
    }

    public async Task EditMessage(string messageId, string newContent)
    {
        var msgGuid = Guid.Parse(messageId);
        var message = await _db.Messages.FindAsync(msgGuid);
        if (message == null || message.AuthorId != UserId || message.IsDeleted) return;

        message.Content = newContent;
        message.EditedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageEdited", message.Id.ToString(), newContent, message.EditedAt);
    }

    public async Task DeleteMessage(string messageId)
    {
        var msgGuid = Guid.Parse(messageId);
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null) return;

        var isAuthor = message.AuthorId == UserId;
        var canManageMessages = await _perms.HasPermissionAsync(message.Channel.ServerId, UserId, Permission.ManageMessages);
        if (!isAuthor && !canManageMessages) return;

        message.IsDeleted = true;
        await _db.SaveChangesAsync();

        // Log when admin deletes another user's message
        if (!isAuthor && canManageMessages)
        {
            var author = await _db.Users.FindAsync(message.AuthorId);
            await _perms.LogAsync(message.Channel.ServerId, AuditAction.MessageDeleted, UserId,
                targetId: message.AuthorId, targetName: author?.DisplayName);
        }

        await Clients.Group($"channel:{message.ChannelId}").SendAsync("MessageDeleted", message.Id.ToString());
    }

    // Reactions
    public async Task ToggleReaction(string messageId, string emoji)
    {
        var msgGuid = Guid.Parse(messageId);
        var message = await _db.Messages.Include(m => m.Channel).FirstOrDefaultAsync(m => m.Id == msgGuid);
        if (message == null || message.IsDeleted) return;
        if (!await _perms.IsMemberAsync(message.Channel.ServerId, UserId)) return;

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
        var channelGuid = Guid.Parse(channelId);
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await _perms.IsMemberAsync(channel.ServerId, UserId)) return;

        await Clients.OthersInGroup($"channel:{channelId}").SendAsync("UserIsTyping", UserId, DisplayName);
    }

    // Get online users for a server
    public async Task<List<string>> GetOnlineUsers(string serverId)
    {
        var serverGuid = Guid.Parse(serverId);
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
    public async Task<Dictionary<Guid, Dictionary<string, string>>> GetServerVoiceUsers(string serverId)
    {
        var serverGuid = Guid.Parse(serverId);
        var channelIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        return _voiceState.GetUsersForChannels(channelIds);
    }

    // Voice channels
    public async Task JoinVoiceChannel(string channelId)
    {
        var channelGuid = Guid.Parse(channelId);

        // Membership check
        var voiceChannel = await _db.Channels.FindAsync(channelGuid);
        if (voiceChannel == null) return;
        if (!await _perms.IsMemberAsync(voiceChannel.ServerId, UserId)) return;

        // Leave any existing voice channel
        var currentChannel = _voiceState.GetUserChannel(UserId);
        if (currentChannel.HasValue)
        {
            // Clear screen share if leaving while sharing
            var sharer = _voiceState.GetScreenSharer(currentChannel.Value);
            if (sharer.HasValue && sharer.Value.UserId == UserId)
            {
                _voiceState.ClearScreenSharer(currentChannel.Value);
                await Clients.Group($"voice:{currentChannel.Value}").SendAsync("ScreenShareChanged", UserId, false, "");
            }

            _voiceState.LeaveChannel(currentChannel.Value, UserId);
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"voice:{currentChannel.Value}");
            await Clients.Group($"voice:{currentChannel.Value}").SendAsync("UserLeftVoice", UserId);

            // Notify the server group so sidebar updates for non-participants
            var prevChannel = await _db.Channels.FindAsync(currentChannel.Value);
            if (prevChannel != null)
            {
                await Clients.Group($"server:{prevChannel.ServerId}").SendAsync("VoiceUserLeftChannel", currentChannel.Value.ToString(), UserId);
            }
        }

        _voiceState.JoinChannel(channelGuid, UserId, DisplayName);
        await Groups.AddToGroupAsync(Context.ConnectionId, $"voice:{channelId}");

        // Send current participants to the joining user
        var users = _voiceState.GetChannelUsers(channelGuid);
        await Clients.Caller.SendAsync("VoiceChannelUsers", users);

        // Send current screen sharer info to the joining user
        var currentSharer = _voiceState.GetScreenSharer(channelGuid);
        if (currentSharer.HasValue)
        {
            await Clients.Caller.SendAsync("ScreenShareChanged", currentSharer.Value.UserId, true, currentSharer.Value.DisplayName);
        }

        // Notify voice group for WebRTC setup
        await Clients.OthersInGroup($"voice:{channelId}").SendAsync("UserJoinedVoice", UserId, DisplayName);

        // Notify the server group so sidebar updates for non-participants
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel != null)
        {
            await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserJoinedChannel", channelId, UserId, DisplayName);
        }
    }

    public async Task LeaveVoiceChannel(string channelId)
    {
        var channelGuid = Guid.Parse(channelId);

        // Clear screen share if leaving while sharing
        var sharer = _voiceState.GetScreenSharer(channelGuid);
        if (sharer.HasValue && sharer.Value.UserId == UserId)
        {
            _voiceState.ClearScreenSharer(channelGuid);
            await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareChanged", UserId, false, "");
        }

        _voiceState.LeaveChannel(channelGuid, UserId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"voice:{channelId}");
        await Clients.Group($"voice:{channelId}").SendAsync("UserLeftVoice", UserId);

        // Notify the server group so sidebar updates for non-participants
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel != null)
        {
            await Clients.Group($"server:{channel.ServerId}").SendAsync("VoiceUserLeftChannel", channelId, UserId);
        }
    }

    // Screen sharing
    public async Task NotifyScreenShare(string channelId, bool isSharing)
    {
        var channelGuid = Guid.Parse(channelId);
        var channel = await _db.Channels.FindAsync(channelGuid);
        if (channel == null) return;
        if (!await _perms.IsMemberAsync(channel.ServerId, UserId)) return;

        if (isSharing)
        {
            _voiceState.SetScreenSharer(channelGuid, UserId, DisplayName);
        }
        else
        {
            _voiceState.ClearScreenSharer(channelGuid);
        }

        await Clients.Group($"voice:{channelId}").SendAsync("ScreenShareChanged", UserId, isSharing, isSharing ? DisplayName : "");
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
        return _voiceState.GetChannelUsers(Guid.Parse(channelId));
    }
}
