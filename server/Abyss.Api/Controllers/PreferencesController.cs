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
[Route("api/users/preferences")]
[Authorize]
public class PreferencesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;

    public PreferencesController(AppDbContext db, IHubContext<ChatHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<UserPreferencesDto>> GetPreferences()
    {
        var prefs = await _db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == UserId);
        if (prefs == null)
        {
            return Ok(new UserPreferencesDto(
                (int)VoiceInputMode.VoiceActivity, false, false, 1.0, true, true, true, null));
        }

        return Ok(new UserPreferencesDto(
            (int)prefs.InputMode, prefs.JoinMuted, prefs.JoinDeafened,
            prefs.InputSensitivity, prefs.NoiseSuppression, prefs.EchoCancellation,
            prefs.AutoGainControl, prefs.UiPreferences));
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

        var dto = new UserPreferencesDto(
            (int)prefs.InputMode, prefs.JoinMuted, prefs.JoinDeafened,
            prefs.InputSensitivity, prefs.NoiseSuppression, prefs.EchoCancellation,
            prefs.AutoGainControl, prefs.UiPreferences);

        await _hub.Clients.Group($"user:{UserId}")
            .SendAsync("UserPreferencesChanged", dto);

        return Ok(dto);
    }
}
