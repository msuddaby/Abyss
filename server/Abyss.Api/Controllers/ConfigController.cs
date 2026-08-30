using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/config")]
[AllowAnonymous]
public class ConfigController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly MediaConfig _mediaConfig;
    private const string MaxMessageLengthKey = "MaxMessageLength";
    private const string ForceRelayModeKey = "ForceRelayMode";
    private const int DefaultMaxMessageLength = 4000;
    private const int MaxMessageLengthUpperBound = 10000;

    public ConfigController(AppDbContext db, MediaConfig mediaConfig)
    {
        _db = db;
        _mediaConfig = mediaConfig;
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

        var uploadLimits = new UploadLimitsDto(
            new Dictionary<string, long>(_mediaConfig.MaxSizesByCategory),
            _mediaConfig.AllowedExtensions.ToDictionary(
                kvp => kvp.Key.ToLowerInvariant(),
                kvp => kvp.Value.Category),
            _mediaConfig.EmojiMaxSize,
            _mediaConfig.SoundMaxSize,
            _mediaConfig.SoundMaxDurationSeconds,
            _mediaConfig.AvatarMaxSize,
            _mediaConfig.ServerIconMaxSize);

        return Ok(new AppConfigDto(maxMessageLength, forceRelayMode, uploadLimits));
    }
}
