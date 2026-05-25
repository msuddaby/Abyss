using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.IdentityModel.Tokens;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

public record XenForoConnectionDto(string XfUsername, int XfUserId, DateTime LinkedAt);
public record CreateForumTopicRequest(Guid StartMessageId, Guid EndMessageId, int NodeId, string Title);
public record CreateForumTopicResponse(int ThreadId, string Url);
public record SubscribeMirrorRequest(int NodeId, string? Title);
public record WebhookEnvelope(string Event, string EventId, XfPostEvent Data);

[ApiController]
[Route("api/xenforo")]
public class XenForoController : ControllerBase
{
    private const int MaxMessagesPerTopic = 100;
    private static readonly TimeSpan LinkNonceTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan NodesCacheTtl = TimeSpan.FromMinutes(5);
    private const string NodesCacheKey = "xenforo:nodes";

    private readonly AppDbContext _db;
    private readonly PermissionService _perms;
    private readonly XenForoBridgeService _bridge;
    private readonly XenForoMirrorService _mirror;
    private readonly IMemoryCache _cache;
    private readonly IHubContext<ChatHub> _hub;
    private readonly ILogger<XenForoController> _logger;

    public XenForoController(
        AppDbContext db,
        PermissionService perms,
        XenForoBridgeService bridge,
        XenForoMirrorService mirror,
        IMemoryCache cache,
        IHubContext<ChatHub> hub,
        ILogger<XenForoController> logger)
    {
        _db = db;
        _perms = perms;
        _bridge = bridge;
        _mirror = mirror;
        _cache = cache;
        _hub = hub;
        _logger = logger;
    }

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;
    private static string LinkNonceKey(string nonce) => $"xenforo:link-nonce:{nonce}";

    // ─── Connection management ────────────────────────────────────────────

    [Authorize]
    [HttpGet("connection")]
    public async Task<ActionResult<XenForoConnectionDto>> GetConnection()
    {
        var conn = await _db.XenForoConnections.AsNoTracking().FirstOrDefaultAsync(c => c.OwnerId == UserId);
        if (conn == null) return NotFound();
        return new XenForoConnectionDto(conn.XfUsername, conn.XfUserId, conn.LinkedAt);
    }

    [Authorize]
    [HttpDelete("connection")]
    public async Task<IActionResult> Unlink()
    {
        var conn = await _db.XenForoConnections.FirstOrDefaultAsync(c => c.OwnerId == UserId);
        if (conn != null)
        {
            _db.XenForoConnections.Remove(conn);
            await _db.SaveChangesAsync();
        }
        return NoContent();
    }

    // ─── Link flow (browser redirect) ─────────────────────────────────────
    //
    // 1. Abyss client opens /api/xenforo/link/start in a new tab.
    // 2. Abyss redirects to {XF}/abyss/link/start?nonce=N&return_url=R.
    // 3. XF authenticates the user, signs a JWT, redirects to /api/xenforo/link/callback?token=...
    // 4. Abyss verifies the JWT (against the nonce in IMemoryCache) and stores XenForoConnection.

    [Authorize]
    [HttpGet("link/start")]
    public IActionResult LinkStart([FromQuery(Name = "return")] string? clientReturnUrl)
    {
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);

        var nonce = Guid.NewGuid().ToString("N");
        _cache.Set(
            LinkNonceKey(nonce),
            new LinkNoncePayload(UserId, clientReturnUrl ?? "/"),
            new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = LinkNonceTtl, Size = 1 });

        var callback = Url.Action(nameof(LinkCallback), "XenForo", null, Request.Scheme, Request.Host.Value)!;
        var target = $"{_bridge.BaseUrl}/abyss-link/start"
            + $"?nonce={Uri.EscapeDataString(nonce)}"
            + $"&return_url={Uri.EscapeDataString(callback)}";
        return Redirect(target);
    }

    [AllowAnonymous]
    [HttpGet("link/callback")]
    public async Task<IActionResult> LinkCallback([FromQuery] string token)
    {
        if (string.IsNullOrEmpty(token)) return BadRequest("Missing token");
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);

        // Identity for this request comes from the nonce payload (cached when the
        // authenticated user called LinkStart). The JWT proves the XF identity.
        int xfUserId;
        string xfUsername;
        string nonce;
        try
        {
            var handler = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler();
            var jwt = handler.ReadJwtToken(token);
            nonce = jwt.Claims.FirstOrDefault(c => c.Type == "abyss_link_nonce")?.Value ?? string.Empty;
            if (string.IsNullOrEmpty(nonce)) return BadRequest("Token missing nonce");

            (xfUserId, xfUsername) = _bridge.VerifyLinkJwt(token, nonce);
        }
        catch (SecurityTokenException ex)
        {
            _logger.LogWarning("Link JWT validation failed: {Message}", ex.Message);
            return BadRequest("Invalid token");
        }

        if (!_cache.TryGetValue<LinkNoncePayload>(LinkNonceKey(nonce), out var payload) || payload == null)
            return BadRequest("Nonce expired or unknown");
        _cache.Remove(LinkNonceKey(nonce));

        var ownerId = payload.AbyssUserId;
        var existing = await _db.XenForoConnections.FirstOrDefaultAsync(c => c.OwnerId == ownerId);
        if (existing == null)
        {
            _db.XenForoConnections.Add(new XenForoConnection
            {
                OwnerId = ownerId,
                XfUserId = xfUserId,
                XfUsername = xfUsername,
                LinkedAt = DateTime.UtcNow,
            });
        }
        else
        {
            existing.XfUserId = xfUserId;
            existing.XfUsername = xfUsername;
            existing.LinkedAt = DateTime.UtcNow;
        }
        await _db.SaveChangesAsync();

        var clientReturn = string.IsNullOrEmpty(payload.ClientReturnUrl) ? "/" : payload.ClientReturnUrl;
        var sep = clientReturn.Contains('?') ? '&' : '?';
        return Redirect($"{clientReturn}{sep}linked=1");
    }

    // Lightweight HTML success page used as the link-flow return target for
    // desktop clients. The Electron window's window.location.origin isn't a
    // scheme an external browser can navigate to, so we land here instead and
    // tell the user to return to the app — the app refetches on focus.
    [AllowAnonymous]
    [HttpGet("link/done")]
    public ContentResult LinkDone()
    {
        const string html = """
            <!doctype html>
            <html><head><meta charset="utf-8"><title>Linked</title>
            <style>
              html,body{height:100%;margin:0;background:#1e1f22;color:#e3e5e8;font-family:system-ui,sans-serif}
              .wrap{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:.5rem;padding:1rem;text-align:center}
              h1{margin:0;font-size:1.25rem;font-weight:600}
              p{margin:0;color:#b5bac1}
            </style></head>
            <body><div class="wrap">
              <h1>XenForo account linked</h1>
              <p>You can close this tab and return to Abyss.</p>
            </div></body></html>
            """;
        return new ContentResult { Content = html, ContentType = "text/html; charset=utf-8", StatusCode = 200 };
    }

    // ─── Claim flow (Abyss issues a signed JWT for the XF addon to verify) ─

    [Authorize]
    [HttpGet("claim/start")]
    public IActionResult ClaimStart([FromQuery] string nonce, [FromQuery(Name = "return_url")] string returnUrl)
    {
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);
        if (string.IsNullOrWhiteSpace(nonce) || string.IsNullOrWhiteSpace(returnUrl))
            return BadRequest("nonce and return_url are required");

        // Only allow returning to the configured XenForo base URL
        if (!returnUrl.StartsWith(_bridge.BaseUrl + "/", StringComparison.Ordinal)
            && !string.Equals(returnUrl, _bridge.BaseUrl, StringComparison.Ordinal))
            return BadRequest("return_url is not on the configured XenForo host");

        var jwt = _bridge.SignClaimJwt(UserId, nonce);
        var sep = returnUrl.Contains('?') ? '&' : '?';
        return Redirect($"{returnUrl}{sep}token={Uri.EscapeDataString(jwt)}");
    }

    // ─── Node listing (proxied) ───────────────────────────────────────────

    [Authorize]
    [HttpGet("nodes")]
    public async Task<ActionResult<IReadOnlyList<XenForoNodeDto>>> GetNodes(CancellationToken ct)
    {
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);

        if (_cache.TryGetValue<IReadOnlyList<XenForoNodeDto>>(NodesCacheKey, out var cached) && cached != null)
            return Ok(cached);

        try
        {
            var nodes = await _bridge.GetNodesAsync(ct);
            _cache.Set(
                NodesCacheKey,
                nodes,
                new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = NodesCacheTtl, Size = 1 });
            return Ok(nodes);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Failed to fetch XenForo nodes");
            return Problem("Failed to reach XenForo", statusCode: 502);
        }
    }

    // ─── Topic creation ───────────────────────────────────────────────────

    [Authorize]
    [HttpPost("/api/channels/{channelId:guid}/forum-topic")]
    public async Task<ActionResult<CreateForumTopicResponse>> CreateTopic(Guid channelId, CreateForumTopicRequest req, CancellationToken ct)
    {
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);

        if (string.IsNullOrWhiteSpace(req.Title)) return BadRequest("Title is required");
        if (req.Title.Length > 100) return BadRequest("Title must be 100 characters or fewer");
        if (req.StartMessageId == Guid.Empty || req.EndMessageId == Guid.Empty)
            return BadRequest("StartMessageId and EndMessageId are required");

        var channel = await _db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId, ct);
        if (channel == null) return NotFound("Channel not found");
        if (channel.ServerId == null) return BadRequest("Forum topics can only be created from server channels");

        if (!await _perms.HasChannelPermissionAsync(channelId, UserId, Permission.CreateForumTopic))
            return Forbid();

        var creatorConn = await _db.XenForoConnections.AsNoTracking().FirstOrDefaultAsync(c => c.OwnerId == UserId, ct);
        if (creatorConn == null) return BadRequest("You must link your XenForo account first");

        var start = await _db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == req.StartMessageId, ct);
        var end = await _db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == req.EndMessageId, ct);
        if (start == null || end == null) return NotFound("Start or end message not found");
        if (start.ChannelId != channelId || end.ChannelId != channelId)
            return BadRequest("Both messages must be in the target channel");

        var (lo, hi) = start.CreatedAt <= end.CreatedAt ? (start.CreatedAt, end.CreatedAt) : (end.CreatedAt, start.CreatedAt);

        var messages = await _db.Messages
            .AsNoTracking()
            .Where(m => m.ChannelId == channelId && !m.IsDeleted && !m.IsSystem
                && m.CreatedAt >= lo && m.CreatedAt <= hi)
            .OrderBy(m => m.CreatedAt)
            .Include(m => m.Attachments)
            .ToListAsync(ct);

        if (messages.Count == 0) return BadRequest("No messages in the selected range");
        if (messages.Count > MaxMessagesPerTopic)
            return BadRequest($"Selection exceeds the maximum of {MaxMessagesPerTopic} messages");

        // Batch-load authors and their XF links
        var authorIds = messages.Select(m => m.AuthorId).Distinct().ToList();
        var authors = await _db.Users.AsNoTracking()
            .Where(u => authorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, ct);
        var links = await _db.XenForoConnections.AsNoTracking()
            .Where(c => authorIds.Contains(c.OwnerId))
            .ToDictionaryAsync(c => c.OwnerId, ct);

        var apiBase = $"{Request.Scheme}://{Request.Host.Value}";
        var posts = _bridge.MessagesToBridgePosts(messages, links, authors, apiBase);
        if (posts.Count == 0) return BadRequest("No postable messages in the selected range");

        // Force the first post to be the creator's, regardless of original author —
        // the thread OP needs a real XF user as owner for moderation/notifications.
        posts[0] = posts[0] with { Mode = "real", XfUserId = creatorConn.XfUserId, AbyssUserId = null, DisplayName = null, AvatarUrl = null };

        CreateThreadResult result;
        try
        {
            result = await _bridge.CreateThreadAsync(req.NodeId, req.Title, posts, ct);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Forum thread creation failed");
            return Problem("XenForo rejected the request: " + ex.Message, statusCode: 502);
        }

        // Audit log (server channels only)
        var details = JsonSerializer.Serialize(new
        {
            channelId,
            startMessageId = req.StartMessageId,
            endMessageId = req.EndMessageId,
            messageCount = messages.Count,
            nodeId = req.NodeId,
            threadId = result.ThreadId,
            url = result.Url,
        });
        await _perms.LogAsync(channel.ServerId.Value, AuditAction.ForumTopicCreated, UserId,
            targetName: req.Title, details: details);

        return Ok(new CreateForumTopicResponse(result.ThreadId, result.Url));
    }

    // ─── Live-mirror subscriptions (per channel) ──────────────────────────

    [Authorize]
    [HttpPost("/api/channels/{channelId:guid}/xenforo-mirror")]
    public async Task<ActionResult<ChannelDto>> SetMirror(Guid channelId, SubscribeMirrorRequest req, CancellationToken ct)
    {
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);
        if (req.NodeId <= 0) return BadRequest("nodeId is required");

        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId, ct);
        if (channel == null) return NotFound("Channel not found");
        if (channel.ServerId == null) return BadRequest("Only server channels can mirror a XenForo node");
        if (!await _perms.HasPermissionAsync(channel.ServerId.Value, UserId, Permission.ManageChannels)) return Forbid();

        channel.Type = ChannelType.XenForoMirror;
        channel.XenForoNodeId = req.NodeId;
        channel.XenForoNodeTitle = string.IsNullOrWhiteSpace(req.Title) ? null : req.Title!.Trim();
        await _db.SaveChangesAsync(ct);

        var dto = new ChannelDto(channel.Id, channel.Name, channel.Type.ToString(), channel.ServerId, channel.Position,
            null, channel.PersistentChat, channel.UserLimit, channel.RssFeedUrl, channel.RssRefreshIntervalMinutes,
            channel.XenForoNodeId, channel.XenForoNodeTitle);
        // Triggers a channel refetch on every connected client so the new type
        // + per-user permissions are picked up (sidebar filters on permissions).
        await _hub.Clients.Group($"server:{channel.ServerId}").SendAsync(
            "ChannelUpdated", channel.ServerId.ToString(), dto, ct);
        return Ok(dto);
    }

    [Authorize]
    [HttpDelete("/api/channels/{channelId:guid}/xenforo-mirror")]
    public async Task<IActionResult> RemoveMirror(Guid channelId, CancellationToken ct)
    {
        var channel = await _db.Channels.FirstOrDefaultAsync(c => c.Id == channelId, ct);
        if (channel == null) return NotFound();
        if (channel.ServerId == null) return BadRequest();
        if (!await _perms.HasPermissionAsync(channel.ServerId.Value, UserId, Permission.ManageChannels)) return Forbid();
        if (channel.Type != ChannelType.XenForoMirror) return NoContent();

        channel.Type = ChannelType.Text;
        channel.XenForoNodeId = null;
        channel.XenForoNodeTitle = null;
        await _db.SaveChangesAsync(ct);

        var dto = new ChannelDto(channel.Id, channel.Name, channel.Type.ToString(), channel.ServerId, channel.Position,
            null, channel.PersistentChat, channel.UserLimit, channel.RssFeedUrl, channel.RssRefreshIntervalMinutes,
            null, null);
        await _hub.Clients.Group($"server:{channel.ServerId}").SendAsync(
            "ChannelUpdated", channel.ServerId.ToString(), dto, ct);
        return NoContent();
    }

    // ─── Webhook (from the XF addon) ──────────────────────────────────────

    [AllowAnonymous]
    [HttpPost("webhook")]
    public async Task<IActionResult> Webhook(CancellationToken ct)
    {
        if (!_bridge.IsConfigured) return Problem("XenForo bridge not configured.", statusCode: 503);

        Request.EnableBuffering();
        Request.Body.Position = 0;
        string raw;
        using (var reader = new StreamReader(Request.Body, Encoding.UTF8, leaveOpen: true))
        {
            raw = await reader.ReadToEndAsync(ct);
        }
        Request.Body.Position = 0;

        var sigHeader = Request.Headers["X-Abyss-Signature"].FirstOrDefault();
        if (!_bridge.VerifyWebhookSignature(raw, sigHeader))
        {
            _logger.LogWarning("Rejected XF webhook: invalid HMAC signature");
            return Unauthorized();
        }

        WebhookEnvelope? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<WebhookEnvelope>(raw, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            });
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "XF webhook body could not be parsed");
            return BadRequest("Invalid JSON");
        }
        if (envelope == null) return BadRequest("Empty envelope");

        // Idempotency: drop replays of the same event_id within 5 minutes.
        var eventId = string.IsNullOrWhiteSpace(envelope.EventId)
            ? $"{envelope.Event}:{envelope.Data?.XfPostId}"
            : envelope.EventId;
        var cacheKey = $"xenforo:webhook-event:{eventId}";
        if (_cache.TryGetValue(cacheKey, out _)) return Ok();
        _cache.Set(cacheKey, true, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5),
            Size = 1,
        });

        try
        {
            if (envelope.Data == null) return BadRequest("Missing data");

            switch (envelope.Event)
            {
                case "post.created":
                    await _mirror.HandlePostCreatedAsync(envelope.Data, ct);
                    break;
                case "post.updated":
                    await _mirror.HandlePostUpdatedAsync(envelope.Data, ct);
                    break;
                case "post.deleted":
                    await _mirror.HandlePostDeletedAsync(envelope.Data.XfPostId, ct);
                    break;
                default:
                    _logger.LogInformation("Unhandled XF webhook event: {Event}", envelope.Event);
                    break;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "XF webhook handler failed for event {Event}", envelope.Event);
            return Problem("Webhook handler failed", statusCode: 500);
        }

        return Ok();
    }

    private record LinkNoncePayload(string AbyssUserId, string ClientReturnUrl);
}
