using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.IdentityModel.Tokens;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public record BridgePost(
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("xf_user_id")] int? XfUserId,
    [property: JsonPropertyName("abyss_user_id")] string? AbyssUserId,
    [property: JsonPropertyName("display_name")] string? DisplayName,
    [property: JsonPropertyName("avatar_url")] string? AvatarUrl,
    [property: JsonPropertyName("bbcode")] string Bbcode);

public record XenForoNodeDto(int NodeId, string Title, string NodeType, int? ParentNodeId);

public record CreateThreadResult(int ThreadId, string Url);

/// <summary>
/// Bridges Abyss → XenForo via the AbyssBridge XF addon.
/// Identity flows (link/claim) use shared-secret JWTs; server-to-server posting
/// uses the XF super-user API key on the addon's /api/abyss/threads endpoint.
/// </summary>
public class XenForoBridgeService
{
    private readonly HttpClient _http;
    private readonly ILogger<XenForoBridgeService> _logger;
    private readonly string _baseUrl;
    private readonly string _adminApiKey;
    private readonly string _adminUserId;
    private readonly byte[] _sharedSecret;

    public bool IsConfigured => !string.IsNullOrEmpty(_baseUrl)
        && !string.IsNullOrEmpty(_adminApiKey)
        && _sharedSecret.Length > 0;

    public string BaseUrl => _baseUrl;

    public XenForoBridgeService(HttpClient http, ILogger<XenForoBridgeService> logger)
    {
        _http = http;
        _logger = logger;
        _baseUrl = (Environment.GetEnvironmentVariable("XENFORO_BASE_URL") ?? string.Empty).TrimEnd('/');
        _adminApiKey = Environment.GetEnvironmentVariable("XENFORO_ADMIN_API_KEY") ?? string.Empty;
        // Super-user API keys act as Guest unless XF-Api-User is set, which means
        // forums hidden from unregistered users are filtered out of /api/nodes etc.
        // Default to user_id 1 (the install's original admin).
        _adminUserId = Environment.GetEnvironmentVariable("XENFORO_ADMIN_USER_ID") ?? "1";
        var secret = Environment.GetEnvironmentVariable("XENFORO_SHARED_SECRET") ?? string.Empty;
        _sharedSecret = Encoding.UTF8.GetBytes(secret);
        _http.Timeout = TimeSpan.FromSeconds(15);
    }

    private void AddApiAuthHeaders(HttpRequestMessage req)
    {
        req.Headers.Add("XF-Api-Key", _adminApiKey);
        req.Headers.Add("XF-Api-User", _adminUserId);
    }

    // ─── XF API calls ─────────────────────────────────────────────────────

    public async Task<IReadOnlyList<XenForoNodeDto>> GetNodesAsync(CancellationToken ct = default)
    {
        EnsureConfigured();
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{_baseUrl}/api/nodes");
        AddApiAuthHeaders(req);

        using var res = await _http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

        var nodes = new List<XenForoNodeDto>();
        if (doc.RootElement.TryGetProperty("nodes", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var n in arr.EnumerateArray())
            {
                var type = n.TryGetProperty("node_type_id", out var t) ? t.GetString() ?? string.Empty : string.Empty;
                if (!string.Equals(type, "Forum", StringComparison.OrdinalIgnoreCase)) continue;

                var id = n.TryGetProperty("node_id", out var idEl) ? idEl.GetInt32() : 0;
                var title = n.TryGetProperty("title", out var tl) ? tl.GetString() ?? string.Empty : string.Empty;
                int? parent = n.TryGetProperty("parent_node_id", out var p) && p.ValueKind == JsonValueKind.Number
                    ? p.GetInt32() : null;
                if (id > 0) nodes.Add(new XenForoNodeDto(id, title, type, parent));
            }
        }
        return nodes;
    }

    public async Task<CreateThreadResult> CreateThreadAsync(int nodeId, string title, IReadOnlyList<BridgePost> posts, CancellationToken ct = default)
    {
        EnsureConfigured();
        if (posts.Count == 0) throw new InvalidOperationException("CreateThreadAsync requires at least one post");

        var payload = new
        {
            node_id = nodeId,
            title,
            posts
        };

        using var req = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/abyss-threads")
        {
            Content = JsonContent.Create(payload)
        };
        AddApiAuthHeaders(req);

        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            _logger.LogWarning("XenForo /api/abyss/threads returned {Status}: {Body}", res.StatusCode, body);
            throw new HttpRequestException($"XenForo rejected thread creation ({(int)res.StatusCode}): {body}");
        }

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var threadId = doc.RootElement.TryGetProperty("thread_id", out var ti) ? ti.GetInt32() : 0;
        var url = doc.RootElement.TryGetProperty("url", out var u) ? u.GetString() ?? string.Empty : string.Empty;
        return new CreateThreadResult(threadId, url);
    }

    // ─── BBCode conversion ────────────────────────────────────────────────

    public List<BridgePost> MessagesToBridgePosts(
        IEnumerable<Message> messages,
        IReadOnlyDictionary<string, XenForoConnection> linkedAuthors,
        IReadOnlyDictionary<string, AppUser> authorsById,
        string apiBase)
    {
        var posts = new List<BridgePost>();
        foreach (var m in messages)
        {
            if (!authorsById.TryGetValue(m.AuthorId, out var author)) continue;
            var bbcode = MessageToBBCode(m, authorsById, apiBase);

            if (linkedAuthors.TryGetValue(m.AuthorId, out var conn))
            {
                posts.Add(new BridgePost("real", conn.XfUserId, null, null, null, bbcode));
            }
            else
            {
                posts.Add(new BridgePost(
                    "ghost",
                    null,
                    author.Id,
                    string.IsNullOrWhiteSpace(author.DisplayName) ? (author.UserName ?? "Unknown") : author.DisplayName,
                    AbsoluteUrl(apiBase, author.AvatarUrl),
                    bbcode));
            }
        }
        return posts;
    }

    public static string MessageToBBCode(Message m, IReadOnlyDictionary<string, AppUser> authorsById, string apiBase)
    {
        var sb = new StringBuilder();
        sb.Append($"[SIZE=2][I]Posted on {m.CreatedAt:yyyy-MM-dd HH:mm} UTC[/I][/SIZE]\n\n");

        var content = m.Content ?? string.Empty;
        content = ConvertMarkdownToBBCode(content);
        content = ConvertCustomEmoji(content, apiBase);
        content = ConvertMentions(content, authorsById);
        sb.Append(content);

        if (m.Attachments != null && m.Attachments.Count > 0)
        {
            sb.Append("\n\n");
            foreach (var a in m.Attachments)
            {
                var url = AbsoluteUrl(apiBase, a.FilePath);
                if (string.IsNullOrEmpty(url)) continue;
                if (!string.IsNullOrEmpty(a.ContentType) && a.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                    sb.Append($"[IMG]{url}[/IMG]\n");
                else
                    sb.Append($"[URL={url}]{a.FileName}[/URL]\n");
            }
        }

        return sb.ToString().TrimEnd();
    }

    private static readonly Regex FencedCode = new(@"```(?:\w+)?\n?(.*?)```", RegexOptions.Singleline | RegexOptions.Compiled);
    private static readonly Regex InlineCode = new(@"`([^`\n]+)`", RegexOptions.Compiled);
    private static readonly Regex Bold = new(@"\*\*(.+?)\*\*", RegexOptions.Compiled);
    private static readonly Regex Italic = new(@"(?<![\*_])\*([^\*\n]+?)\*(?![\*_])", RegexOptions.Compiled);
    private static readonly Regex Strike = new(@"~~(.+?)~~", RegexOptions.Compiled);
    private static readonly Regex CustomEmojiRx = new(@"<:([a-zA-Z0-9_]+):([0-9a-fA-F\-]+)>", RegexOptions.Compiled);
    private static readonly Regex MentionRx = new(@"<@([a-zA-Z0-9\-]+)>", RegexOptions.Compiled);

    private static string ConvertMarkdownToBBCode(string s)
    {
        // Protect fenced code by extracting first
        var blocks = new List<string>();
        s = FencedCode.Replace(s, m =>
        {
            blocks.Add(m.Groups[1].Value);
            return $"\x00BLOCK{blocks.Count - 1}\x00";
        });

        s = Bold.Replace(s, "[B]$1[/B]");
        s = Italic.Replace(s, "[I]$1[/I]");
        s = Strike.Replace(s, "[S]$1[/S]");
        s = InlineCode.Replace(s, "[ICODE]$1[/ICODE]");

        // Re-insert fenced code blocks as [CODE]...[/CODE]
        for (int i = 0; i < blocks.Count; i++)
        {
            s = s.Replace($"\x00BLOCK{i}\x00", $"[CODE]{blocks[i]}[/CODE]");
        }
        return s;
    }

    private static string ConvertCustomEmoji(string s, string apiBase)
    {
        return CustomEmojiRx.Replace(s, m =>
        {
            var id = m.Groups[2].Value;
            return $"[IMG]{apiBase.TrimEnd('/')}/api/emojis/{id}/image[/IMG]";
        });
    }

    private static string ConvertMentions(string s, IReadOnlyDictionary<string, AppUser> authorsById)
    {
        return MentionRx.Replace(s, m =>
        {
            var uid = m.Groups[1].Value;
            if (authorsById.TryGetValue(uid, out var u))
            {
                var name = string.IsNullOrWhiteSpace(u.DisplayName) ? (u.UserName ?? "user") : u.DisplayName;
                return $"@{name}";
            }
            return "@user";
        });
    }

    private static string AbsoluteUrl(string apiBase, string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return string.Empty;
        if (path.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || path.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return path;
        var trimmedBase = apiBase.TrimEnd('/');
        var trimmedPath = path.StartsWith('/') ? path : "/" + path;
        return trimmedBase + trimmedPath;
    }

    // ─── JWT helpers (shared secret) ──────────────────────────────────────

    private const string Issuer = "abyss";
    private const string XfIssuer = "xenforo";

    public string SignClaimJwt(string abyssUserId, string nonce)
    {
        EnsureConfigured();
        var creds = new SigningCredentials(new SymmetricSecurityKey(_sharedSecret), SecurityAlgorithms.HmacSha256);
        var handler = new JwtSecurityTokenHandler();
        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: XfIssuer,
            claims: new[]
            {
                new Claim(JwtRegisteredClaimNames.Sub, abyssUserId),
                new Claim("claim_nonce", nonce),
            },
            notBefore: DateTime.UtcNow.AddSeconds(-5),
            expires: DateTime.UtcNow.AddMinutes(5),
            signingCredentials: creds);
        return handler.WriteToken(token);
    }

    /// <summary>Verifies a link JWT issued by the XF addon. Returns (xfUserId, xfUsername).</summary>
    public (int XfUserId, string XfUsername) VerifyLinkJwt(string token, string expectedNonce)
    {
        EnsureConfigured();
        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var parameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = XfIssuer,
            ValidateAudience = true,
            ValidAudience = Issuer,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(_sharedSecret),
            ClockSkew = TimeSpan.FromSeconds(30),
        };

        var principal = handler.ValidateToken(token, parameters, out _);
        var nonceClaim = principal.FindFirst("abyss_link_nonce")?.Value;
        if (!string.Equals(nonceClaim, expectedNonce, StringComparison.Ordinal))
            throw new SecurityTokenException("nonce mismatch");

        var sub = principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
        if (!int.TryParse(sub, out var xfUserId) || xfUserId <= 0)
            throw new SecurityTokenException("invalid sub");

        var username = principal.FindFirst("xf_username")?.Value ?? string.Empty;
        return (xfUserId, username);
    }

    private void EnsureConfigured()
    {
        if (!IsConfigured)
            throw new InvalidOperationException("XenForo bridge not configured. Set XENFORO_BASE_URL, XENFORO_ADMIN_API_KEY, XENFORO_SHARED_SECRET.");
    }

    // ─── Inbound webhook verification ─────────────────────────────────────

    /// <summary>
    /// Verifies an HMAC-SHA256 signature over the raw webhook body using the
    /// shared secret. Expected header format: "sha256=&lt;hex&gt;".
    /// </summary>
    public bool VerifyWebhookSignature(string rawBody, string? signatureHeader)
    {
        if (_sharedSecret.Length == 0 || string.IsNullOrEmpty(signatureHeader)) return false;
        const string prefix = "sha256=";
        if (!signatureHeader.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        var providedHex = signatureHeader.AsSpan(prefix.Length).Trim();
        if (providedHex.Length != 64) return false;

        Span<byte> provided = stackalloc byte[32];
        for (var i = 0; i < 32; i++)
        {
            if (!byte.TryParse(providedHex.Slice(i * 2, 2), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var b))
                return false;
            provided[i] = b;
        }

        Span<byte> expected = stackalloc byte[32];
        var bodyBytes = Encoding.UTF8.GetBytes(rawBody);
        using var hmac = new HMACSHA256(_sharedSecret);
        hmac.TryComputeHash(bodyBytes, expected, out _);
        return CryptographicOperations.FixedTimeEquals(expected, provided);
    }

    // ─── BBCode → Markdown ────────────────────────────────────────────────

    private static readonly Regex BbCode = new(@"\[CODE(?:=[^\]]*)?\](.*?)\[/CODE\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbICode = new(@"\[ICODE\](.*?)\[/ICODE\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbBold = new(@"\[B\](.+?)\[/B\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbItalic = new(@"\[I\](.+?)\[/I\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbUnderline = new(@"\[U\](.+?)\[/U\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbStrike = new(@"\[S\](.+?)\[/S\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbUrlWithTarget = new(@"\[URL=([^\]]+)\](.*?)\[/URL\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbUrlPlain = new(@"\[URL\](.*?)\[/URL\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbImg = new(@"\[IMG\](.*?)\[/IMG\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbQuoteWithAttrib = new(@"\[QUOTE=""?([^\]""]+?)""?(?:,[^\]]*)?\](.*?)\[/QUOTE\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbQuotePlain = new(@"\[QUOTE\](.*?)\[/QUOTE\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbUser = new(@"\[USER=\d+\]@?([^\[]+?)\[/USER\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbSize = new(@"\[SIZE=[^\]]+\](.*?)\[/SIZE\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbColor = new(@"\[COLOR=[^\]]+\](.*?)\[/COLOR\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbAttach = new(@"\[ATTACH(?:=[^\]]*)?\](\d+)\[/ATTACH\]", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BbUnknownTag = new(@"\[/?[A-Z][A-Z0-9]*(?:=[^\]]*)?\]", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Converts XenForo BBCode to Markdown that the Abyss client understands.
    /// Strips unknown tags. Code blocks are preserved verbatim and protected
    /// from inline conversions.
    /// </summary>
    public static string BbcodeToMarkdown(string? bbcode)
    {
        if (string.IsNullOrEmpty(bbcode)) return string.Empty;
        var s = bbcode;

        // Pull out [CODE] blocks first so their contents aren't mangled by other rules.
        var codeBlocks = new List<string>();
        s = BbCode.Replace(s, m =>
        {
            codeBlocks.Add(m.Groups[1].Value.Trim('\r', '\n'));
            return $"\x00CODE{codeBlocks.Count - 1}\x00";
        });

        // Drop pure-formatting wrappers (size/color) by unwrapping to inner text.
        s = BbSize.Replace(s, "$1");
        s = BbColor.Replace(s, "$1");

        s = BbBold.Replace(s, "**$1**");
        s = BbItalic.Replace(s, "*$1*");
        s = BbUnderline.Replace(s, "__$1__");
        s = BbStrike.Replace(s, "~~$1~~");
        s = BbICode.Replace(s, "`$1`");
        s = BbUrlWithTarget.Replace(s, m =>
        {
            var url = m.Groups[1].Value.Trim();
            var label = m.Groups[2].Value.Trim();
            if (string.IsNullOrEmpty(label) || label == url) return url;
            return $"[{label}]({url})";
        });
        s = BbUrlPlain.Replace(s, "$1");
        s = BbImg.Replace(s, "![]($1)");
        s = BbUser.Replace(s, "@$1");
        s = BbAttach.Replace(s, string.Empty);

        // Quotes — prefix each line with "> " for markdown blockquote style.
        s = BbQuoteWithAttrib.Replace(s, m =>
        {
            var author = m.Groups[1].Value.Trim();
            var inner = m.Groups[2].Value.Trim('\r', '\n');
            return $"> **{author} said:**\n" + PrefixLines(inner, "> ");
        });
        s = BbQuotePlain.Replace(s, m =>
        {
            var inner = m.Groups[1].Value.Trim('\r', '\n');
            return PrefixLines(inner, "> ");
        });

        // Strip remaining unknown tags rather than leaving raw [TAG] text.
        s = BbUnknownTag.Replace(s, string.Empty);

        // Re-insert preserved code blocks as fenced markdown.
        for (var i = 0; i < codeBlocks.Count; i++)
        {
            s = s.Replace($"\x00CODE{i}\x00", $"```\n{codeBlocks[i]}\n```");
        }

        return s.Trim();
    }

    private static string PrefixLines(string text, string prefix)
    {
        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            lines[i] = prefix + lines[i].TrimEnd('\r');
        }
        return string.Join('\n', lines);
    }
}
