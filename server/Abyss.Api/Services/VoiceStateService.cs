using System.Collections.Concurrent;

namespace Abyss.Api.Services;

public class VoiceStateService
{
    // channelId -> set of userIds
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, string>> _voiceChannels = new();

    // channelId -> {userId -> displayName} of active screen sharers
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, string>> _activeSharers = new();

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
