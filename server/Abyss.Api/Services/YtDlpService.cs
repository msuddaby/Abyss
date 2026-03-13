using System.Diagnostics;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Abyss.Api.Data;

namespace Abyss.Api.Services;

public class YtDlpService
{
    private readonly IMemoryCache _cache;
    private readonly IServiceScopeFactory _scopeFactory;
    private static readonly TimeSpan ProcessTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(5);

    private const string YtDlpEnabledKey = "YtDlpEnabled";
    private const string YtDlpAllowedDomainsKey = "YtDlpAllowedDomains";

    public YtDlpService(IMemoryCache cache, IServiceScopeFactory scopeFactory)
    {
        _cache = cache;
        _scopeFactory = scopeFactory;
    }

    public async Task<bool> IsEnabledAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.AppConfigs.FirstOrDefaultAsync(c => c.Key == YtDlpEnabledKey);
        return row != null && bool.TryParse(row.Value, out var val) && val;
    }

    public async Task<List<string>> GetAllowedDomainsAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.AppConfigs.FirstOrDefaultAsync(c => c.Key == YtDlpAllowedDomainsKey);
        if (row == null || string.IsNullOrWhiteSpace(row.Value)) return new List<string>();
        try
        {
            return JsonSerializer.Deserialize<List<string>>(row.Value) ?? new List<string>();
        }
        catch
        {
            return new List<string>();
        }
    }

    public bool ValidateDomain(string url, List<string> allowedDomains)
    {
        // Empty allowlist = allow all (when feature is enabled)
        if (allowedDomains.Count == 0) return true;

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return false;

        var host = uri.Host.ToLowerInvariant();
        return allowedDomains.Any(domain =>
        {
            var d = domain.ToLowerInvariant().TrimStart('.');
            return host == d || host.EndsWith("." + d);
        });
    }

    public bool IsAvailable()
    {
        try
        {
            var psi = new ProcessStartInfo("yt-dlp", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var proc = Process.Start(psi);
            if (proc == null) return false;
            proc.WaitForExit(5000);
            return proc.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    public async Task<YtDlpMetadata?> GetMetadataAsync(string url)
    {
        var cacheKey = $"ytdlp:meta:{url}";
        if (_cache.TryGetValue(cacheKey, out YtDlpMetadata? cached))
            return cached;

        var (exitCode, stdout, stderr) = await RunAsync("--dump-json", "--no-playlist", "--no-exec", url);
        if (exitCode != 0)
        {
            Console.WriteLine($"yt-dlp metadata failed: {stderr}");
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(stdout);
            var root = doc.RootElement;

            var metadata = new YtDlpMetadata
            {
                Title = root.TryGetProperty("title", out var t) ? t.GetString() ?? url : url,
                Thumbnail = root.TryGetProperty("thumbnail", out var th) ? th.GetString() : null,
                DurationMs = root.TryGetProperty("duration", out var d) && d.ValueKind == JsonValueKind.Number
                    ? (long)(d.GetDouble() * 1000)
                    : null,
                Uploader = root.TryGetProperty("uploader", out var u) ? u.GetString() : null,
            };

            _cache.Set(cacheKey, metadata, new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = CacheDuration,
                Size = 1
            });

            return metadata;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"yt-dlp metadata parse failed: {ex.Message}");
            return null;
        }
    }

    public async Task<YtDlpPlayback?> GetPlaybackUrlAsync(string url)
    {
        var cacheKey = $"ytdlp:playback:{url}";
        if (_cache.TryGetValue(cacheKey, out YtDlpPlayback? cached))
            return cached;

        // Use -j to get JSON with direct URL info
        // Prefer combined (audio+video) formats first — avoids the merged-format problem
        // where yt-dlp returns separate streams with no root url
        var (exitCode, stdout, stderr) = await RunAsync(
            "-j", "--no-playlist", "--no-exec",
            "-f", "best[vcodec!=none][acodec!=none][ext=mp4]/best[vcodec!=none][acodec!=none]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
            url);

        if (exitCode != 0)
        {
            Console.WriteLine($"yt-dlp playback failed: {stderr}");
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(stdout);
            var root = doc.RootElement;

            string? playbackUrl = null;
            string contentType = "video/mp4";
            var headers = new Dictionary<string, string>();

            // Check for manifest_url (HLS/DASH) first
            if (root.TryGetProperty("manifest_url", out var manifest) && manifest.GetString() is string manifestUrl)
            {
                playbackUrl = manifestUrl;
                contentType = manifestUrl.Contains(".m3u8") ? "application/x-mpegURL" : "video/mp4";
            }
            // Then check direct url
            else if (root.TryGetProperty("url", out var directUrl) && directUrl.GetString() is string direct)
            {
                playbackUrl = direct;
                var ext = root.TryGetProperty("ext", out var e) ? e.GetString() : "mp4";
                contentType = ext switch
                {
                    "m3u8" => "application/x-mpegURL",
                    "mp4" => "video/mp4",
                    "webm" => "video/webm",
                    _ => "video/mp4"
                };
            }
            // Fallback: merged format (bestvideo+bestaudio) — root url is absent,
            // but requested_formats has the individual stream URLs
            else if (root.TryGetProperty("requested_formats", out var reqFormats)
                     && reqFormats.ValueKind == JsonValueKind.Array)
            {
                foreach (var fmt in reqFormats.EnumerateArray())
                {
                    // Pick the video stream (has vcodec != none)
                    if (fmt.TryGetProperty("vcodec", out var vc) && vc.GetString() is string vcodec
                        && vcodec != "none"
                        && fmt.TryGetProperty("url", out var fmtUrl) && fmtUrl.GetString() is string videoUrl)
                    {
                        playbackUrl = videoUrl;
                        var ext = fmt.TryGetProperty("ext", out var fmtExt) ? fmtExt.GetString() : "mp4";
                        contentType = ext switch
                        {
                            "mp4" => "video/mp4",
                            "webm" => "video/webm",
                            _ => "video/mp4"
                        };
                        // Use headers from this specific format entry
                        if (fmt.TryGetProperty("http_headers", out var fmtHdrs) && fmtHdrs.ValueKind == JsonValueKind.Object)
                        {
                            foreach (var prop in fmtHdrs.EnumerateObject())
                            {
                                if (prop.Value.GetString() is string val)
                                    headers[prop.Name] = val;
                            }
                        }
                        break;
                    }
                }
            }

            if (playbackUrl == null) return null;

            // Use root-level headers if none were set by a format-specific branch
            if (headers.Count == 0 && root.TryGetProperty("http_headers", out var hdrs) && hdrs.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in hdrs.EnumerateObject())
                {
                    if (prop.Value.GetString() is string val)
                        headers[prop.Name] = val;
                }
            }

            var result = new YtDlpPlayback
            {
                Url = playbackUrl,
                ContentType = contentType,
                Headers = headers
            };

            _cache.Set(cacheKey, result, new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = CacheDuration,
                Size = 1
            });

            return result;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"yt-dlp playback parse failed: {ex.Message}");
            return null;
        }
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunAsync(params string[] args)
    {
        var psi = new ProcessStartInfo("yt-dlp")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        foreach (var arg in args)
            psi.ArgumentList.Add(arg);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start yt-dlp process");

        using var cts = new CancellationTokenSource(ProcessTimeout);
        try
        {
            var stdoutTask = proc.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = proc.StandardError.ReadToEndAsync(cts.Token);
            await proc.WaitForExitAsync(cts.Token);
            return (proc.ExitCode, await stdoutTask, await stderrTask);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(true); } catch { }
            return (-1, "", "yt-dlp process timed out");
        }
    }
}

public class YtDlpMetadata
{
    public string Title { get; set; } = "";
    public string? Thumbnail { get; set; }
    public long? DurationMs { get; set; }
    public string? Uploader { get; set; }
}

public class YtDlpPlayback
{
    public string Url { get; set; } = "";
    public string ContentType { get; set; } = "video/mp4";
    public Dictionary<string, string> Headers { get; set; } = new();
}
