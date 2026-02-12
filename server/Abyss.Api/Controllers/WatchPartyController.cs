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
using Abyss.Api.Services.MediaProviders;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/channels/{channelId}/watch-party")]
[Authorize]
public class WatchPartyController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly WatchPartyService _watchPartyService;
    private readonly VoiceStateService _voiceState;

    public WatchPartyController(
        AppDbContext db,
        PermissionService perms,
        IHubContext<ChatHub> hub,
        WatchPartyService watchPartyService,
        VoiceStateService voiceState)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _watchPartyService = watchPartyService;
        _voiceState = voiceState;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<WatchPartyDto?>> GetWatchParty(Guid channelId)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || !channel.ServerId.HasValue) return NotFound();
        if (!await _perms.IsMemberAsync(channel.ServerId.Value, UserId)) return Forbid();

        var state = _watchPartyService.GetParty(channelId);
        if (state == null) return Ok((WatchPartyDto?)null);

        return Ok(MapToDto(state));
    }

    [HttpPost("start")]
    public async Task<ActionResult<WatchPartyDto>> StartWatchParty(Guid channelId, StartWatchPartyRequest req)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || !channel.ServerId.HasValue) return NotFound();
        var serverId = channel.ServerId.Value;

        if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.Stream)) return Forbid();

        // Must be in voice channel
        if (!_voiceState.IsUserInChannel(channelId, UserId))
            return BadRequest("Must be in voice channel to start a watch party");

        // Can't start if already active
        if (_watchPartyService.IsActive(channelId))
            return BadRequest("A watch party is already active in this channel");

        // Verify the connection exists
        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == req.MediaProviderConnectionId && c.ServerId == serverId);
        if (connection == null) return BadRequest("Invalid media provider connection");

        var id = Guid.NewGuid();
        var state = new WatchPartyState
        {
            Id = id,
            ChannelId = channelId,
            MediaProviderConnectionId = req.MediaProviderConnectionId,
            HostUserId = UserId,
            ProviderItemId = req.ProviderItemId,
            ItemTitle = req.ItemTitle,
            ItemThumbnail = req.ItemThumbnail,
            ItemDurationMs = req.ItemDurationMs,
            CurrentTimeMs = 0,
            IsPlaying = true,
            StartedAt = DateTime.UtcNow,
            ProviderType = connection.ProviderType.ToString()
        };

        _watchPartyService.StartParty(channelId, state);

        // Save to DB for persistence
        var dbEntity = new WatchParty
        {
            Id = id,
            ChannelId = channelId,
            MediaProviderConnectionId = req.MediaProviderConnectionId,
            HostUserId = UserId,
            ProviderItemId = req.ProviderItemId,
            ItemTitle = req.ItemTitle,
            ItemThumbnail = req.ItemThumbnail,
            ItemDurationMs = req.ItemDurationMs,
            IsPlaying = true,
            StartedAt = DateTime.UtcNow
        };
        _db.WatchParties.Add(dbEntity);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.WatchPartyStarted, UserId,
            targetName: req.ItemTitle);

        var dto = MapToDto(state);
        await _hub.Clients.Group($"voice:{channelId}").SendAsync("WatchPartyStarted", dto);
        await _hub.Clients.Group($"server:{serverId}").SendAsync("WatchPartyStartedInChannel",
            channelId.ToString(), req.ItemTitle);

        return Ok(dto);
    }

    [HttpPost("stop")]
    public async Task<IActionResult> StopWatchParty(Guid channelId)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || !channel.ServerId.HasValue) return NotFound();
        var serverId = channel.ServerId.Value;

        var state = _watchPartyService.GetParty(channelId);
        if (state == null) return BadRequest("No active watch party");

        // Must be host or have ManageChannels
        if (state.HostUserId != UserId && !await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageChannels))
            return Forbid();

        _watchPartyService.StopParty(channelId);

        var dbEntity = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelId);
        if (dbEntity != null)
        {
            _db.WatchParties.Remove(dbEntity);
            await _db.SaveChangesAsync();
        }

        await _perms.LogAsync(serverId, AuditAction.WatchPartyStopped, UserId,
            targetName: state.ItemTitle);

        await _hub.Clients.Group($"voice:{channelId}").SendAsync("WatchPartyStopped", channelId.ToString());
        await _hub.Clients.Group($"server:{serverId}").SendAsync("WatchPartyStoppedInChannel", channelId.ToString());

        return NoContent();
    }

    [HttpPost("queue/add")]
    public async Task<IActionResult> AddToQueue(Guid channelId, AddToQueueRequest req)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || !channel.ServerId.HasValue) return NotFound();
        if (!await _perms.IsMemberAsync(channel.ServerId.Value, UserId)) return Forbid();

        var state = _watchPartyService.GetParty(channelId);
        if (state == null) return BadRequest("No active watch party");

        var queueItem = new QueueItemDto(req.ProviderItemId, req.Title, req.Thumbnail, req.DurationMs, UserId);
        state.Queue.Add(queueItem);

        // Persist queue to DB
        await PersistQueue(channelId, state.Queue);

        await _hub.Clients.Group($"voice:{channelId}").SendAsync("QueueUpdated", state.Queue);
        return Ok();
    }

    [HttpPost("queue/remove")]
    public async Task<IActionResult> RemoveFromQueue(Guid channelId, [FromBody] JsonElement body)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || !channel.ServerId.HasValue) return NotFound();

        var state = _watchPartyService.GetParty(channelId);
        if (state == null) return BadRequest("No active watch party");

        // Must be host or have ManageChannels
        if (state.HostUserId != UserId && !await _perms.HasPermissionAsync(channel.ServerId.Value, UserId, Permission.ManageChannels))
            return Forbid();

        if (!body.TryGetProperty("index", out var indexProp)) return BadRequest("Missing index");
        var index = indexProp.GetInt32();

        if (index < 0 || index >= state.Queue.Count) return BadRequest("Invalid index");
        state.Queue.RemoveAt(index);

        await PersistQueue(channelId, state.Queue);

        await _hub.Clients.Group($"voice:{channelId}").SendAsync("QueueUpdated", state.Queue);
        return Ok();
    }

    [HttpPost("queue/reorder")]
    public async Task<IActionResult> ReorderQueue(Guid channelId, ReorderQueueRequest req)
    {
        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null || !channel.ServerId.HasValue) return NotFound();

        var state = _watchPartyService.GetParty(channelId);
        if (state == null) return BadRequest("No active watch party");

        if (state.HostUserId != UserId && !await _perms.HasPermissionAsync(channel.ServerId.Value, UserId, Permission.ManageChannels))
            return Forbid();

        if (req.NewOrder.Count != state.Queue.Count) return BadRequest("Invalid order length");

        var reordered = req.NewOrder.Select(i => state.Queue[i]).ToList();
        state.Queue = reordered;
        _watchPartyService.UpdateQueue(channelId, reordered);

        await PersistQueue(channelId, reordered);

        await _hub.Clients.Group($"voice:{channelId}").SendAsync("QueueUpdated", reordered);
        return Ok();
    }

    private async Task PersistQueue(Guid channelId, List<QueueItemDto> queue)
    {
        var dbEntity = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelId);
        if (dbEntity != null)
        {
            dbEntity.QueueJson = JsonSerializer.Serialize(queue);
            await _db.SaveChangesAsync();
        }
    }

    private static WatchPartyDto MapToDto(WatchPartyState state) => new(
        state.Id, state.ChannelId, state.MediaProviderConnectionId,
        state.HostUserId, state.ProviderItemId, state.ItemTitle,
        state.ItemThumbnail, state.ItemDurationMs, state.CurrentTimeMs,
        state.IsPlaying, state.LastSyncAt, state.Queue, state.StartedAt,
        state.ProviderType);
}
