using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/config")]
[AllowAnonymous]
public class ConfigController : ControllerBase
{
    private readonly AppDbContext _db;
    private const string MaxMessageLengthKey = "MaxMessageLength";
    private const string ForceRelayModeKey = "ForceRelayMode";
    private const int DefaultMaxMessageLength = 4000;
    private const int MaxMessageLengthUpperBound = 10000;

    public ConfigController(AppDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<ActionResult<AppConfigDto>> Get()
    {
        var rows = await _db.AppConfigs.AsNoTracking()
            .Where(c => c.Key == MaxMessageLengthKey || c.Key == ForceRelayModeKey)
            .ToListAsync();

        var msgRow = rows.FirstOrDefault(r => r.Key == MaxMessageLengthKey);
        var maxMessageLength = msgRow == null || string.IsNullOrWhiteSpace(msgRow.Value)
            ? DefaultMaxMessageLength
            : (int.TryParse(msgRow.Value, out var value)
                ? Math.Clamp(value, 1, MaxMessageLengthUpperBound)
                : DefaultMaxMessageLength);

        var relayRow = rows.FirstOrDefault(r => r.Key == ForceRelayModeKey);
        var forceRelayMode = relayRow != null && bool.TryParse(relayRow.Value, out var relay) && relay;

        return Ok(new AppConfigDto(maxMessageLength, forceRelayMode));
    }
}
