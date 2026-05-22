using System.Collections.Concurrent;
using System.Xml;
using System.Xml.Linq;
using Microsoft.AspNetCore.SignalR;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public record RssItem(string Guid, string Title, string Link, string? Author, DateTime? PubDate);

public class CachedFeed
{
    public List<RssItem> Items { get; set; } = new();
    public DateTime? LastFetched { get; set; }
    public string? LastError { get; set; }
    public string? SourceUrl { get; set; }
}

public class RssFeedService
{
    private const int MaxItemsPerFeed = 50;
    private const long MaxResponseBytes = 5L * 1024 * 1024; // 5 MB
    private static readonly XNamespace AtomNs = "http://www.w3.org/2005/Atom";
    private static readonly XNamespace DcNs = "http://purl.org/dc/elements/1.1/";

    private readonly ConcurrentDictionary<Guid, CachedFeed> _cache = new();
    private readonly IHttpClientFactory _httpFactory;
    private readonly IHubContext<ChatHub> _hub;
    private readonly ILogger<RssFeedService> _logger;

    public RssFeedService(IHttpClientFactory httpFactory, IHubContext<ChatHub> hub, ILogger<RssFeedService> logger)
    {
        _httpFactory = httpFactory;
        _hub = hub;
        _logger = logger;
    }

    public CachedFeed GetCached(Guid channelId)
    {
        return _cache.TryGetValue(channelId, out var cached) ? cached : new CachedFeed();
    }

    public void Invalidate(Guid channelId)
    {
        _cache.TryRemove(channelId, out _);
    }

    public async Task RefreshAsync(Channel channel, CancellationToken ct = default)
    {
        if (channel.Type != ChannelType.RssFeed || string.IsNullOrWhiteSpace(channel.RssFeedUrl)) return;

        var cached = _cache.GetOrAdd(channel.Id, _ => new CachedFeed());
        cached.SourceUrl = channel.RssFeedUrl;

        try
        {
            var items = await FetchAndParseAsync(channel.RssFeedUrl, ct);
            cached.Items = items.Take(MaxItemsPerFeed).ToList();
            cached.LastFetched = DateTime.UtcNow;
            cached.LastError = null;

            var dto = ToStateDto(cached);
            await _hub.Clients.Group($"channel:{channel.Id}")
                .SendAsync("RssFeedUpdated", channel.Id.ToString(), dto, ct);
        }
        catch (Exception ex)
        {
            cached.LastFetched = DateTime.UtcNow;
            cached.LastError = ex.Message;
            _logger.LogWarning(ex, "Failed to refresh RSS feed for channel {ChannelId} ({Url})", channel.Id, channel.RssFeedUrl);

            var dto = ToStateDto(cached);
            await _hub.Clients.Group($"channel:{channel.Id}")
                .SendAsync("RssFeedUpdated", channel.Id.ToString(), dto, ct);
        }
    }

    public static RssFeedStateDto ToStateDto(CachedFeed cached)
    {
        var items = cached.Items
            .Select(i => new RssFeedItemDto(i.Guid, i.Title, i.Link, i.Author, i.PubDate))
            .ToList();
        return new RssFeedStateDto(items, cached.LastFetched, cached.LastError);
    }

    private async Task<List<RssItem>> FetchAndParseAsync(string url, CancellationToken ct)
    {
        var client = _httpFactory.CreateClient("rss");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        if (response.Content.Headers.ContentLength is > MaxResponseBytes)
            throw new InvalidOperationException($"Feed exceeds size limit ({response.Content.Headers.ContentLength} bytes).");

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        await using var limited = new LimitedStream(stream, MaxResponseBytes);

        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Ignore,
            XmlResolver = null,
            Async = true,
        };
        using var reader = XmlReader.Create(limited, settings);
        var doc = await XDocument.LoadAsync(reader, LoadOptions.None, ct);

        if (doc.Root == null) throw new InvalidOperationException("Feed XML has no root.");

        return doc.Root.Name.LocalName.Equals("feed", StringComparison.OrdinalIgnoreCase)
            ? ParseAtom(doc.Root)
            : ParseRss(doc.Root);
    }

    private static List<RssItem> ParseRss(XElement root)
    {
        var channel = root.Element("channel") ?? root;
        var items = new List<RssItem>();
        foreach (var item in channel.Elements("item"))
        {
            var title = item.Element("title")?.Value.Trim() ?? "(untitled)";
            var link = item.Element("link")?.Value.Trim() ?? "";
            var guid = item.Element("guid")?.Value.Trim() ?? link;
            var author = item.Element(DcNs + "creator")?.Value.Trim()
                         ?? item.Element("author")?.Value.Trim();
            DateTime? pubDate = TryParseDate(item.Element("pubDate")?.Value);
            items.Add(new RssItem(guid, title, link, author, pubDate));
        }
        return items;
    }

    private static List<RssItem> ParseAtom(XElement root)
    {
        var items = new List<RssItem>();
        foreach (var entry in root.Elements(AtomNs + "entry"))
        {
            var title = entry.Element(AtomNs + "title")?.Value.Trim() ?? "(untitled)";
            var linkEl = entry.Elements(AtomNs + "link").FirstOrDefault(l => (string?)l.Attribute("rel") is null or "alternate")
                         ?? entry.Element(AtomNs + "link");
            var link = linkEl?.Attribute("href")?.Value.Trim() ?? "";
            var id = entry.Element(AtomNs + "id")?.Value.Trim() ?? link;
            var author = entry.Element(AtomNs + "author")?.Element(AtomNs + "name")?.Value.Trim();
            DateTime? pubDate = TryParseDate(entry.Element(AtomNs + "published")?.Value)
                                ?? TryParseDate(entry.Element(AtomNs + "updated")?.Value);
            items.Add(new RssItem(id, title, link, author, pubDate));
        }
        return items;
    }

    private static DateTime? TryParseDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (DateTime.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
                out var dt))
            return dt;
        return null;
    }

    private sealed class LimitedStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _max;
        private long _read;
        public LimitedStream(Stream inner, long max) { _inner = inner; _max = max; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => _read; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = _inner.Read(buffer, offset, count);
            _read += n;
            if (_read > _max) throw new InvalidOperationException("RSS feed exceeded size limit.");
            return n;
        }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            var n = await _inner.ReadAsync(buffer, ct);
            _read += n;
            if (_read > _max) throw new InvalidOperationException("RSS feed exceeded size limit.");
            return n;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
