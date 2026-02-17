using System.Collections.Concurrent;

namespace Abyss.Api.Services;

public class HubRateLimiter
{
    private enum Category
    {
        Message, Edit, Reaction, Pin, Typing, Presence,
        VoiceState, Streaming, WatchParty, Soundboard, Query, Navigation
    }

    private readonly record struct Limit(int MaxCount, TimeSpan Window);

    private static readonly Dictionary<Category, Limit> Limits = new()
    {
        [Category.Message]    = new(10,  TimeSpan.FromSeconds(5)),
        [Category.Edit]       = new(20,  TimeSpan.FromSeconds(5)),
        [Category.Reaction]   = new(20,  TimeSpan.FromSeconds(3)),
        [Category.Pin]        = new(20,  TimeSpan.FromSeconds(5)),
        [Category.Typing]     = new(30,  TimeSpan.FromSeconds(10)),
        [Category.Presence]   = new(20,  TimeSpan.FromSeconds(10)),
        [Category.VoiceState] = new(30, TimeSpan.FromSeconds(5)),
        [Category.Streaming]  = new(20, TimeSpan.FromSeconds(5)),
        [Category.WatchParty] = new(20,  TimeSpan.FromSeconds(5)),
        [Category.Soundboard] = new(20,  TimeSpan.FromSeconds(5)),
        [Category.Query]      = new(30, TimeSpan.FromSeconds(10)),
        [Category.Navigation] = new(30, TimeSpan.FromSeconds(5)),
    };

    private static readonly Dictionary<string, Category> MethodCategories = new()
    {
        ["SendMessage"]              = Category.Message,
        ["EditMessage"]              = Category.Edit,
        ["DeleteMessage"]            = Category.Edit,
        ["ToggleReaction"]           = Category.Reaction,
        ["PinMessage"]               = Category.Pin,
        ["UnpinMessage"]             = Category.Pin,
        ["UserTyping"]               = Category.Typing,
        ["ActivityHeartbeat"]        = Category.Presence,
        ["JoinVoiceChannel"]         = Category.VoiceState,
        ["LeaveVoiceChannel"]        = Category.VoiceState,
        ["UpdateVoiceState"]         = Category.VoiceState,
        ["ModerateVoiceState"]       = Category.VoiceState,
        ["NotifyScreenShare"]        = Category.Streaming,
        ["NotifyCamera"]             = Category.Streaming,
        ["NotifyRelayMode"]          = Category.Streaming,
        ["RequestWatchStream"]       = Category.Streaming,
        ["StopWatchingStream"]       = Category.Streaming,
        ["NotifyPlaybackCommand"]    = Category.WatchParty,
        ["RequestSync"]              = Category.WatchParty,
        ["TransferWatchPartyHost"]   = Category.WatchParty,
        ["PlaySoundboardClip"]       = Category.Soundboard,
        ["GetOnlineUsers"]           = Category.Query,
        ["GetServerVoiceUsers"]      = Category.Query,
        ["GetServerVoiceSharers"]    = Category.Query,
        ["GetServerVoiceCameras"]    = Category.Query,
        ["GetVoiceChannelUsers"]     = Category.Query,
        ["GetServerWatchParties"]    = Category.Query,
        ["GetUnreadState"]           = Category.Query,
        ["GetAllServerUnreads"]      = Category.Query,
        ["GetDmChannels"]            = Category.Query,
        ["GetDmUnreads"]             = Category.Query,
        ["MarkChannelRead"]          = Category.Query,
        ["JoinChannel"]              = Category.Navigation,
        ["LeaveChannel"]             = Category.Navigation,
        ["JoinServerGroup"]          = Category.Navigation,
    };

    // Exempt methods that should never be rate-limited
    private static readonly HashSet<string> Exempt = new()
    {
        "Ping", "SendSignal", "VoiceHeartbeat", "ReportPlaybackPosition",
        "OnConnectedAsync", "OnDisconnectedAsync"
    };

    // Silent categories — don't show error toasts (background actions)
    private static readonly HashSet<Category> SilentCategories = new()
    {
        Category.Typing, Category.Presence
    };

    private readonly ConcurrentDictionary<string, SlidingWindow> _windows = new();

    private sealed class SlidingWindow
    {
        private readonly Queue<long> _timestamps = new();
        private readonly object _lock = new();

        /// <summary>
        /// Try to consume a token. Returns null if allowed, or the TimeSpan to wait if rate-limited.
        /// </summary>
        public TimeSpan? TryConsume(int maxCount, TimeSpan window)
        {
            var now = Environment.TickCount64;
            var windowMs = (long)window.TotalMilliseconds;

            lock (_lock)
            {
                // Prune expired entries
                while (_timestamps.Count > 0 && now - _timestamps.Peek() > windowMs)
                    _timestamps.Dequeue();

                if (_timestamps.Count >= maxCount)
                {
                    var oldest = _timestamps.Peek();
                    var retryAfterMs = windowMs - (now - oldest);
                    return TimeSpan.FromMilliseconds(Math.Max(retryAfterMs, 100));
                }

                _timestamps.Enqueue(now);
                return null;
            }
        }
    }

    /// <summary>
    /// Returns true if the method is exempt from rate limiting.
    /// </summary>
    public bool IsExempt(string methodName) => Exempt.Contains(methodName);

    /// <summary>
    /// Returns true if the method's category is silent (no error toast on rate limit).
    /// </summary>
    public bool IsSilent(string methodName) =>
        MethodCategories.TryGetValue(methodName, out var cat) && SilentCategories.Contains(cat);

    /// <summary>
    /// Try to consume a rate limit token. Returns null if allowed, or TimeSpan retryAfter if blocked.
    /// </summary>
    public TimeSpan? TryConsume(string userId, string methodName)
    {
        if (!MethodCategories.TryGetValue(methodName, out var category))
            return null; // Unknown method = allow

        var limit = Limits[category];
        var key = $"{userId}:{category}";
        var window = _windows.GetOrAdd(key, _ => new SlidingWindow());
        return window.TryConsume(limit.MaxCount, limit.Window);
    }

    /// <summary>
    /// Remove all rate limit state for a user (called on disconnect).
    /// </summary>
    public void RemoveUser(string userId)
    {
        var prefix = $"{userId}:";
        foreach (var key in _windows.Keys)
        {
            if (key.StartsWith(prefix))
                _windows.TryRemove(key, out _);
        }
    }
}
