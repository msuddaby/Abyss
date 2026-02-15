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
public class FriendsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;

    public FriendsController(AppDbContext db, IHubContext<ChatHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private static UserDto ToUserDto(AppUser u) =>
        new(u.Id, u.UserName!, u.DisplayName, u.AvatarUrl, u.Status, u.Bio, u.PresenceStatus);

    [HttpGet]
    public async Task<ActionResult<List<FriendshipDto>>> GetFriends()
    {
        var friendships = await _db.Friendships
            .Include(f => f.Requester)
            .Include(f => f.Addressee)
            .Where(f => f.Status == FriendshipStatus.Accepted && (f.RequesterId == UserId || f.AddresseeId == UserId))
            .OrderByDescending(f => f.AcceptedAt)
            .ToListAsync();

        var result = friendships.Select(f =>
        {
            var other = f.RequesterId == UserId ? f.Addressee! : f.Requester!;
            return new FriendshipDto(f.Id, ToUserDto(other), f.Status.ToString(), f.CreatedAt, f.AcceptedAt);
        }).ToList();

        return Ok(result);
    }

    [HttpGet("requests")]
    public async Task<ActionResult<List<FriendRequestDto>>> GetRequests()
    {
        var requests = await _db.Friendships
            .Include(f => f.Requester)
            .Include(f => f.Addressee)
            .Where(f => f.Status == FriendshipStatus.Pending && (f.RequesterId == UserId || f.AddresseeId == UserId))
            .OrderByDescending(f => f.CreatedAt)
            .ToListAsync();

        var result = requests.Select(f =>
        {
            var isOutgoing = f.RequesterId == UserId;
            var other = isOutgoing ? f.Addressee! : f.Requester!;
            return new FriendRequestDto(f.Id, ToUserDto(other), isOutgoing, f.CreatedAt);
        }).ToList();

        return Ok(result);
    }

    [HttpPost("request/{userId}")]
    public async Task<IActionResult> SendRequest(string userId)
    {
        if (userId == UserId) return BadRequest("Cannot friend yourself");

        var targetUser = await _db.Users.FindAsync(userId);
        if (targetUser == null) return NotFound("User not found");

        // Check both directions for existing relationship
        var existing = await _db.Friendships
            .FirstOrDefaultAsync(f =>
                (f.RequesterId == UserId && f.AddresseeId == userId) ||
                (f.RequesterId == userId && f.AddresseeId == UserId));

        if (existing != null)
        {
            if (existing.Status == FriendshipStatus.Accepted)
                return BadRequest("Already friends");
            if (existing.Status == FriendshipStatus.Pending)
                return BadRequest("Friend request already pending");

            // Declined — reset to Pending with current user as requester
            existing.RequesterId = UserId;
            existing.AddresseeId = userId;
            existing.Status = FriendshipStatus.Pending;
            existing.CreatedAt = DateTime.UtcNow;
            existing.AcceptedAt = null;
            await _db.SaveChangesAsync();

            var currentUser = await _db.Users.FindAsync(UserId);
            var requestDto = new FriendRequestDto(existing.Id, ToUserDto(currentUser!), false, existing.CreatedAt);
            await _hub.Clients.Group($"user:{userId}").SendAsync("FriendRequestReceived", requestDto);

            return Ok();
        }

        var friendship = new Friendship
        {
            Id = Guid.NewGuid(),
            RequesterId = UserId,
            AddresseeId = userId,
            Status = FriendshipStatus.Pending,
            CreatedAt = DateTime.UtcNow,
        };
        _db.Friendships.Add(friendship);
        await _db.SaveChangesAsync();

        var requester = await _db.Users.FindAsync(UserId);
        var reqDto = new FriendRequestDto(friendship.Id, ToUserDto(requester!), false, friendship.CreatedAt);
        await _hub.Clients.Group($"user:{userId}").SendAsync("FriendRequestReceived", reqDto);

        return Ok();
    }

    [HttpPost("accept/{friendshipId:guid}")]
    public async Task<IActionResult> AcceptRequest(Guid friendshipId)
    {
        var friendship = await _db.Friendships
            .Include(f => f.Requester)
            .Include(f => f.Addressee)
            .FirstOrDefaultAsync(f => f.Id == friendshipId);

        if (friendship == null) return NotFound();
        if (friendship.AddresseeId != UserId) return Forbid();
        if (friendship.Status != FriendshipStatus.Pending) return BadRequest("Request is not pending");

        friendship.Status = FriendshipStatus.Accepted;
        friendship.AcceptedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        // Notify requester
        var addressee = friendship.Addressee!;
        var friendshipDto = new FriendshipDto(friendship.Id, ToUserDto(addressee), "Accepted", friendship.CreatedAt, friendship.AcceptedAt);
        await _hub.Clients.Group($"user:{friendship.RequesterId}").SendAsync("FriendRequestAccepted", friendshipDto);

        return Ok();
    }

    [HttpPost("decline/{friendshipId:guid}")]
    public async Task<IActionResult> DeclineRequest(Guid friendshipId)
    {
        var friendship = await _db.Friendships.FindAsync(friendshipId);
        if (friendship == null) return NotFound();
        if (friendship.AddresseeId != UserId) return Forbid();
        if (friendship.Status != FriendshipStatus.Pending) return BadRequest("Request is not pending");

        friendship.Status = FriendshipStatus.Declined;
        await _db.SaveChangesAsync();

        // Silent — no notification to sender
        return Ok();
    }

    [HttpDelete("{friendshipId:guid}")]
    public async Task<IActionResult> RemoveFriend(Guid friendshipId)
    {
        var friendship = await _db.Friendships.FindAsync(friendshipId);
        if (friendship == null) return NotFound();
        if (friendship.RequesterId != UserId && friendship.AddresseeId != UserId) return Forbid();
        if (friendship.Status != FriendshipStatus.Accepted) return BadRequest("Not friends");

        var otherUserId = friendship.RequesterId == UserId ? friendship.AddresseeId : friendship.RequesterId;

        _db.Friendships.Remove(friendship);
        await _db.SaveChangesAsync();

        await _hub.Clients.Group($"user:{otherUserId}").SendAsync("FriendRemoved", friendshipId);

        return Ok();
    }

    [HttpGet("status/{userId}")]
    public async Task<ActionResult<object>> GetFriendshipStatus(string userId)
    {
        if (userId == UserId) return Ok(new { status = "self" });

        var friendship = await _db.Friendships
            .FirstOrDefaultAsync(f =>
                (f.RequesterId == UserId && f.AddresseeId == userId) ||
                (f.RequesterId == userId && f.AddresseeId == UserId));

        if (friendship == null)
            return Ok(new { status = "none" });

        return Ok(new
        {
            id = friendship.Id,
            status = friendship.Status.ToString().ToLower(),
            isOutgoing = friendship.RequesterId == UserId,
        });
    }
}
