using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;
using Abyss.Api.Services.MediaProviders;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/servers/{serverId}/media-providers")]
[Authorize]
public class MediaProvidersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly IHubContext<ChatHub> _hub;
    private readonly MediaProviderFactory _providerFactory;
    private readonly ProviderConfigProtector _protector;
    private readonly WatchPartyService _watchPartyService;

    public MediaProvidersController(
        AppDbContext db,
        PermissionService perms,
        IHubContext<ChatHub> hub,
        MediaProviderFactory providerFactory,
        ProviderConfigProtector protector,
        WatchPartyService watchPartyService)
    {
        _db = db;
        _perms = perms;
        _hub = hub;
        _providerFactory = providerFactory;
        _protector = protector;
        _watchPartyService = watchPartyService;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<ActionResult<List<MediaProviderConnectionDto>>> ListConnections(Guid serverId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connections = await _db.MediaProviderConnections
            .Where(c => c.ServerId == serverId)
            .OrderBy(c => c.LinkedAt)
            .Select(c => new MediaProviderConnectionDto(
                c.Id, c.ServerId, c.OwnerId, c.ProviderType.ToString(),
                c.DisplayName, c.LinkedAt, c.LastValidatedAt))
            .ToListAsync();
        return Ok(connections);
    }

    [HttpPost("link")]
    public async Task<ActionResult<MediaProviderConnectionDto>> LinkProvider(Guid serverId, LinkProviderRequest req)
    {
        if (!await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageServer)) return Forbid();

        if (!Enum.TryParse<MediaProviderType>(req.ProviderType, true, out var providerType))
            return BadRequest("Invalid provider type");

        var provider = _providerFactory.GetProvider(providerType);
        if (provider == null) return BadRequest("Unsupported provider type");

        // Build config JSON
        var configJson = JsonSerializer.Serialize(new { serverUrl = req.ServerUrl, authToken = req.AuthToken });

        // Authenticate with the provider
        var authResult = await provider.AuthenticateAsync(configJson);
        if (!authResult.Success)
            return BadRequest($"Failed to authenticate: {authResult.ErrorMessage}");

        var displayName = !string.IsNullOrWhiteSpace(req.DisplayName)
            ? req.DisplayName
            : authResult.ServerName ?? provider.GetProviderDisplayName();

        // Encrypt the config
        var encryptedConfig = _protector.Encrypt(configJson);

        var connection = new MediaProviderConnection
        {
            Id = Guid.NewGuid(),
            ServerId = serverId,
            OwnerId = UserId,
            ProviderType = providerType,
            DisplayName = displayName,
            ProviderConfigJson = encryptedConfig,
            LinkedAt = DateTime.UtcNow,
            LastValidatedAt = DateTime.UtcNow
        };

        _db.MediaProviderConnections.Add(connection);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.MediaProviderLinked, UserId,
            targetName: $"{providerType}: {displayName}");

        var dto = new MediaProviderConnectionDto(
            connection.Id, connection.ServerId, connection.OwnerId,
            connection.ProviderType.ToString(), connection.DisplayName,
            connection.LinkedAt, connection.LastValidatedAt);

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MediaProviderLinked", dto);
        return Ok(dto);
    }

    [HttpDelete("{connectionId}")]
    public async Task<IActionResult> UnlinkProvider(Guid serverId, Guid connectionId)
    {
        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        // Require owner of connection or ManageServer
        var server = await _db.Servers.FindAsync(serverId);
        if (server == null) return NotFound();
        var isOwner = server.OwnerId == UserId || connection.OwnerId == UserId;
        if (!isOwner && !await _perms.HasPermissionAsync(serverId, UserId, Permission.ManageServer))
            return Forbid();

        // Stop any active watch parties using this connection
        var activePartyChannels = await _db.WatchParties
            .Where(wp => wp.MediaProviderConnectionId == connectionId)
            .Select(wp => wp.ChannelId)
            .ToListAsync();

        foreach (var channelId in activePartyChannels)
        {
            _watchPartyService.StopParty(channelId);
            var wp = await _db.WatchParties.FirstOrDefaultAsync(w => w.ChannelId == channelId);
            if (wp != null) _db.WatchParties.Remove(wp);

            await _hub.Clients.Group($"voice:{channelId}").SendAsync("WatchPartyStopped", channelId.ToString());
            await _hub.Clients.Group($"server:{serverId}").SendAsync("WatchPartyStoppedInChannel", channelId.ToString());
        }

        _db.MediaProviderConnections.Remove(connection);
        await _db.SaveChangesAsync();

        await _perms.LogAsync(serverId, AuditAction.MediaProviderUnlinked, UserId,
            targetName: $"{connection.ProviderType}: {connection.DisplayName}");

        await _hub.Clients.Group($"server:{serverId}").SendAsync("MediaProviderUnlinked", connectionId.ToString());
        return NoContent();
    }

    [HttpGet("{connectionId}/validate")]
    public async Task<ActionResult<bool>> ValidateConnection(Guid serverId, Guid connectionId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var valid = await provider.ValidateConnectionAsync(configJson);

        if (valid)
        {
            connection.LastValidatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }

        return Ok(valid);
    }

    [HttpGet("{connectionId}/libraries")]
    public async Task<ActionResult<List<MediaLibraryDto>>> GetLibraries(Guid serverId, Guid connectionId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var libraries = await provider.GetLibrariesAsync(configJson);

        return Ok(libraries.Select(l => new MediaLibraryDto(
            l.Id, l.Name, l.Type, l.ItemCount, l.ThumbnailUrl)).ToList());
    }

    [HttpGet("{connectionId}/libraries/{libraryId}/items")]
    public async Task<ActionResult<List<MediaItemDto>>> GetLibraryItems(
        Guid serverId, Guid connectionId, string libraryId,
        [FromQuery] int offset = 0, [FromQuery] int limit = 50)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var items = await provider.GetLibraryItemsAsync(configJson, libraryId, offset, limit);

        return Ok(items.Select(MapToDto).ToList());
    }

    [HttpGet("{connectionId}/search")]
    public async Task<ActionResult<List<MediaItemDto>>> SearchItems(
        Guid serverId, Guid connectionId,
        [FromQuery] string query, [FromQuery] string? library = null)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var items = await provider.SearchItemsAsync(configJson, query, library);

        return Ok(items.Select(MapToDto).ToList());
    }

    [HttpGet("{connectionId}/items/{itemId}/children")]
    public async Task<ActionResult<List<MediaItemDto>>> GetItemChildren(Guid serverId, Guid connectionId, string itemId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var children = await provider.GetItemChildrenAsync(configJson, itemId);

        return Ok(children.Select(MapToDto).ToList());
    }

    [HttpGet("{connectionId}/items/{itemId}")]
    public async Task<ActionResult<MediaItemDto>> GetItemDetails(Guid serverId, Guid connectionId, string itemId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var item = await provider.GetItemDetailsAsync(configJson, itemId);
        if (item == null) return NotFound();

        return Ok(MapToDto(item));
    }

    [HttpGet("{connectionId}/items/{itemId}/playback")]
    public async Task<ActionResult<PlaybackInfoDto>> GetPlaybackInfo(Guid serverId, Guid connectionId, string itemId)
    {
        if (!await _perms.IsMemberAsync(serverId, UserId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var playback = await provider.GetPlaybackInfoAsync(configJson, itemId);
        if (playback == null) return NotFound();

        if (playback.ContentType == "application/x-mpegURL")
        {
            // HLS — extract the Plex path, strip auth token (proxy adds it server-side)
            var plexUri = new Uri(playback.Url);
            var plexPath = Regex.Replace(plexUri.PathAndQuery, @"[&?]X-Plex-Token=[^&]*", "");
            var proxyUrl = $"/api/servers/{serverId}/media-providers/{connectionId}/hls?path={Uri.EscapeDataString(plexPath)}";
            return Ok(new PlaybackInfoDto(proxyUrl, "application/x-mpegURL", playback.Headers));
        }

        // Direct file proxy
        var streamUrl = $"/api/servers/{serverId}/media-providers/{connectionId}/stream/{Uri.EscapeDataString(itemId)}";
        return Ok(new PlaybackInfoDto(streamUrl, playback.ContentType, playback.Headers));
    }

    [AllowAnonymous]
    [HttpGet("{connectionId}/stream/{itemId}")]
    public async Task<IActionResult> StreamItem(Guid serverId, Guid connectionId, string itemId, [FromQuery] string? token = null)
    {
        // Check auth from query string (for video element) or header
        string? userId = null;
        if (!string.IsNullOrEmpty(token))
        {
            // Validate JWT from query string
            try
            {
                var tokenHandler = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler();
                var jwtToken = tokenHandler.ReadJwtToken(token);
                userId = jwtToken.Claims.FirstOrDefault(c => c.Type == System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            }
            catch
            {
                return Unauthorized();
            }
        }
        else
        {
            userId = UserId;
        }

        if (string.IsNullOrEmpty(userId)) return Unauthorized();
        if (!await _perms.IsMemberAsync(serverId, userId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        var provider = _providerFactory.GetProvider(connection.ProviderType);
        if (provider == null) return BadRequest("Unsupported provider");

        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var playback = await provider.GetPlaybackInfoAsync(configJson, itemId);
        if (playback == null) return NotFound();

        // Create HTTP request to Plex with auth token
        using var httpClient = new HttpClient();
        var request = new HttpRequestMessage(HttpMethod.Get, playback.Url);

        // Forward range header for seeking support
        if (Request.Headers.ContainsKey("Range"))
        {
            var rangeHeader = Request.Headers["Range"].ToString();
            request.Headers.TryAddWithoutValidation("Range", rangeHeader);
        }

        // Add any custom headers from the provider
        foreach (var header in playback.Headers)
        {
            request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        try
        {
            var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

            if (!response.IsSuccessStatusCode)
            {
                return StatusCode((int)response.StatusCode);
            }

            // Forward response headers
            Response.ContentType = playback.ContentType;
            if (response.Content.Headers.ContentLength.HasValue)
            {
                Response.ContentLength = response.Content.Headers.ContentLength.Value;
            }

            // Support range requests for seeking
            if (response.StatusCode == System.Net.HttpStatusCode.PartialContent)
            {
                Response.StatusCode = 206;
                if (response.Content.Headers.ContentRange != null)
                {
                    Response.Headers["Content-Range"] = response.Content.Headers.ContentRange.ToString();
                }
            }

            Response.Headers["Accept-Ranges"] = "bytes";

            // Stream the content
            await using var stream = await response.Content.ReadAsStreamAsync();
            await stream.CopyToAsync(Response.Body);

            return new EmptyResult();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error proxying stream: {ex.Message}");
            return StatusCode(500, "Failed to stream content");
        }
    }

    [AllowAnonymous]
    [HttpGet("{connectionId}/hls")]
    public async Task<IActionResult> HlsProxy(Guid serverId, Guid connectionId,
        [FromQuery] string path, [FromQuery] string? token = null)
    {
        // Auth check (same pattern as StreamItem)
        string? userId = null;
        if (!string.IsNullOrEmpty(token))
        {
            try
            {
                var tokenHandler = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler();
                var jwtToken = tokenHandler.ReadJwtToken(token);
                userId = jwtToken.Claims.FirstOrDefault(c => c.Type == ClaimTypes.NameIdentifier)?.Value;
            }
            catch { return Unauthorized(); }
        }
        else
        {
            userId = UserId;
        }
        if (string.IsNullOrEmpty(userId)) return Unauthorized();
        if (!await _perms.IsMemberAsync(serverId, userId)) return Forbid();

        var connection = await _db.MediaProviderConnections
            .FirstOrDefaultAsync(c => c.Id == connectionId && c.ServerId == serverId);
        if (connection == null) return NotFound();

        // Parse Plex server URL from connection config
        var configJson = _protector.Decrypt(connection.ProviderConfigJson);
        var configDoc = JsonDocument.Parse(configJson);
        var serverUrl = configDoc.RootElement.GetProperty("serverUrl").GetString()!.TrimEnd('/');
        var plexToken = configDoc.RootElement.GetProperty("authToken").GetString()!;

        // Build full Plex URL — append token if not already present
        var plexUrl = $"{serverUrl}{path}";
        if (!plexUrl.Contains("X-Plex-Token"))
            plexUrl += (plexUrl.Contains('?') ? "&" : "?") + $"X-Plex-Token={plexToken}";

        using var httpClient = new HttpClient();
        try
        {
            var response = await httpClient.GetAsync(plexUrl, HttpCompletionOption.ResponseHeadersRead);
            var responseContentType = response.Content.Headers.ContentType?.MediaType ?? "";

            if (!response.IsSuccessStatusCode)
                return StatusCode((int)response.StatusCode);

            // If this is an m3u8 playlist, rewrite URLs to go through our proxy
            if (path.Contains(".m3u8") || responseContentType.Contains("mpegurl"))
            {
                var content = await response.Content.ReadAsStringAsync();
                var proxyBase = $"/api/servers/{serverId}/media-providers/{connectionId}/hls";
                var rewritten = RewriteM3u8Urls(content, path, proxyBase, token);
                return Content(rewritten, "application/vnd.apple.mpegurl");
            }

            // Stream binary content (ts segments, init segments, etc.)
            Response.ContentType = responseContentType.Length > 0 ? responseContentType : "video/mp2t";
            if (response.Content.Headers.ContentLength.HasValue)
                Response.ContentLength = response.Content.Headers.ContentLength.Value;

            await using var stream = await response.Content.ReadAsStreamAsync();
            await stream.CopyToAsync(Response.Body);
            return new EmptyResult();
        }
        catch
        {
            return StatusCode(500, "Failed to proxy HLS content");
        }
    }

    private static string RewriteM3u8Urls(string content, string playlistPlexPath,
        string proxyBase, string? jwtToken)
    {
        // Get the "directory" of the playlist path for resolving relative URLs
        var pathWithoutQuery = playlistPlexPath.Contains('?')
            ? playlistPlexPath[..playlistPlexPath.IndexOf('?')]
            : playlistPlexPath;
        var baseDir = pathWithoutQuery.Contains('/')
            ? pathWithoutQuery[..pathWithoutQuery.LastIndexOf('/')]
            : "";

        var lines = content.Split('\n');
        var sb = new StringBuilder();

        foreach (var line in lines)
        {
            var trimmed = line.TrimEnd('\r');

            if (string.IsNullOrWhiteSpace(trimmed))
            {
                sb.Append(trimmed).Append('\n');
                continue;
            }

            // Rewrite URI attributes in tags (e.g., #EXT-X-MAP:URI="init.mp4")
            if (trimmed.StartsWith('#'))
            {
                var rewritten = Regex.Replace(trimmed, @"URI=""([^""]+)""", m =>
                {
                    var resolved = ResolveSegmentPath(m.Groups[1].Value, baseDir);
                    var proxyUrl = BuildProxySegmentUrl(proxyBase, resolved, jwtToken);
                    return $"URI=\"{proxyUrl}\"";
                });
                sb.Append(rewritten).Append('\n');
                continue;
            }

            // Non-comment line = segment URL
            var resolvedPath = ResolveSegmentPath(trimmed, baseDir);
            sb.Append(BuildProxySegmentUrl(proxyBase, resolvedPath, jwtToken)).Append('\n');
        }

        return sb.ToString();
    }

    private static string ResolveSegmentPath(string url, string baseDir)
    {
        if (url.StartsWith("http://") || url.StartsWith("https://"))
        {
            var uri = new Uri(url);
            return uri.PathAndQuery;
        }
        if (url.StartsWith('/'))
            return url;

        // Relative — resolve against playlist directory
        return $"{baseDir}/{url}";
    }

    private static string BuildProxySegmentUrl(string proxyBase, string plexPath, string? jwtToken)
    {
        var proxyUrl = $"{proxyBase}?path={Uri.EscapeDataString(plexPath)}";
        if (!string.IsNullOrEmpty(jwtToken))
            proxyUrl += $"&token={Uri.EscapeDataString(jwtToken)}";
        return proxyUrl;
    }

    private static MediaItemDto MapToDto(MediaItem item) => new(
        item.Id, item.Title, item.Type, item.Summary, item.ThumbnailUrl,
        item.DurationMs, item.Year, item.ParentTitle, item.GrandparentTitle,
        item.Index, item.ParentIndex);
}
