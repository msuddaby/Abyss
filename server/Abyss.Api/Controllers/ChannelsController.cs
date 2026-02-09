using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class ChannelsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;

    public ChannelsController(AppDbContext db, PermissionService perms)
    {
        _db = db;
        _perms = perms;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet("{channelId}/messages")]
    public async Task<ActionResult<List<MessageDto>>> GetMessages(Guid channelId, [FromQuery] int limit = 50, [FromQuery] Guid? before = null, [FromQuery] Guid? after = null)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null) return NotFound();

        // DM channel: check participant
        if (channel.Type == Abyss.Api.Models.ChannelType.DM)
        {
            if (channel.DmUser1Id != UserId && channel.DmUser2Id != UserId) return Forbid();
        }
        else
        {
            if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel)) return Forbid();
            if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ReadMessageHistory)) return Forbid();
        }

        var query = _db.Messages
            .Include(m => m.Author)
            .Include(m => m.Attachments)
            .Include(m => m.Reactions)
            .Include(m => m.ReplyToMessage).ThenInclude(r => r!.Author)
            .Where(m => m.ChannelId == channelId);

        if (after.HasValue)
        {
            var afterMsg = await _db.Messages.FindAsync(after.Value);
            if (afterMsg != null)
                query = query.Where(m => m.CreatedAt > afterMsg.CreatedAt);

            var newerMessages = await query
                .OrderBy(m => m.CreatedAt)
                .Take(limit)
                .Select(m => new MessageDto(
                    m.Id,
                    m.IsDeleted ? "" : m.Content,
                    m.AuthorId,
                    new UserDto(m.Author.Id, m.Author.UserName!, m.Author.DisplayName, m.Author.AvatarUrl, m.Author.Status, m.Author.Bio),
                    m.ChannelId,
                    m.CreatedAt,
                    m.IsDeleted ? new List<AttachmentDto>() : m.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size)).ToList(),
                    m.EditedAt,
                    m.IsDeleted,
                    m.IsSystem,
                    m.IsDeleted ? new List<ReactionDto>() : m.Reactions.Select(r => new ReactionDto(r.Id, r.MessageId, r.UserId, r.Emoji)).ToList(),
                    m.ReplyToMessageId,
                    m.ReplyToMessage == null ? null : new ReplyReferenceDto(
                        m.ReplyToMessage.Id,
                        m.ReplyToMessage.IsDeleted ? "" : m.ReplyToMessage.Content,
                        m.ReplyToMessage.AuthorId,
                        new UserDto(m.ReplyToMessage.Author.Id, m.ReplyToMessage.Author.UserName!, m.ReplyToMessage.Author.DisplayName, m.ReplyToMessage.Author.AvatarUrl, m.ReplyToMessage.Author.Status, m.ReplyToMessage.Author.Bio),
                        m.ReplyToMessage.IsDeleted
                    )
                ))
                .ToListAsync();

            return Ok(newerMessages);
        }

        if (before.HasValue)
        {
            var beforeMsg = await _db.Messages.FindAsync(before.Value);
            if (beforeMsg != null)
                query = query.Where(m => m.CreatedAt < beforeMsg.CreatedAt);
        }

        var messages = await query
            .OrderByDescending(m => m.CreatedAt)
            .Take(limit)
            .OrderBy(m => m.CreatedAt)
            .Select(m => new MessageDto(
                m.Id,
                m.IsDeleted ? "" : m.Content,
                m.AuthorId,
                new UserDto(m.Author.Id, m.Author.UserName!, m.Author.DisplayName, m.Author.AvatarUrl, m.Author.Status, m.Author.Bio),
                m.ChannelId,
                m.CreatedAt,
                m.IsDeleted ? new List<AttachmentDto>() : m.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size)).ToList(),
                m.EditedAt,
                m.IsDeleted,
                m.IsSystem,
                m.IsDeleted ? new List<ReactionDto>() : m.Reactions.Select(r => new ReactionDto(r.Id, r.MessageId, r.UserId, r.Emoji)).ToList(),
                m.ReplyToMessageId,
                m.ReplyToMessage == null ? null : new ReplyReferenceDto(
                    m.ReplyToMessage.Id,
                    m.ReplyToMessage.IsDeleted ? "" : m.ReplyToMessage.Content,
                    m.ReplyToMessage.AuthorId,
                    new UserDto(m.ReplyToMessage.Author.Id, m.ReplyToMessage.Author.UserName!, m.ReplyToMessage.Author.DisplayName, m.ReplyToMessage.Author.AvatarUrl, m.ReplyToMessage.Author.Status, m.ReplyToMessage.Author.Bio),
                    m.ReplyToMessage.IsDeleted
                )
            ))
            .ToListAsync();

        return Ok(messages);
    }

    [HttpGet("{channelId}/messages/around/{messageId}")]
    public async Task<ActionResult<List<MessageDto>>> GetMessagesAround(Guid channelId, Guid messageId)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null) return NotFound();

        if (channel.Type == Abyss.Api.Models.ChannelType.DM)
        {
            if (channel.DmUser1Id != UserId && channel.DmUser2Id != UserId) return Forbid();
        }
        else
        {
            if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel)) return Forbid();
            if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ReadMessageHistory)) return Forbid();
        }

        var target = await _db.Messages.FindAsync(messageId);
        if (target == null || target.ChannelId != channelId) return NotFound();

        var beforeMessages = await _db.Messages
            .Where(m => m.ChannelId == channelId && m.CreatedAt < target.CreatedAt)
            .OrderByDescending(m => m.CreatedAt)
            .Take(25)
            .Select(m => m.Id)
            .ToListAsync();

        var afterMessages = await _db.Messages
            .Where(m => m.ChannelId == channelId && m.CreatedAt > target.CreatedAt)
            .OrderBy(m => m.CreatedAt)
            .Take(25)
            .Select(m => m.Id)
            .ToListAsync();

        var allIds = beforeMessages.Concat(new[] { messageId }).Concat(afterMessages).ToList();

        var messages = await _db.Messages
            .Include(m => m.Author)
            .Include(m => m.Attachments)
            .Include(m => m.Reactions)
            .Include(m => m.ReplyToMessage).ThenInclude(r => r!.Author)
            .Where(m => allIds.Contains(m.Id))
            .OrderBy(m => m.CreatedAt)
            .Select(m => new MessageDto(
                m.Id,
                m.IsDeleted ? "" : m.Content,
                m.AuthorId,
                new UserDto(m.Author.Id, m.Author.UserName!, m.Author.DisplayName, m.Author.AvatarUrl, m.Author.Status, m.Author.Bio),
                m.ChannelId,
                m.CreatedAt,
                m.IsDeleted ? new List<AttachmentDto>() : m.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size)).ToList(),
                m.EditedAt,
                m.IsDeleted,
                m.IsSystem,
                m.IsDeleted ? new List<ReactionDto>() : m.Reactions.Select(r => new ReactionDto(r.Id, r.MessageId, r.UserId, r.Emoji)).ToList(),
                m.ReplyToMessageId,
                m.ReplyToMessage == null ? null : new ReplyReferenceDto(
                    m.ReplyToMessage.Id,
                    m.ReplyToMessage.IsDeleted ? "" : m.ReplyToMessage.Content,
                    m.ReplyToMessage.AuthorId,
                    new UserDto(m.ReplyToMessage.Author.Id, m.ReplyToMessage.Author.UserName!, m.ReplyToMessage.Author.DisplayName, m.ReplyToMessage.Author.AvatarUrl, m.ReplyToMessage.Author.Status, m.ReplyToMessage.Author.Bio),
                    m.ReplyToMessage.IsDeleted
                )
            ))
            .ToListAsync();

        return Ok(messages);
    }

    [HttpGet("{channelId}/pins")]
    public async Task<ActionResult<List<PinnedMessageDto>>> GetPins(Guid channelId)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null) return NotFound();

        // DM channel: check participant
        if (channel.Type == Abyss.Api.Models.ChannelType.DM)
        {
            if (channel.DmUser1Id != UserId && channel.DmUser2Id != UserId) return Forbid();
        }
        else
        {
            if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ViewChannel)) return Forbid();
            if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.ReadMessageHistory)) return Forbid();
        }

        var pins = await _db.PinnedMessages
            .Include(pm => pm.PinnedBy)
            .Include(pm => pm.Message).ThenInclude(m => m.Author)
            .Include(pm => pm.Message).ThenInclude(m => m.Attachments)
            .Include(pm => pm.Message).ThenInclude(m => m.Reactions)
            .Include(pm => pm.Message).ThenInclude(m => m.ReplyToMessage).ThenInclude(r => r!.Author)
            .Where(pm => pm.ChannelId == channelId && !pm.Message.IsDeleted && !pm.Message.IsSystem)
            .OrderByDescending(pm => pm.PinnedAt)
            .Select(pm => new PinnedMessageDto(
                new MessageDto(
                    pm.Message.Id,
                    pm.Message.Content,
                    pm.Message.AuthorId,
                    new UserDto(pm.Message.Author.Id, pm.Message.Author.UserName!, pm.Message.Author.DisplayName, pm.Message.Author.AvatarUrl, pm.Message.Author.Status, pm.Message.Author.Bio),
                    pm.Message.ChannelId,
                    pm.Message.CreatedAt,
                    pm.Message.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.PosterPath, a.ContentType, a.Size)).ToList(),
                    pm.Message.EditedAt,
                    pm.Message.IsDeleted,
                    pm.Message.IsSystem,
                    pm.Message.Reactions.Select(r => new ReactionDto(r.Id, r.MessageId, r.UserId, r.Emoji)).ToList(),
                    pm.Message.ReplyToMessageId,
                    pm.Message.ReplyToMessage == null ? null : new ReplyReferenceDto(
                        pm.Message.ReplyToMessage.Id,
                        pm.Message.ReplyToMessage.IsDeleted ? "" : pm.Message.ReplyToMessage.Content,
                        pm.Message.ReplyToMessage.AuthorId,
                        new UserDto(pm.Message.ReplyToMessage.Author.Id, pm.Message.ReplyToMessage.Author.UserName!, pm.Message.ReplyToMessage.Author.DisplayName, pm.Message.ReplyToMessage.Author.AvatarUrl, pm.Message.ReplyToMessage.Author.Status, pm.Message.ReplyToMessage.Author.Bio),
                        pm.Message.ReplyToMessage.IsDeleted
                    )
                ),
                pm.PinnedAt,
                new UserDto(pm.PinnedBy.Id, pm.PinnedBy.UserName!, pm.PinnedBy.DisplayName, pm.PinnedBy.AvatarUrl, pm.PinnedBy.Status, pm.PinnedBy.Bio)
            ))
            .ToListAsync();

        return Ok(pins);
    }
}
