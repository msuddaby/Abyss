using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class DmController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;

    public DmController(AppDbContext db, IHubContext<ChatHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<DmChannelDto>>> GetDmChannels()
    {
        var channels = await _db.Channels
            .Include(c => c.DmUser1)
            .Include(c => c.DmUser2)
            .Where(c => c.Type == ChannelType.DM && (c.DmUser1Id == UserId || c.DmUser2Id == UserId))
            .OrderByDescending(c => c.LastMessageAt)
            .ToListAsync();

        var result = channels.Select(c =>
        {
            var other = c.DmUser1Id == UserId ? c.DmUser2! : c.DmUser1!;
            var otherDto = new UserDto(other.Id, other.UserName!, other.DisplayName, other.AvatarUrl, other.Status, other.Bio);
            return new DmChannelDto(c.Id, otherDto, c.LastMessageAt, c.LastMessageAt ?? DateTime.UtcNow);
        }).ToList();

        return Ok(result);
    }

    // TODO: this is wildly inefficient.
    // TODO: also allows for searching by user id which is dumb
    // TODO: ALSO allows searching for literally anyone, which is a privacy issue
    // TODO: Probably should add a friend system or at least only search for users who share a server with you.
    [HttpGet("search")]
    public async Task<ActionResult<List<UserDto>>> SearchUsers([FromQuery] string q)
    {
        if (string.IsNullOrWhiteSpace(q) || q.Length < 1) return Ok(new List<UserDto>());

        var users = await _db.Users
            .Where(u => u.Id != UserId && (u.DisplayName.ToLower().Contains(q.ToLower()) || u.UserName!.ToLower().Contains(q.ToLower())))
            .Take(10)
            .Select(u => new UserDto(u.Id, u.UserName!, u.DisplayName, u.AvatarUrl, u.Status, u.Bio))
            .ToListAsync();

        return Ok(users);
    }

    [HttpPost("{userId}")]
    public async Task<ActionResult<DmChannelDto>> CreateOrGetDm(string userId)
    {
        if (userId == UserId) return BadRequest("Cannot DM yourself");

        var otherUser = await _db.Users.FindAsync(userId);
        if (otherUser == null) return NotFound("User not found");

        // Sort user IDs for uniqueness
        var user1Id = string.Compare(UserId, userId, StringComparison.Ordinal) < 0 ? UserId : userId;
        var user2Id = string.Compare(UserId, userId, StringComparison.Ordinal) < 0 ? userId : UserId;

        // Check if DM channel already exists
        var existing = await _db.Channels
            .Include(c => c.DmUser1)
            .Include(c => c.DmUser2)
            .FirstOrDefaultAsync(c => c.Type == ChannelType.DM && c.DmUser1Id == user1Id && c.DmUser2Id == user2Id);

        if (existing != null)
        {
            var existingOther = existing.DmUser1Id == UserId ? existing.DmUser2! : existing.DmUser1!;
            var existingOtherDto = new UserDto(existingOther.Id, existingOther.UserName!, existingOther.DisplayName, existingOther.AvatarUrl, existingOther.Status, existingOther.Bio);
            return Ok(new DmChannelDto(existing.Id, existingOtherDto, existing.LastMessageAt, existing.LastMessageAt ?? DateTime.UtcNow));
        }

        // Create new DM channel
        var channel = new Channel
        {
            Id = Guid.NewGuid(),
            Type = ChannelType.DM,
            DmUser1Id = user1Id,
            DmUser2Id = user2Id,
        };
        _db.Channels.Add(channel);
        await _db.SaveChangesAsync();

        // Add both users' connections to the channel group
        var connectionIds = ChatHub._connections
            .Where(c => c.Value == UserId || c.Value == userId)
            .Select(c => c.Key)
            .ToList();
        foreach (var connId in connectionIds)
        {
            await _hub.Groups.AddToGroupAsync(connId, $"channel:{channel.Id}");
        }

        var currentUser = await _db.Users.FindAsync(UserId);
        var otherDto = new UserDto(otherUser.Id, otherUser.UserName!, otherUser.DisplayName, otherUser.AvatarUrl, otherUser.Status, otherUser.Bio);
        var currentDto = new UserDto(currentUser!.Id, currentUser.UserName!, currentUser.DisplayName, currentUser.AvatarUrl, currentUser.Status, currentUser.Bio);

        var dmDto = new DmChannelDto(channel.Id, otherDto, null, DateTime.UtcNow);

        // Notify the other user about the new DM channel
        var recipientDmDto = new DmChannelDto(channel.Id, currentDto, null, DateTime.UtcNow);
        await _hub.Clients.Group($"user:{userId}").SendAsync("DmChannelCreated", recipientDmDto);

        return Ok(dmDto);
    }
}
