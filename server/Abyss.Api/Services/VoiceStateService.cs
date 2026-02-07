using System.Collections.Concurrent;
using System.Linq;
using Abyss.Api.DTOs;

namespace Abyss.Api.Services;

public class VoiceStateService
{
    private sealed class VoiceUserState
    {
        public string DisplayName { get; set; } = "";
        public bool IsMuted { get; set; }
        public bool IsDeafened { get; set; }
        public bool IsServerMuted { get; set; }
        public bool IsServerDeafened { get; set; }
    }

    // channelId -> {userId -> VoiceUserState}
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, VoiceUserState>> _voiceChannels = new();

    // channelId -> {userId -> displayName} of active screen sharers
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, string>> _activeSharers = new();

    public void JoinChannel(Guid channelId, string userId, string displayName, bool isMuted, bool isDeafened)
    {
        var users = _voiceChannels.GetOrAdd(channelId, _ => new ConcurrentDictionary<string, VoiceUserState>());
        users[userId] = new VoiceUserState
        {
            DisplayName = displayName,
            IsMuted = isMuted,
            IsDeafened = isDeafened,
            IsServerMuted = false,
            IsServerDeafened = false,
        };
    }

    public void LeaveChannel(Guid channelId, string userId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
        {
            users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);
        }

        // Remove this user from screen sharers if they were sharing
        RemoveScreenSharer(channelId, userId);
    }

    public void LeaveAll(string userId)
    {
        foreach (var (channelId, users) in _voiceChannels)
        {
            users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);

            // Remove this user from screen sharers if they were sharing
            RemoveScreenSharer(channelId, userId);
        }
    }

    public Guid? GetUserChannel(string userId)
    {
        foreach (var (channelId, users) in _voiceChannels)
        {
            if (users.ContainsKey(userId))
                return channelId;
        }
        return null;
    }

    public Dictionary<string, string> GetChannelUsersDisplayNames(Guid channelId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
            return users.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.DisplayName);
        return new Dictionary<string, string>();
    }

    public Dictionary<Guid, Dictionary<string, VoiceUserStateDto>> GetUsersForChannels(IEnumerable<Guid> channelIds)
    {
        var result = new Dictionary<Guid, Dictionary<string, VoiceUserStateDto>>();
        foreach (var channelId in channelIds)
        {
            if (_voiceChannels.TryGetValue(channelId, out var users) && !users.IsEmpty)
            {
                result[channelId] = users.ToDictionary(
                    kvp => kvp.Key,
                    kvp => new VoiceUserStateDto(
                        kvp.Value.DisplayName,
                        kvp.Value.IsMuted,
                        kvp.Value.IsDeafened,
                        kvp.Value.IsServerMuted,
                        kvp.Value.IsServerDeafened
                    )
                );
            }
        }
        return result;
    }

    public VoiceUserStateDto? UpdateUserState(
        Guid channelId,
        string userId,
        bool isMuted,
        bool isDeafened,
        bool? serverMuted = null,
        bool? serverDeafened = null)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users) && users.TryGetValue(userId, out var state))
        {
            if (serverMuted.HasValue) state.IsServerMuted = serverMuted.Value;
            if (serverDeafened.HasValue) state.IsServerDeafened = serverDeafened.Value;

            state.IsMuted = state.IsServerMuted || isMuted;
            state.IsDeafened = state.IsServerDeafened || isDeafened;

            return new VoiceUserStateDto(
                state.DisplayName,
                state.IsMuted,
                state.IsDeafened,
                state.IsServerMuted,
                state.IsServerDeafened
            );
        }
        return null;
    }

    public void AddScreenSharer(Guid channelId, string userId, string displayName)
    {
        var sharers = _activeSharers.GetOrAdd(channelId, _ => new ConcurrentDictionary<string, string>());
        sharers[userId] = displayName;
    }

    public bool RemoveScreenSharer(Guid channelId, string userId)
    {
        if (_activeSharers.TryGetValue(channelId, out var sharers))
        {
            var removed = sharers.TryRemove(userId, out _);
            if (sharers.IsEmpty)
                _activeSharers.TryRemove(channelId, out _);
            return removed;
        }
        return false;
    }

    public Dictionary<string, string> GetScreenSharers(Guid channelId)
    {
        if (_activeSharers.TryGetValue(channelId, out var sharers))
            return new Dictionary<string, string>(sharers);
        return new Dictionary<string, string>();
    }

    public bool IsScreenSharing(Guid channelId, string userId)
    {
        if (_activeSharers.TryGetValue(channelId, out var sharers))
            return sharers.ContainsKey(userId);
        return false;
    }

    public Dictionary<Guid, HashSet<string>> GetSharersForChannels(IEnumerable<Guid> channelIds)
    {
        var result = new Dictionary<Guid, HashSet<string>>();
        foreach (var channelId in channelIds)
        {
            if (_activeSharers.TryGetValue(channelId, out var sharers) && !sharers.IsEmpty)
            {
                result[channelId] = new HashSet<string>(sharers.Keys);
            }
        }
        return result;
    }
}
