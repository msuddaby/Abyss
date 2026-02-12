using System.Collections.Concurrent;
using System.Text.Json;
using Abyss.Api.DTOs;

namespace Abyss.Api.Services;

public class WatchPartyState
{
    public Guid Id { get; set; }
    public Guid ChannelId { get; set; }
    public Guid MediaProviderConnectionId { get; set; }
    public string HostUserId { get; set; } = string.Empty;
    public string ProviderItemId { get; set; } = string.Empty;
    public string ItemTitle { get; set; } = string.Empty;
    public string? ItemThumbnail { get; set; }
    public long? ItemDurationMs { get; set; }
    public double CurrentTimeMs { get; set; }
    public bool IsPlaying { get; set; }
    public DateTime LastSyncAt { get; set; } = DateTime.UtcNow;
    public List<QueueItemDto> Queue { get; set; } = new();
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public string? ProviderType { get; set; }
    public string? PlaybackUrl { get; set; }
}

public class WatchPartyService
{
    private readonly ConcurrentDictionary<Guid, WatchPartyState> _activeParties = new(); // channelId -> state

    public WatchPartyState? StartParty(Guid channelId, WatchPartyState state)
    {
        state.ChannelId = channelId;
        _activeParties[channelId] = state;
        return state;
    }

    public bool StopParty(Guid channelId)
    {
        return _activeParties.TryRemove(channelId, out _);
    }

    public WatchPartyState? GetParty(Guid channelId)
    {
        _activeParties.TryGetValue(channelId, out var state);
        return state;
    }

    public bool IsActive(Guid channelId)
    {
        return _activeParties.ContainsKey(channelId);
    }

    public void UpdatePlaybackState(Guid channelId, double timeMs, bool isPlaying)
    {
        if (_activeParties.TryGetValue(channelId, out var state))
        {
            state.CurrentTimeMs = timeMs;
            state.IsPlaying = isPlaying;
            state.LastSyncAt = DateTime.UtcNow;
        }
    }

    public void TransferHost(Guid channelId, string newHostUserId)
    {
        if (_activeParties.TryGetValue(channelId, out var state))
        {
            state.HostUserId = newHostUserId;
        }
    }

    public Dictionary<Guid, string> GetServerWatchParties(IEnumerable<Guid> channelIds)
    {
        var result = new Dictionary<Guid, string>();
        foreach (var channelId in channelIds)
        {
            if (_activeParties.TryGetValue(channelId, out var state))
            {
                result[channelId] = state.ItemTitle;
            }
        }
        return result;
    }

    public void UpdateQueue(Guid channelId, List<QueueItemDto> queue)
    {
        if (_activeParties.TryGetValue(channelId, out var state))
        {
            state.Queue = queue;
        }
    }

    public void UpdateItem(Guid channelId, string providerItemId, string itemTitle, string? itemThumbnail, long? itemDurationMs)
    {
        if (_activeParties.TryGetValue(channelId, out var state))
        {
            state.ProviderItemId = providerItemId;
            state.ItemTitle = itemTitle;
            state.ItemThumbnail = itemThumbnail;
            state.ItemDurationMs = itemDurationMs;
            state.CurrentTimeMs = 0;
            state.IsPlaying = true;
            state.LastSyncAt = DateTime.UtcNow;
        }
    }
}
