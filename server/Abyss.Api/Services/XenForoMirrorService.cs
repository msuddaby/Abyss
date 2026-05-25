using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public record XfPostEvent(
    [property: JsonPropertyName("xf_post_id")] int XfPostId,
    [property: JsonPropertyName("xf_thread_id")] int XfThreadId,
    [property: JsonPropertyName("node_id")] int NodeId,
    [property: JsonPropertyName("xf_user_id")] int? XfUserId,
    [property: JsonPropertyName("username")] string? Username,
    [property: JsonPropertyName("avatar_url")] string? AvatarUrl,
    [property: JsonPropertyName("first_post_id")] int? FirstPostId,
    [property: JsonPropertyName("bbcode")] string? Bbcode,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("url")] string? Url,
    [property: JsonPropertyName("created_at")] long? CreatedAt);

public class XenForoMirrorService
{
    // Well-known author for ghost messages (rows where the XF user isn't linked).
    public static readonly string BotUserId = "00000000-0000-0000-0000-00000000abf0";
    public const string BotUserName = "xenforo-bot";
    public const string BotDisplayName = "Forum";

    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;
    private readonly ILogger<XenForoMirrorService> _logger;

    public XenForoMirrorService(AppDbContext db, IHubContext<ChatHub> hub, ILogger<XenForoMirrorService> logger)
    {
        _db = db;
        _hub = hub;
        _logger = logger;
    }

    public async Task HandlePostCreatedAsync(XfPostEvent evt, CancellationToken ct)
    {
        if (evt.XfPostId <= 0)
        {
            _logger.LogWarning("XF webhook missing xf_post_id");
            return;
        }

        // Idempotency: if we've already mirrored this post, treat as a no-op.
        var existing = await _db.XenForoPostMessages.AsNoTracking()
            .FirstOrDefaultAsync(x => x.XfPostId == evt.XfPostId, ct);
        if (existing != null) return;

        var subscribedChannels = await _db.Channels.AsNoTracking()
            .Where(c => c.Type == ChannelType.XenForoMirror && c.XenForoNodeId == evt.NodeId)
            .ToListAsync(ct);
        if (subscribedChannels.Count == 0) return;

        // Resolve author: linked Abyss user if available, else the bot user with ghost identity.
        string authorId;
        string? ghostName = null;
        string? ghostAvatar = null;
        XenForoConnection? link = null;
        if (evt.XfUserId is int xfUid && xfUid > 0)
        {
            link = await _db.XenForoConnections.AsNoTracking().FirstOrDefaultAsync(c => c.XfUserId == xfUid, ct);
        }
        if (link != null)
        {
            authorId = link.OwnerId;
        }
        else
        {
            authorId = BotUserId;
            ghostName = string.IsNullOrWhiteSpace(evt.Username) ? "Unknown" : evt.Username!.Trim();
            ghostAvatar = string.IsNullOrWhiteSpace(evt.AvatarUrl) ? null : evt.AvatarUrl;
        }

        var content = XenForoBridgeService.BbcodeToMarkdown(evt.Bbcode);
        var createdAt = evt.CreatedAt.HasValue
            ? DateTimeOffset.FromUnixTimeSeconds(evt.CreatedAt.Value).UtcDateTime
            : DateTime.UtcNow;

        foreach (var channel in subscribedChannels)
        {
            // Resolve reply-parent for posts that aren't the thread OP. The XF
            // addon sends first_post_id of the thread; if our event is a reply,
            // it'll differ from xf_post_id.
            Guid? replyToMessageId = null;
            if (evt.FirstPostId is int firstPostId && firstPostId > 0 && firstPostId != evt.XfPostId)
            {
                replyToMessageId = await _db.XenForoPostMessages.AsNoTracking()
                    .Where(x => x.ChannelId == channel.Id && x.XfPostId == firstPostId)
                    .Select(x => (Guid?)x.MessageId)
                    .FirstOrDefaultAsync(ct);
            }

            var messageContent = !string.IsNullOrWhiteSpace(evt.Title) && replyToMessageId is null
                ? $"**{evt.Title!.Trim()}**\n\n{content}".Trim()
                : content;

            var message = new Message
            {
                Id = Guid.NewGuid(),
                Content = messageContent,
                AuthorId = authorId,
                ChannelId = channel.Id,
                CreatedAt = createdAt,
                ReplyToMessageId = replyToMessageId,
                GhostAuthorName = ghostName,
                GhostAuthorAvatarUrl = ghostAvatar,
                XfPostId = evt.XfPostId,
                XfPostUrl = evt.Url,
            };
            _db.Messages.Add(message);
            _db.XenForoPostMessages.Add(new XenForoPostMessage
            {
                XfPostId = evt.XfPostId,
                MessageId = message.Id,
                ChannelId = channel.Id,
                CreatedAt = DateTime.UtcNow,
            });
            await _db.SaveChangesAsync(ct);

            var author = await _db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == authorId, ct);
            if (author == null)
            {
                _logger.LogError("XF mirror: author user {AuthorId} not found", authorId);
                continue;
            }

            var authorDto = new UserDto(author.Id, author.UserName ?? BotUserName, author.DisplayName, author.AvatarUrl, author.Status, author.Bio, author.PresenceStatus);
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
                false,
                new List<ReactionDto>(),
                message.ReplyToMessageId,
                null,
                ghostName,
                ghostAvatar,
                message.XfPostUrl);

            await _hub.Clients.Group($"channel:{channel.Id}").SendAsync("ReceiveMessage", messageDto, ct);
            if (channel.ServerId.HasValue)
            {
                await _hub.Clients.Group($"server:{channel.ServerId}").SendAsync(
                    "NewUnreadMessage", channel.Id.ToString(), channel.ServerId.ToString(), ct);
            }
        }
    }

    public async Task HandlePostUpdatedAsync(XfPostEvent evt, CancellationToken ct)
    {
        if (evt.XfPostId <= 0) return;

        var mappings = await _db.XenForoPostMessages
            .Where(x => x.XfPostId == evt.XfPostId)
            .ToListAsync(ct);
        if (mappings.Count == 0)
        {
            // Edit arrived before create (or the post was edited before any channel was subscribed):
            // treat as a create so the mirror catches up.
            await HandlePostCreatedAsync(evt, ct);
            return;
        }

        var newContent = XenForoBridgeService.BbcodeToMarkdown(evt.Bbcode);
        foreach (var map in mappings)
        {
            var message = await _db.Messages.FirstOrDefaultAsync(m => m.Id == map.MessageId, ct);
            if (message == null) continue;
            message.Content = newContent;
            message.EditedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync(ct);
            await _hub.Clients.Group($"channel:{message.ChannelId}").SendAsync(
                "MessageEdited", message.Id.ToString(), message.Content, message.EditedAt, ct);
        }
    }

    public async Task HandlePostDeletedAsync(int xfPostId, CancellationToken ct)
    {
        if (xfPostId <= 0) return;

        var mappings = await _db.XenForoPostMessages
            .Where(x => x.XfPostId == xfPostId)
            .ToListAsync(ct);
        foreach (var map in mappings)
        {
            var message = await _db.Messages.FirstOrDefaultAsync(m => m.Id == map.MessageId, ct);
            if (message == null || message.IsDeleted) continue;
            message.IsDeleted = true;
            await _db.SaveChangesAsync(ct);
            await _hub.Clients.Group($"channel:{message.ChannelId}").SendAsync(
                "MessageDeleted", message.Id.ToString(), ct);
        }
    }
}
