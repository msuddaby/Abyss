using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/voice")]
[Authorize]
public class VoiceController : ControllerBase
{
    private readonly TurnCredentialService _turn;
    private readonly LiveKitService _livekit;
    private readonly PermissionService _perms;
    private readonly AppDbContext _db;

    public VoiceController(
        TurnCredentialService turn,
        LiveKitService livekit,
        PermissionService perms,
        AppDbContext db)
    {
        _turn = turn;
        _livekit = livekit;
        _perms = perms;
        _db = db;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet("turn")]
    public ActionResult<TurnCredentialResult> GetTurnCredentials()
    {
        var creds = _turn.Issue(UserId);
        return Ok(creds);
    }

    [HttpPost("livekit-token")]
    public async Task<IActionResult> GetLivekitToken([FromBody] LiveKitTokenRequest request)
    {
        if (!_livekit.IsConfigured)
            return StatusCode(501, "LiveKit relay is not configured on this server");

        var channel = await _db.Channels.FindAsync(request.ChannelId);
        if (channel == null)
            return NotFound("Channel not found");

        if (!await _perms.HasChannelPermissionAsync(request.ChannelId, UserId, Permission.Connect))
            return Forbid();

        var user = await _db.Users.FindAsync(UserId);
        if (user == null)
            return NotFound("User not found");

        var token = _livekit.GenerateToken(
            UserId,
            user.DisplayName,
            request.ChannelId.ToString(),
            canPublish: true
        );

        return Ok(new LiveKitTokenResponse
        {
            Token = token,
            Url = _livekit.GetLiveKitUrl(),
        });
    }
}

public class LiveKitTokenRequest
{
    public Guid ChannelId { get; set; }
}

public class LiveKitTokenResponse
{
    public string Token { get; set; } = "";
    public string Url { get; set; } = "";
}
