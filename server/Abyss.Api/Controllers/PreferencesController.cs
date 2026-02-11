using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/users/preferences")]
[Authorize]
public class PreferencesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;
    private readonly MediaUploadService _media;

    public PreferencesController(AppDbContext db, IHubContext<ChatHub> hub, MediaUploadService media)
    {
        _db = db;
        _hub = hub;
        _media = media;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<UserPreferencesDto>> GetPreferences()
    {
        var prefs = await _db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == UserId);
        if (prefs == null)
        {
            return Ok(new UserPreferencesDto(
                (int)VoiceInputMode.VoiceActivity, false, false, 1.0, true, true, true, null, null, null));
        }

        return Ok(MapToDto(prefs));
    }

    [HttpPatch]
    public async Task<ActionResult<UserPreferencesDto>> UpdatePreferences(UpdateUserPreferencesRequest req)
    {
        var prefs = await _db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == UserId);

        if (prefs == null)
        {
            prefs = new UserPreferences { UserId = UserId };
            _db.UserPreferences.Add(prefs);
        }

        if (req.InputMode.HasValue) prefs.InputMode = (VoiceInputMode)req.InputMode.Value;
        if (req.JoinMuted.HasValue) prefs.JoinMuted = req.JoinMuted.Value;
        if (req.JoinDeafened.HasValue) prefs.JoinDeafened = req.JoinDeafened.Value;
        if (req.InputSensitivity.HasValue) prefs.InputSensitivity = req.InputSensitivity.Value;
        if (req.NoiseSuppression.HasValue) prefs.NoiseSuppression = req.NoiseSuppression.Value;
        if (req.EchoCancellation.HasValue) prefs.EchoCancellation = req.EchoCancellation.Value;
        if (req.AutoGainControl.HasValue) prefs.AutoGainControl = req.AutoGainControl.Value;
        if (req.UiPreferences != null) prefs.UiPreferences = req.UiPreferences;

        await _db.SaveChangesAsync();

        var dto = MapToDto(prefs);

        await _hub.Clients.Group($"user:{UserId}")
            .SendAsync("UserPreferencesChanged", dto);

        return Ok(dto);
    }

    [HttpPost("sounds/{type}")]
    public async Task<ActionResult<UserPreferencesDto>> UploadSound(string type, IFormFile file)
    {
        if (type is not "join" and not "leave")
            return BadRequest("Type must be 'join' or 'leave'");

        var (isValid, error, url) = await _media.StoreSoundAsync(file);
        if (!isValid)
            return BadRequest(error);

        var prefs = await _db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == UserId);
        if (prefs == null)
        {
            prefs = new UserPreferences { UserId = UserId };
            _db.UserPreferences.Add(prefs);
        }

        // Delete old file if exists
        var oldUrl = type == "join" ? prefs.JoinSoundUrl : prefs.LeaveSoundUrl;
        if (oldUrl != null)
            DeleteSoundFile(oldUrl);

        if (type == "join")
            prefs.JoinSoundUrl = url;
        else
            prefs.LeaveSoundUrl = url;

        await _db.SaveChangesAsync();

        var dto = MapToDto(prefs);
        await _hub.Clients.Group($"user:{UserId}").SendAsync("UserPreferencesChanged", dto);
        return Ok(dto);
    }

    [HttpDelete("sounds/{type}")]
    public async Task<ActionResult<UserPreferencesDto>> RemoveSound(string type)
    {
        if (type is not "join" and not "leave")
            return BadRequest("Type must be 'join' or 'leave'");

        var prefs = await _db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == UserId);
        if (prefs == null)
            return Ok(new UserPreferencesDto(
                (int)VoiceInputMode.VoiceActivity, false, false, 1.0, true, true, true, null, null, null));

        var oldUrl = type == "join" ? prefs.JoinSoundUrl : prefs.LeaveSoundUrl;
        if (oldUrl != null)
            DeleteSoundFile(oldUrl);

        if (type == "join")
            prefs.JoinSoundUrl = null;
        else
            prefs.LeaveSoundUrl = null;

        await _db.SaveChangesAsync();

        var dto = MapToDto(prefs);
        await _hub.Clients.Group($"user:{UserId}").SendAsync("UserPreferencesChanged", dto);
        return Ok(dto);
    }

    private static void DeleteSoundFile(string relativeUrl)
    {
        var filePath = Path.Combine(Directory.GetCurrentDirectory(), relativeUrl.TrimStart('/'));
        if (System.IO.File.Exists(filePath))
            System.IO.File.Delete(filePath);
    }

    private static UserPreferencesDto MapToDto(UserPreferences prefs) => new(
        (int)prefs.InputMode, prefs.JoinMuted, prefs.JoinDeafened,
        prefs.InputSensitivity, prefs.NoiseSuppression, prefs.EchoCancellation,
        prefs.AutoGainControl, prefs.UiPreferences, prefs.JoinSoundUrl, prefs.LeaveSoundUrl);
}
