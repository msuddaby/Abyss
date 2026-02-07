using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class NotificationsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly NotificationService _notificationService;

    public NotificationsController(AppDbContext db, NotificationService notificationService)
    {
        _db = db;
        _notificationService = notificationService;
    }

    [HttpPost("register-device")]
    public async Task<IActionResult> RegisterDevice([FromBody] RegisterDeviceRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) return Unauthorized();

        // Check if token already exists for this user
        var existingToken = await _db.DevicePushTokens
            .FirstOrDefaultAsync(t => t.UserId == userId && t.Token == request.Token);

        if (existingToken != null)
        {
            // Update the timestamp
            existingToken.CreatedAt = DateTime.UtcNow;
            existingToken.Platform = request.Platform;
            await _db.SaveChangesAsync();
            return Ok(new { message = "Token updated" });
        }

        // Create new token
        var token = new DevicePushToken
        {
            UserId = userId,
            Token = request.Token,
            Platform = request.Platform
        };

        _db.DevicePushTokens.Add(token);
        await _db.SaveChangesAsync();

        return Ok(new { message = "Token registered" });
    }

    [HttpDelete("unregister-device")]
    public async Task<IActionResult> UnregisterDevice([FromBody] UnregisterDeviceRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) return Unauthorized();

        var token = await _db.DevicePushTokens
            .FirstOrDefaultAsync(t => t.UserId == userId && t.Token == request.Token);

        if (token != null)
        {
            _db.DevicePushTokens.Remove(token);
            await _db.SaveChangesAsync();
        }

        return Ok(new { message = "Token unregistered" });
    }

}

public record RegisterDeviceRequest(string Token, string Platform);
public record UnregisterDeviceRequest(string Token);
