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

    public async Task SendMemberJoinLeaveAsync(Guid serverId, string userId, bool joined)
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

        var message = new Message
        {
            Id = Guid.NewGuid(),
            Content = joined ? "joined the server." : "left the server.",
            AuthorId = userId,
            ChannelId = channelId.Value,
            CreatedAt = DateTime.UtcNow,
            IsSystem = true,
        };

        _db.Messages.Add(message);
        await _db.SaveChangesAsync();

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

        await _hub.Clients.Group($"channel:{channelId}").SendAsync("ReceiveMessage", messageDto);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("NewUnreadMessage", channelId.ToString(), serverId.ToString());
    }
}
