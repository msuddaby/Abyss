using System.Collections.Concurrent;
using System.Linq;
using Abyss.Api.DTOs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

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
        public DateTime LastSeen { get; set; } = DateTime.UtcNow;
    }

    // channelId -> {userId -> VoiceUserState}
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, VoiceUserState>> _voiceChannels = new();

    // userId -> connectionId that owns the voice session
    private readonly ConcurrentDictionary<string, string> _voiceConnections = new();

    // userId -> channelId (inverse lookup for O(1) GetUserChannel / TouchUser)
    private readonly ConcurrentDictionary<string, Guid> _userChannels = new();

    // channelId -> {userId -> displayName} of active screen sharers
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, string>> _activeSharers = new();

    // channelId -> {userId -> displayName} of active camera users
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, string>> _activeCameras = new();

    // channelId -> set of userIds using SFU relay
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, byte>> _relayUsers = new();

    public void JoinChannel(Guid channelId, string userId, string displayName, bool isMuted, bool isDeafened, string connectionId)
    {
        var users = _voiceChannels.GetOrAdd(channelId, _ => new ConcurrentDictionary<string, VoiceUserState>());
        users[userId] = new VoiceUserState
        {
            DisplayName = displayName,
            IsMuted = isMuted,
            IsDeafened = isDeafened,
            IsServerMuted = false,
            IsServerDeafened = false,
            LastSeen = DateTime.UtcNow,
        };
        _voiceConnections[userId] = connectionId;
        _userChannels[userId] = channelId;
    }

    /// <summary>
    /// Lightweight reconnect: update only the SignalR connection ID without
    /// resetting mute/deafen/server-mute state. Used when the user's SignalR
    /// connection changed but they never actually left voice.
    /// </summary>
    public void UpdateConnectionId(string userId, string connectionId)
    {
        _voiceConnections[userId] = connectionId;
        // Touch LastSeen so heartbeat doesn't think we're stale
        var channelId = _userChannels.GetValueOrDefault(userId);
        if (channelId != default && _voiceChannels.TryGetValue(channelId, out var users) && users.TryGetValue(userId, out var state))
        {
            state.LastSeen = DateTime.UtcNow;
        }
    }

    public void LeaveChannel(Guid channelId, string userId)
    {
        var removedFromChannel = false;
        if (_voiceChannels.TryGetValue(channelId, out var users))
        {
            removedFromChannel = users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);
        }

        if (!removedFromChannel) return;

        _voiceConnections.TryRemove(userId, out _);
        _userChannels.TryRemove(userId, out _);

        // Remove this user from screen sharers if they were sharing
        RemoveScreenSharer(channelId, userId);
        RemoveCameraUser(channelId, userId);
        RemoveRelayUser(channelId, userId);
    }

    public void LeaveAll(string userId)
    {
        foreach (var (channelId, users) in _voiceChannels)
        {
            users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);

            // Remove this user from screen sharers and camera if they were active
            RemoveScreenSharer(channelId, userId);
            RemoveCameraUser(channelId, userId);
            RemoveRelayUser(channelId, userId);
        }

        _voiceConnections.TryRemove(userId, out _);
        _userChannels.TryRemove(userId, out _);
    }

    /// <summary>
    /// Check if a specific connectionId is the voice connection for a user.
    /// </summary>
    public bool IsVoiceConnection(string userId, string connectionId)
    {
        return _voiceConnections.TryGetValue(userId, out var voiceConnId) && voiceConnId == connectionId;
    }

    /// <summary>
    /// Get the SignalR connectionId that owns this user's voice session.
    /// </summary>
    public string? GetVoiceConnectionId(string userId)
    {
        return _voiceConnections.TryGetValue(userId, out var connId) ? connId : null;
    }

    public bool IsUserInChannel(Guid channelId, string userId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
            return users.ContainsKey(userId);
        return false;
    }

    public List<string> GetChannelUserIds(Guid channelId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
            return users.Keys.ToList();
        return new List<string>();
    }

    public bool IsChannelEmpty(Guid channelId)
    {
        if (_voiceChannels.TryGetValue(channelId, out var users))
            return users.IsEmpty;
        return true;
    }

    public Guid? GetUserChannel(string userId)
    {
        return _userChannels.TryGetValue(userId, out var ch) ? ch : null;
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
            state.LastSeen = DateTime.UtcNow;

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

    public void AddCameraUser(Guid channelId, string userId, string displayName)
    {
        var cameras = _activeCameras.GetOrAdd(channelId, _ => new ConcurrentDictionary<string, string>());
        cameras[userId] = displayName;
    }

    public bool RemoveCameraUser(Guid channelId, string userId)
    {
        if (_activeCameras.TryGetValue(channelId, out var cameras))
        {
            var removed = cameras.TryRemove(userId, out _);
            if (cameras.IsEmpty)
                _activeCameras.TryRemove(channelId, out _);
            return removed;
        }
        return false;
    }

    public Dictionary<string, string> GetCameraUsers(Guid channelId)
    {
        if (_activeCameras.TryGetValue(channelId, out var cameras))
            return new Dictionary<string, string>(cameras);
        return new Dictionary<string, string>();
    }

    public bool IsCameraOn(Guid channelId, string userId)
    {
        if (_activeCameras.TryGetValue(channelId, out var cameras))
            return cameras.ContainsKey(userId);
        return false;
    }

    public Dictionary<Guid, HashSet<string>> GetCamerasForChannels(IEnumerable<Guid> channelIds)
    {
        var result = new Dictionary<Guid, HashSet<string>>();
        foreach (var channelId in channelIds)
        {
            if (_activeCameras.TryGetValue(channelId, out var cameras) && !cameras.IsEmpty)
            {
                result[channelId] = new HashSet<string>(cameras.Keys);
            }
        }
        return result;
    }

    public void AddRelayUser(Guid channelId, string userId)
    {
        var users = _relayUsers.GetOrAdd(channelId, _ => new ConcurrentDictionary<string, byte>());
        users[userId] = 0;
    }

    public bool RemoveRelayUser(Guid channelId, string userId)
    {
        if (_relayUsers.TryGetValue(channelId, out var users))
        {
            var removed = users.TryRemove(userId, out _);
            if (users.IsEmpty)
                _relayUsers.TryRemove(channelId, out _);
            return removed;
        }
        return false;
    }

    public bool ChannelHasRelayUsers(Guid channelId)
    {
        return _relayUsers.TryGetValue(channelId, out var users) && !users.IsEmpty;
    }

    /// <summary>
    /// Refresh the LastSeen timestamp for a user (called on voice activity like signaling).
    /// </summary>
    public void TouchUser(string userId)
    {
        if (!_userChannels.TryGetValue(userId, out var channelId)) return;
        if (_voiceChannels.TryGetValue(channelId, out var users) && users.TryGetValue(userId, out var state))
        {
            state.LastSeen = DateTime.UtcNow;
        }
    }

    /// <summary>
    /// Refresh LastSeen for voice users that still have an active SignalR connection.
    /// This prevents the cleanup service from evicting users whose P2P audio is still
    /// working even though their SignalR connection churned.
    /// </summary>
    public void RefreshActiveUsers(Func<string, bool> hasActiveConnection)
    {
        foreach (var (_, users) in _voiceChannels)
        {
            foreach (var (userId, state) in users)
            {
                if (hasActiveConnection(userId))
                {
                    state.LastSeen = DateTime.UtcNow;
                }
            }
        }
    }

    /// <summary>
    /// Remove voice users whose LastSeen is older than the given threshold.
    /// Returns list of (channelId, userId, wasSharing, hadCamera) tuples that were cleaned up.
    /// </summary>
    public List<(Guid ChannelId, string UserId, bool WasSharing, bool HadCamera)> CleanupStaleConnections(TimeSpan maxAge)
    {
        var cutoff = DateTime.UtcNow - maxAge;
        var removed = new List<(Guid, string, bool, bool)>();

        foreach (var (channelId, users) in _voiceChannels)
        {
            foreach (var (userId, state) in users)
            {
                if (state.LastSeen < cutoff)
                {
                    users.TryRemove(userId, out _);
                    _voiceConnections.TryRemove(userId, out _);
                    _userChannels.TryRemove(userId, out _);
                    var wasSharing = RemoveScreenSharer(channelId, userId);
                    var hadCamera = RemoveCameraUser(channelId, userId);
                    RemoveRelayUser(channelId, userId);
                    removed.Add((channelId, userId, wasSharing, hadCamera));
                }
            }

            if (users.IsEmpty)
                _voiceChannels.TryRemove(channelId, out _);
        }

        return removed;
    }
}

public class VoiceStateCleanupService : BackgroundService
{
    private readonly VoiceStateService _voiceState;
    private readonly ILogger<VoiceStateCleanupService> _logger;
    private readonly IHubContext<Abyss.Api.Hubs.ChatHub> _hubContext;
    private readonly IServiceScopeFactory _scopeFactory;

    // Voice state now persists across SignalR disconnections (P2P audio is independent).
    // Only clean up sessions that have been truly abandoned for hours.
    private static readonly TimeSpan StaleThreshold = TimeSpan.FromHours(2);

    public VoiceStateCleanupService(
        VoiceStateService voiceState,
        ILogger<VoiceStateCleanupService> logger,
        IHubContext<Abyss.Api.Hubs.ChatHub> hubContext,
        IServiceScopeFactory scopeFactory)
    {
        _voiceState = voiceState;
        _logger = logger;
        _hubContext = hubContext;
        _scopeFactory = scopeFactory;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);

            try
            {
                // Refresh LastSeen for users that still have an active SignalR connection.
                // This keeps their voice state alive even if no voice-specific activity
                // has occurred (e.g. they're just listening, not sending signals).
                _voiceState.RefreshActiveUsers(userId =>
                    Abyss.Api.Hubs.ChatHub._connections.Values.Any(v => v == userId));

                var removed = _voiceState.CleanupStaleConnections(StaleThreshold);
                if (removed.Count == 0) continue;

                _logger.LogWarning("Cleaned up {Count} stale voice connections", removed.Count);

                // Send proper signals for each removed user so other clients update
                using var scope = _scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<Abyss.Api.Data.AppDbContext>();
                var perms = scope.ServiceProvider.GetRequiredService<PermissionService>();

                foreach (var (channelId, userId, wasSharing, hadCamera) in removed)
                {
                    var channelIdStr = channelId.ToString();

                    // Notify voice group
                    if (wasSharing)
                        await _hubContext.Clients.Group($"voice:{channelIdStr}").SendAsync("ScreenShareStopped", userId);
                    if (hadCamera)
                        await _hubContext.Clients.Group($"voice:{channelIdStr}").SendAsync("CameraStopped", userId);
                    await _hubContext.Clients.Group($"voice:{channelIdStr}").SendAsync("UserLeftVoice", userId);

                    // Notify sidebar
                    var channel = await db.Channels.FindAsync(channelId);
                    if (channel?.ServerId != null)
                    {
                        var recipients = await perms.GetUserIdsWithChannelPermissionAsync(channelId, Abyss.Api.Models.Permission.ViewChannel);
                        foreach (var recipientId in recipients)
                        {
                            if (wasSharing)
                                await _hubContext.Clients.Group($"user:{recipientId}").SendAsync("ScreenShareStoppedInChannel", channelIdStr, userId);
                            if (hadCamera)
                                await _hubContext.Clients.Group($"user:{recipientId}").SendAsync("CameraStoppedInChannel", channelIdStr, userId);
                            await _hubContext.Clients.Group($"user:{recipientId}").SendAsync("VoiceUserLeftChannel", channelIdStr, userId, (string?)null);
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error during voice state cleanup");
            }
        }
    }
}
