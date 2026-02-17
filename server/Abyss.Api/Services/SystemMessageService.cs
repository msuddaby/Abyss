using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public class SystemMessageService
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;

    public SystemMessageService(AppDbContext db, IHubContext<ChatHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    public async Task SendMemberJoinLeaveAsync(Guid serverId, string userId, bool joined, string? action = null, string? reason = null)
    {
        var server = await _db.Servers.FindAsync(serverId);
        if (server == null || !server.JoinLeaveMessagesEnabled) return;

        Guid? channelId = server.JoinLeaveChannelId;
        if (channelId.HasValue)
        {
            var exists = await _db.Channels.AnyAsync(c =>
                c.Id == channelId.Value &&
                c.ServerId == serverId &&
                c.Type == ChannelType.Text);
            if (!exists) channelId = null;
        }

        if (!channelId.HasValue)
        {
            channelId = await _db.Channels
                .Where(c => c.ServerId == serverId && c.Type == ChannelType.Text)
                .OrderBy(c => c.Position)
                .Select(c => (Guid?)c.Id)
                .FirstOrDefaultAsync();

            if (!channelId.HasValue) return;
            server.JoinLeaveChannelId = channelId.Value;
        }

        var author = await _db.Users.FindAsync(userId);
        if (author == null) return;

        string content;
        if (joined)
            content = "joined the server.";
        else if (action == "banned")
            content = string.IsNullOrWhiteSpace(reason) ? "was banned." : $"was banned: {reason}";
        else if (action == "kicked")
            content = "was kicked.";
        else
            content = "left the server.";

        var message = new Message
        {
            Id = Guid.NewGuid(),
            Content = content,
            AuthorId = userId,
            ChannelId = channelId.Value,
            CreatedAt = DateTime.UtcNow,
            IsSystem = true,
        };

        _db.Messages.Add(message);
        await _db.SaveChangesAsync();

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

        await _hub.Clients.Group($"channel:{channelId}").SendAsync("ReceiveMessage", messageDto);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("NewUnreadMessage", channelId.ToString(), serverId.ToString());
    }
}
