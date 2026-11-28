using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Hubs;

/// <summary>
/// Studio (collaborative DAW) hub methods. Group: studio:{channelId}.
/// Edits are op batches applied by StudioSessionService in a single order and
/// echoed to the whole group (including the sender, who uses clientBatchId to
/// retire its optimistic copy).
/// </summary>
public partial class ChatHub
{
    private const int MaxPresenceBytes = 4096;

    private async Task<Channel?> GetStudioChannel(string channelId)
    {
        if (!Guid.TryParse(channelId, out var id)) return null;
        var channel = await _db.Channels.FindAsync(id);
        if (channel == null || channel.Type != ChannelType.Studio) return null;
        return await CanAccessChannel(channel) ? channel : null;
    }

    public async Task<object?> JoinStudio(string channelId)
    {
        var channel = await GetStudioChannel(channelId);
        if (channel == null) return null;

        var result = await _studio.JoinAsync(channel.Id, Context.ConnectionId, UserId);
        await Groups.AddToGroupAsync(Context.ConnectionId, $"studio:{channel.Id}");
        await Clients.OthersInGroup($"studio:{channel.Id}").SendAsync("StudioUserJoined", channel.Id.ToString(), UserId);

        var canEdit = await _perms.HasChannelPermissionAsync(channel.Id, UserId, Permission.EditStudio);
        var session = _studio.GetSession(channel.Id);
        var userIds = session?.Connections.Values.Distinct().ToList() ?? new List<string>();

        return new
        {
            doc = result.Doc,
            version = result.Version,
            transport = result.Transport,
            presence = result.Presence,
            users = userIds,
            canEdit,
            serverTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }

    public async Task LeaveStudio(string channelId)
    {
        if (!Guid.TryParse(channelId, out var id)) return;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"studio:{id}");
        if (_studio.Leave(id, Context.ConnectionId))
            await Clients.Group($"studio:{id}").SendAsync("StudioUserLeft", id.ToString(), UserId);
    }

    public async Task<object?> StudioApplyOps(string channelId, string clientBatchId, List<StudioOp> ops)
    {
        if (!Guid.TryParse(channelId, out var id) || ops == null) return null;
        if (clientBatchId == null || clientBatchId.Length > 64) return null;
        var session = _studio.GetSession(id);
        if (session == null || !session.Connections.ContainsKey(Context.ConnectionId)) return null;
        if (!await _perms.HasChannelPermissionAsync(id, UserId, Permission.EditStudio)) return null;

        // Apply and broadcast under one gate: concurrent invocations from
        // different connections must reach clients in version order.
        await session.BroadcastGate.WaitAsync();
        try
        {
            var applied = _studio.ApplyBatch(id, ops, UserId);
            if (applied == null) return new { version = session.Version, accepted = 0 };

            var (version, accepted) = applied.Value;
            await Clients.Group($"studio:{id}").SendAsync("StudioOps", new
            {
                channelId = id.ToString(),
                version,
                userId = UserId,
                clientBatchId,
                ops = accepted,
            });
            return new { version, accepted = accepted.Count };
        }
        finally
        {
            session.BroadcastGate.Release();
        }
    }

    public async Task StudioPresence(string channelId, JsonElement presence)
    {
        if (!Guid.TryParse(channelId, out var id)) return;
        if (presence.ValueKind != JsonValueKind.Object || presence.GetRawText().Length > MaxPresenceBytes) return;
        var session = _studio.GetSession(id);
        if (session == null || !session.Connections.ContainsKey(Context.ConnectionId)) return;

        _studio.SetPresence(id, UserId, presence);
        await Clients.OthersInGroup($"studio:{id}").SendAsync("StudioPresence", id.ToString(), UserId, presence);
    }

    public async Task StudioTransport(string channelId, bool isPlaying, double positionBeats)
    {
        if (!Guid.TryParse(channelId, out var id) || double.IsNaN(positionBeats) || double.IsInfinity(positionBeats)) return;
        var session = _studio.GetSession(id);
        if (session == null || !session.Connections.ContainsKey(Context.ConnectionId)) return;

        var state = _studio.SetTransport(id, isPlaying, positionBeats, UserId);
        await Clients.OthersInGroup($"studio:{id}").SendAsync("StudioTransportChanged", id.ToString(), state);
    }

    // ───────────── Voice channel ↔ studio activity ─────────────

    public async Task OpenStudioInVoice(string voiceChannelId, string studioChannelId)
    {
        if (!Guid.TryParse(voiceChannelId, out var voiceId)) return;
        if (_voiceState.GetUserChannel(UserId) != voiceId) return;

        var studio = await GetStudioChannel(studioChannelId);
        var voice = await _db.Channels.FindAsync(voiceId);
        if (studio == null || voice == null || voice.Type != ChannelType.Voice || voice.ServerId != studio.ServerId) return;

        _studio.LinkVoice(voiceId, studio.Id);
        await Clients.Group($"voice:{voiceId}").SendAsync("VoiceStudioOpened", voiceId.ToString(), studio.Id.ToString(), UserId);
        await Clients.Group($"server:{voice.ServerId}").SendAsync("VoiceStudioLinkChanged", voiceId.ToString(), studio.Id.ToString());
    }

    public async Task CloseStudioInVoice(string voiceChannelId)
    {
        if (!Guid.TryParse(voiceChannelId, out var voiceId)) return;
        if (_voiceState.GetUserChannel(UserId) != voiceId) return;
        await CloseVoiceStudioLink(voiceId);
    }

    public async Task<Dictionary<Guid, Guid>> GetServerVoiceStudios(string serverId)
    {
        if (!Guid.TryParse(serverId, out var serverGuid)) return new();
        if (!await _perms.IsMemberAsync(serverGuid, UserId)) return new();
        var voiceIds = await _db.Channels
            .Where(c => c.ServerId == serverGuid && c.Type == ChannelType.Voice)
            .Select(c => c.Id)
            .ToListAsync();
        return _studio.GetVoiceLinks(voiceIds);
    }

    private async Task CloseVoiceStudioLink(Guid voiceId)
    {
        if (!_studio.UnlinkVoice(voiceId)) return;
        await Clients.Group($"voice:{voiceId}").SendAsync("VoiceStudioClosed", voiceId.ToString());
        var voice = await _db.Channels.FindAsync(voiceId);
        if (voice?.ServerId != null)
            await Clients.Group($"server:{voice.ServerId}").SendAsync("VoiceStudioLinkChanged", voiceId.ToString(), null);
    }

    private async Task HandleStudioDisconnect()
    {
        foreach (var (channelId, userId) in _studio.LeaveAll(Context.ConnectionId))
            await Clients.Group($"studio:{channelId}").SendAsync("StudioUserLeft", channelId.ToString(), userId);
    }
}
