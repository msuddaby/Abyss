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
    private const int DefaultMaxMessageLength = 4000;
    private const int MaxMessageLengthUpperBound = 10000;

    public ConfigController(AppDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<ActionResult<AppConfigDto>> Get()
    {
        var row = await _db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(c => c.Key == MaxMessageLengthKey);
        var maxMessageLength = row == null || string.IsNullOrWhiteSpace(row.Value)
            ? DefaultMaxMessageLength
            : (int.TryParse(row.Value, out var value)
                ? Math.Clamp(value, 1, MaxMessageLengthUpperBound)
                : DefaultMaxMessageLength);

        return Ok(new AppConfigDto(maxMessageLength));
    }
}
