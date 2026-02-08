using System.Security.Cryptography;
using System.Text;

namespace Abyss.Api.Services;

public record TurnCredentialResult(
    string[] Urls,
    string Username,
    string Credential,
    int TtlSeconds,
    DateTime ExpiresAtUtc
);

public class TurnCredentialService
{
    private readonly string[] _urls;
    private readonly string _secret;
    private readonly int _ttlSeconds;

    public TurnCredentialService()
    {
        _urls = (Environment.GetEnvironmentVariable("TURN_URLS") ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        _secret = Environment.GetEnvironmentVariable("TURN_AUTH_SECRET")
            ?? throw new InvalidOperationException("TURN_AUTH_SECRET is not configured. Check your .env file.");
        _ttlSeconds = int.TryParse(Environment.GetEnvironmentVariable("TURN_TTL_SECONDS"), out var ttl) && ttl > 0
            ? ttl
            : 3600;
    }

    public TurnCredentialResult Issue(string userId)
    {
        if (_urls.Length == 0)
            throw new InvalidOperationException("TURN_URLS is not configured. Check your .env file.");

        var expiresAt = DateTime.UtcNow.AddSeconds(_ttlSeconds);
        var unixExpiry = ((DateTimeOffset)expiresAt).ToUnixTimeSeconds();
        var username = $"{unixExpiry}:{userId}";
        var credential = ComputeHmacSha1Base64(_secret, username);

        return new TurnCredentialResult(
            _urls,
            username,
            credential,
            _ttlSeconds,
            expiresAt
        );
    }

    private static string ComputeHmacSha1Base64(string secret, string data)
    {
        var keyBytes = Encoding.UTF8.GetBytes(secret);
        var dataBytes = Encoding.UTF8.GetBytes(data);
        using var hmac = new HMACSHA1(keyBytes);
        var hash = hmac.ComputeHash(dataBytes);
        return Convert.ToBase64String(hash);
    }
}
