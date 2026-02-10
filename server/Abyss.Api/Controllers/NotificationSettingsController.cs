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
        Guid serverId, UpdateServerNotificationSettingsRequest req)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var setting = await _db.UserServerNotificationSettings
            .FirstOrDefaultAsync(s => s.ServerId == serverId && s.UserId == UserId);

        if (setting == null)
        {
            setting = new UserServerNotificationSetting { ServerId = serverId, UserId = UserId };
            _db.UserServerNotificationSettings.Add(setting);
        }

        if (req.NotificationLevel.HasValue)
            setting.NotificationLevel = (NotificationLevel)req.NotificationLevel.Value;
        if (req.MuteUntil.HasValue)
            setting.MuteUntil = req.MuteUntil.Value;
        if (req.SuppressEveryone.HasValue)
            setting.SuppressEveryone = req.SuppressEveryone.Value;

        await _db.SaveChangesAsync();

        var dto = new ServerNotificationSettingsDto(
            (int?)setting.NotificationLevel, setting.MuteUntil, setting.SuppressEveryone);

        await _hub.Clients.Group($"user:{UserId}")
            .SendAsync("NotificationSettingsChanged", serverId.ToString(), dto);

        return Ok(dto);
    }

    [HttpPatch("channels/{channelId}/notification-settings")]
    public async Task<ActionResult<ChannelNotificationSettingsDto>> UpdateChannelNotificationSettings(
        Guid serverId, Guid channelId, UpdateChannelNotificationSettingsRequest req)
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

        if (req.NotificationLevel.HasValue)
            setting.NotificationLevel = (NotificationLevel)req.NotificationLevel.Value;
        if (req.MuteUntil.HasValue)
            setting.MuteUntil = req.MuteUntil.Value;

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
}
