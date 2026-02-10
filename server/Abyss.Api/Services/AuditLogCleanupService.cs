using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;

namespace Abyss.Api.Services;

public class AuditLogCleanupService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<AuditLogCleanupService> _logger;

    public AuditLogCleanupService(IServiceProvider services, ILogger<AuditLogCleanupService> logger)
    {
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromDays(1), stoppingToken);

            try
            {
                using var scope = _services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

                var cutoff = DateTime.UtcNow.AddDays(-90);
                var deleted = await db.Database.ExecuteSqlInterpolatedAsync(
                    $@"DELETE FROM ""AuditLogs"" WHERE ""CreatedAt"" < {cutoff}",
                    stoppingToken);

                if (deleted > 0)
                {
                    _logger.LogInformation("Deleted {Count} audit log entries older than 90 days", deleted);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error during audit log cleanup");
            }
        }
    }
}
