using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;

namespace Abyss.Api.Services;

public class NotificationCleanupService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<NotificationCleanupService> _logger;

    public NotificationCleanupService(IServiceProvider services, ILogger<NotificationCleanupService> logger)
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

                // Delete read notifications older than 7 days
                var readCutoff = DateTime.UtcNow.AddDays(-7);
                var deletedRead = await db.Database.ExecuteSqlInterpolatedAsync(
                    $@"DELETE FROM ""Notifications"" WHERE ""IsRead"" = true AND ""CreatedAt"" < {readCutoff}",
                    stoppingToken);

                // Delete all notifications older than 30 days (even unread)
                var allCutoff = DateTime.UtcNow.AddDays(-30);
                var deletedOld = await db.Database.ExecuteSqlInterpolatedAsync(
                    $@"DELETE FROM ""Notifications"" WHERE ""CreatedAt"" < {allCutoff}",
                    stoppingToken);

                // Delete push tokens not used in 90 days
                var tokenCutoff = DateTime.UtcNow.AddDays(-90);
                var deletedTokens = await db.Database.ExecuteSqlInterpolatedAsync(
                    $@"DELETE FROM ""DevicePushTokens"" WHERE ""CreatedAt"" < {tokenCutoff}",
                    stoppingToken);

                // Reset old Failed push notifications so they don't pile up
                var failedCutoff = DateTime.UtcNow.AddDays(-1);
                var resetFailed = await db.Database.ExecuteSqlInterpolatedAsync(
                    $@"UPDATE ""Notifications"" SET ""PushStatus"" = 0 WHERE ""PushStatus"" = 3 AND ""CreatedAt"" < {failedCutoff}",
                    stoppingToken);

                var total = deletedRead + deletedOld + deletedTokens + resetFailed;
                if (total > 0)
                {
                    _logger.LogInformation(
                        "Notification cleanup: {Read} read notifs (>7d), {Old} old notifs (>30d), {Tokens} stale tokens (>90d), {Failed} failed push reset (>1d)",
                        deletedRead, deletedOld, deletedTokens, resetFailed);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error during notification cleanup");
            }
        }
    }
}
