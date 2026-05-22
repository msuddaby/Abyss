using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public class RssFeedRefresher : BackgroundService
{
    private const int DefaultIntervalMinutes = 30;
    private static readonly TimeSpan ScanInterval = TimeSpan.FromSeconds(60);

    private readonly IServiceProvider _services;
    private readonly RssFeedService _rss;
    private readonly ILogger<RssFeedRefresher> _logger;

    public RssFeedRefresher(IServiceProvider services, RssFeedService rss, ILogger<RssFeedRefresher> logger)
    {
        _services = services;
        _rss = rss;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Small initial delay so app startup completes
        try { await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken); }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var channels = await db.Channels
                    .Where(c => c.Type == ChannelType.RssFeed && c.RssFeedUrl != null)
                    .AsNoTracking()
                    .ToListAsync(stoppingToken);

                var now = DateTime.UtcNow;
                foreach (var channel in channels)
                {
                    if (stoppingToken.IsCancellationRequested) break;

                    var cached = _rss.GetCached(channel.Id);
                    var intervalMin = channel.RssRefreshIntervalMinutes ?? DefaultIntervalMinutes;
                    var stale = cached.LastFetched is null
                                || (now - cached.LastFetched.Value) >= TimeSpan.FromMinutes(intervalMin)
                                || !string.Equals(cached.SourceUrl, channel.RssFeedUrl, StringComparison.Ordinal);
                    if (!stale) continue;

                    await _rss.RefreshAsync(channel, stoppingToken);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error during RSS feed refresh scan");
            }

            try { await Task.Delay(ScanInterval, stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }
}
