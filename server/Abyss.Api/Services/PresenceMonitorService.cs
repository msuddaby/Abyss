using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Hubs;

namespace Abyss.Api.Services;

/// <summary>
/// Monitors user heartbeats and auto-sets users to Away when their client
/// stops sending pings (e.g. laptop sleep, browser suspended).
/// </summary>
public class PresenceMonitorService : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly ILogger<PresenceMonitorService> _logger;

    private static readonly TimeSpan PollInterval = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan IdleThreshold = TimeSpan.FromMinutes(10);

    public PresenceMonitorService(
        IServiceScopeFactory scopeFactory,
        IHubContext<ChatHub> hubContext,
        ILogger<PresenceMonitorService> logger)
    {
        _scopeFactory = scopeFactory;
        _hubContext = hubContext;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(PollInterval, stoppingToken);

            try
            {
                await CheckStaleHeartbeats(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error in presence monitor sweep");
            }
        }
    }

    private async Task CheckStaleHeartbeats(CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        // Get currently-connected user IDs
        var onlineUserIds = ChatHub._connections.Values.ToHashSet();

        // Clean up heartbeat entries for users no longer connected
        foreach (var kvp in ChatHub._lastHeartbeats)
        {
            if (!onlineUserIds.Contains(kvp.Key))
            {
                ChatHub._lastHeartbeats.TryRemove(kvp.Key, out _);
            }
        }

        // Find users with stale heartbeats who are still connected
        var staleUserIds = new List<string>();
        foreach (var kvp in ChatHub._lastHeartbeats)
        {
            if (onlineUserIds.Contains(kvp.Key) && now - kvp.Value > IdleThreshold)
            {
                // Only process if not already auto-away
                if (!ChatHub._serverAutoAway.ContainsKey(kvp.Key))
                {
                    staleUserIds.Add(kvp.Key);
                }
            }
        }

        if (staleUserIds.Count == 0) return;

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        foreach (var userId in staleUserIds)
        {
            var user = await db.Users.FindAsync([userId], ct);
            if (user == null) continue;

            // Only auto-away users who are currently Online (don't override manual Away/DND/Invisible)
            if (user.PresenceStatus != 0) continue;

            user.PresenceStatus = 1; // Away
            await db.SaveChangesAsync(ct);

            ChatHub._serverAutoAway[userId] = 0;

            // Broadcast to all servers this user is in
            var serverIds = await db.ServerMembers
                .Where(sm => sm.UserId == userId)
                .Select(sm => sm.ServerId)
                .ToListAsync(ct);

            foreach (var serverId in serverIds)
            {
                await _hubContext.Clients.Group($"server:{serverId}")
                    .SendAsync("UserPresenceStatusChanged", userId, 1, ct);
            }

            _logger.LogInformation("Auto-set user {UserId} to Away (stale heartbeat)", userId);
        }
    }
}
