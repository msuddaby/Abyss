using System.Security.Claims;
using System.Text.Json;
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
[Route("api/servers/{serverId}")]
[Authorize]
public class NotificationSettingsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;

    public NotificationSettingsController(AppDbContext db, PermissionService perms, IHubContext<ChatHub> hub)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet("notification-settings")]
    public async Task<ActionResult<UserNotificationOverviewDto>> GetNotificationSettings(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var serverSetting = await _db.UserServerNotificationSettings
            .FirstOrDefaultAsync(s => s.ServerId == serverId && s.UserId == UserId);

        var channelSettings = await _db.UserChannelNotificationSettings
            .Where(s => s.UserId == UserId && s.Channel.ServerId == serverId)
            .ToDictionaryAsync(
                s => s.ChannelId,
                s => new ChannelNotificationSettingsDto((int?)s.NotificationLevel, s.MuteUntil));

        var serverDto = serverSetting != null
            ? new ServerNotificationSettingsDto((int?)serverSetting.NotificationLevel, serverSetting.MuteUntil, serverSetting.SuppressEveryone)
            : new ServerNotificationSettingsDto(null, null, false);

        return Ok(new UserNotificationOverviewDto(serverDto, channelSettings));
    }

    [HttpPatch("notification-settings")]
    public async Task<ActionResult<ServerNotificationSettingsDto>> UpdateServerNotificationSettings(
        Guid serverId, [FromBody] JsonElement req)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var setting = await _db.UserServerNotificationSettings
            .FirstOrDefaultAsync(s => s.ServerId == serverId && s.UserId == UserId);

        if (setting == null)
        {
            setting = new UserServerNotificationSetting { ServerId = serverId, UserId = UserId };
            _db.UserServerNotificationSettings.Add(setting);
        }

        if (TryGetProperty(req, "notificationLevel", out var notificationLevelValue))
        {
            if (notificationLevelValue.ValueKind == JsonValueKind.Null)
            {
                setting.NotificationLevel = null;
            }
            else if (notificationLevelValue.ValueKind == JsonValueKind.Number &&
                     notificationLevelValue.TryGetInt32(out var notificationLevelInt) &&
                     Enum.IsDefined(typeof(NotificationLevel), notificationLevelInt))
            {
                setting.NotificationLevel = (NotificationLevel)notificationLevelInt;
            }
            else
            {
                return BadRequest("Invalid notificationLevel");
            }
        }

        if (TryGetProperty(req, "muteUntil", out var muteUntilValue))
        {
            if (muteUntilValue.ValueKind == JsonValueKind.Null)
            {
                setting.MuteUntil = null;
            }
            else if (muteUntilValue.ValueKind == JsonValueKind.String &&
                     muteUntilValue.TryGetDateTime(out var muteUntil))
            {
                setting.MuteUntil = muteUntil;
            }
            else
            {
                return BadRequest("Invalid muteUntil");
            }
        }

        if (TryGetProperty(req, "suppressEveryone", out var suppressEveryoneValue))
        {
            if (suppressEveryoneValue.ValueKind == JsonValueKind.True || suppressEveryoneValue.ValueKind == JsonValueKind.False)
            {
                setting.SuppressEveryone = suppressEveryoneValue.GetBoolean();
            }
            else if (suppressEveryoneValue.ValueKind == JsonValueKind.Null)
            {
                setting.SuppressEveryone = false;
            }
            else
            {
                return BadRequest("Invalid suppressEveryone");
            }
        }

        await _db.SaveChangesAsync();

        var dto = new ServerNotificationSettingsDto(
            (int?)setting.NotificationLevel, setting.MuteUntil, setting.SuppressEveryone);

        await _hub.Clients.Group($"user:{UserId}")
            .SendAsync("NotificationSettingsChanged", serverId.ToString(), dto);

        return Ok(dto);
    }

    [HttpPatch("channels/{channelId}/notification-settings")]
    public async Task<ActionResult<ChannelNotificationSettingsDto>> UpdateChannelNotificationSettings(
        Guid serverId, Guid channelId, [FromBody] JsonElement req)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ServerId == serverId);
        if (channel == null) return NotFound();

        var setting = await _db.UserChannelNotificationSettings
            .FirstOrDefaultAsync(s => s.ChannelId == channelId && s.UserId == UserId);

        if (setting == null)
        {
            setting = new UserChannelNotificationSetting { ChannelId = channelId, UserId = UserId };
            _db.UserChannelNotificationSettings.Add(setting);
        }

        if (TryGetProperty(req, "notificationLevel", out var notificationLevelValue))
        {
            if (notificationLevelValue.ValueKind == JsonValueKind.Null)
            {
                setting.NotificationLevel = null;
            }
            else if (notificationLevelValue.ValueKind == JsonValueKind.Number &&
                     notificationLevelValue.TryGetInt32(out var notificationLevelInt) &&
                     Enum.IsDefined(typeof(NotificationLevel), notificationLevelInt))
            {
                setting.NotificationLevel = (NotificationLevel)notificationLevelInt;
            }
            else
            {
                return BadRequest("Invalid notificationLevel");
            }
        }

        if (TryGetProperty(req, "muteUntil", out var muteUntilValue))
        {
            if (muteUntilValue.ValueKind == JsonValueKind.Null)
            {
                setting.MuteUntil = null;
            }
            else if (muteUntilValue.ValueKind == JsonValueKind.String &&
                     muteUntilValue.TryGetDateTime(out var muteUntil))
            {
                setting.MuteUntil = muteUntil;
            }
            else
            {
                return BadRequest("Invalid muteUntil");
            }
        }

        await _db.SaveChangesAsync();

        var dto = new ChannelNotificationSettingsDto(
            (int?)setting.NotificationLevel, setting.MuteUntil);

        return Ok(dto);
    }

    [HttpPatch("default-notification-level")]
    public async Task<IActionResult> UpdateDefaultNotificationLevel(
        Guid serverId, [FromBody] int level)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageServer)) return Forbid();

        var server = await _db.Servers.FindAsync(serverId);
        if (server == null) return NotFound();

        server.DefaultNotificationLevel = (NotificationLevel)level;
        await _db.SaveChangesAsync();

        await _hub.Clients.Group($"server:{serverId}")
            .SendAsync("ServerDefaultNotificationLevelChanged", serverId.ToString(), level);

        return Ok();
    }

    private static bool TryGetProperty(JsonElement req, string propertyName, out JsonElement value)
    {
        if (req.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in req.EnumerateObject())
            {
                if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    return true;
                }
            }
        }

        value = default;
        return false;
    }
}
