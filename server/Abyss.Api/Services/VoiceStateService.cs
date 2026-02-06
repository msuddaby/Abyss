using System.Collections.Concurrent;

namespace Abyss.Api.Services;

public class VoiceStateService
{
    // channelId -> set of userIds
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, string>> _voiceChannels = new();

    // channelId -> (userId, displayName) of active screen sharer
    private readonly ConcurrentDictionary<Guid, (string UserId, string DisplayName)> _activeSharers = new();

    public void JoinChannel(Guid channelId, string userId, string displayName)
    {
        var users = _voiceChannels.GetOrAdd(channelId, _ => new ConcurrentDictionary<string, string>());
        users[userId] = displayName;
    }

    public void LeaveChannel(Guid channelId, string userId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
        {
            users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);
        }

        // Clear screen share if this user was sharing
        if (_activeSharers.TryGetValue(channelId, out var sharer) && sharer.UserId == userId)
        {
            _activeSharers.TryRemove(channelId, out _);
        }
    }

    public void LeaveAll(string userId)
    {
        foreach (var (channelId, users) in _voiceChannels)
        {
            users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);

            // Clear screen share if this user was sharing
            if (_activeSharers.TryGetValue(channelId, out var sharer) && sharer.UserId == userId)
            {
                _activeSharers.TryRemove(channelId, out _);
            }
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

    public Dictionary<string, string> GetChannelUsers(Guid channelId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
            return new Dictionary<string, string>(users);
        return new Dictionary<string, string>();
    }

    public Dictionary<Guid, Dictionary<string, string>> GetUsersForChannels(IEnumerable<Guid> channelIds)
    {
        var result = new Dictionary<Guid, Dictionary<string, string>>();
        foreach (var channelId in channelIds)
        {
            if (_voiceChannels.TryGetValue(channelId, out var users) && !users.IsEmpty)
            {
                result[channelId] = new Dictionary<string, string>(users);
            }
        }
        return result;
    }

    public void SetScreenSharer(Guid channelId, string userId, string displayName)
    {
        _activeSharers[channelId] = (userId, displayName);
    }

    public void ClearScreenSharer(Guid channelId)
    {
        _activeSharers.TryRemove(channelId, out _);
    }

    public (string UserId, string DisplayName)? GetScreenSharer(Guid channelId)
    {
        if (_activeSharers.TryGetValue(channelId, out var sharer))
            return sharer;
        return null;
    }
}
