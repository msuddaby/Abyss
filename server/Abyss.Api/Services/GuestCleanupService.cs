using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace Abyss.Api.Services;

public class GuestCleanupService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<GuestCleanupService> _logger;

    public GuestCleanupService(IServiceProvider services, ILogger<GuestCleanupService> logger)
    {
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromHours(6), stoppingToken);

            try
            {
                using var scope = _services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var hub = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();

                var cutoff = DateTime.UtcNow.AddDays(-7);

                // Find guests inactive for 7+ days
                var staleGuests = await db.Users
                    .Where(u => u.IsGuest &&
                        ((u.LastActiveAt != null && u.LastActiveAt < cutoff) ||
                         (u.LastActiveAt == null && u.CreatedAt < cutoff)))
                    .ToListAsync(stoppingToken);

                if (staleGuests.Count == 0) continue;

                foreach (var guest in staleGuests)
                {
                    // Get servers this guest is in for broadcasting
                    var serverIds = await db.ServerMembers
                        .Where(sm => sm.UserId == guest.Id)
                        .Select(sm => sm.ServerId)
                        .ToListAsync(stoppingToken);

                    // Remove related data
                    var memberRoles = db.ServerMemberRoles.Where(smr => smr.UserId == guest.Id);
                    db.ServerMemberRoles.RemoveRange(memberRoles);

                    var members = db.ServerMembers.Where(sm => sm.UserId == guest.Id);
                    db.ServerMembers.RemoveRange(members);

                    var refreshTokens = db.RefreshTokens.Where(rt => rt.UserId == guest.Id);
                    db.RefreshTokens.RemoveRange(refreshTokens);

                    var channelReads = db.ChannelReads.Where(cr => cr.UserId == guest.Id);
                    db.ChannelReads.RemoveRange(channelReads);

                    var notifications = db.Notifications.Where(n => n.UserId == guest.Id);
                    db.Notifications.RemoveRange(notifications);

                    var notifSettings = db.UserServerNotificationSettings.Where(s => s.UserId == guest.Id);
                    db.UserServerNotificationSettings.RemoveRange(notifSettings);

                    var channelNotifSettings = db.UserChannelNotificationSettings.Where(s => s.UserId == guest.Id);
                    db.UserChannelNotificationSettings.RemoveRange(channelNotifSettings);

                    // Deactivate the user (preserve messages)
                    guest.UserName = $"deleted_guest_{guest.Id}";
                    guest.NormalizedUserName = guest.UserName.ToUpperInvariant();
                    guest.DisplayName = "Deleted User";
                    guest.AvatarUrl = null;
                    guest.Bio = string.Empty;
                    guest.Status = string.Empty;
                    guest.LockoutEnd = DateTimeOffset.MaxValue;

                    await db.SaveChangesAsync(stoppingToken);

                    // Broadcast removal from each server
                    foreach (var serverId in serverIds)
                    {
                        await hub.Clients.Group($"server:{serverId}")
                            .SendAsync("MemberKicked", serverId.ToString(), guest.Id, stoppingToken);
                    }
                }

                _logger.LogInformation("Guest cleanup: deactivated {Count} stale guest accounts", staleGuests.Count);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error during guest cleanup");
            }
        }
    }
}
