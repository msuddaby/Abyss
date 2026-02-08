using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class ChannelsController : ControllerBase
{
    private readonly AppDbContext _db;

    public ChannelsController(AppDbContext db) => _db = db;

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet("{channelId}/messages")]
    public async Task<ActionResult<List<MessageDto>>> GetMessages(Guid channelId, [FromQuery] int limit = 50, [FromQuery] Guid? before = null)
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
            var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == channel.ServerId && sm.UserId == UserId);
            if (!isMember) return Forbid();
        }

        var query = _db.Messages
            .Include(m => m.Author)
            .Include(m => m.Attachments)
            .Include(m => m.Reactions)
            .Include(m => m.ReplyToMessage).ThenInclude(r => r!.Author)
            .Where(m => m.ChannelId == channelId);

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
                m.IsDeleted ? new List<AttachmentDto>() : m.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.ContentType, a.Size)).ToList(),
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
            var isMember = await _db.ServerMembers.AnyAsync(sm => sm.ServerId == channel.ServerId && sm.UserId == UserId);
            if (!isMember) return Forbid();
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
                m.IsDeleted ? new List<AttachmentDto>() : m.Attachments.Select(a => new AttachmentDto(a.Id, a.MessageId!.Value, a.FileName, a.FilePath, a.ContentType, a.Size)).ToList(),
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
}
