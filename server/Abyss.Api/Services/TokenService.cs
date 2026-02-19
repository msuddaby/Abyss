using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public class TokenService
{
    private const int DefaultAccessTokenMinutes = 120;

    public string CreateToken(AppUser user)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id),
            new(ClaimTypes.Name, user.UserName!),
            new("displayName", user.DisplayName)
        };

        if (user.IsGuest)
        {
            claims.Add(new Claim("isGuest", "true"));
        }

        var sysadminUsername = Environment.GetEnvironmentVariable("SYSADMIN_USERNAME");
        if (!string.IsNullOrWhiteSpace(sysadminUsername)
            && string.Equals(user.UserName, sysadminUsername, StringComparison.Ordinal))
        {
            claims.Add(new Claim("sysadmin", "true"));
        }

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(
            Environment.GetEnvironmentVariable("JWT_KEY")
                ?? throw new InvalidOperationException("JWT_KEY is not configured. Check your .env file.")));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha512Signature);

        var token = new JwtSecurityToken(
            issuer: Environment.GetEnvironmentVariable("JWT_ISSUER") ?? "Abyss",
            audience: Environment.GetEnvironmentVariable("JWT_AUDIENCE") ?? "Abyss",
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(GetAccessTokenLifetimeMinutes()),
            signingCredentials: creds
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static int GetAccessTokenLifetimeMinutes()
    {
        var value = Environment.GetEnvironmentVariable("JWT_EXPIRES_MINUTES");
        return int.TryParse(value, out var minutes) && minutes > 0 ? minutes : DefaultAccessTokenMinutes;
    }

    private const int DefaultRefreshTokenDays = 30;

    public static RefreshToken CreateRefreshToken(AppUser user, out string rawToken)
    {
        rawToken = GenerateRefreshToken();
        return new RefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = HashToken(rawToken),
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddDays(GetRefreshTokenLifetimeDays())
        };
    }

    public static string GenerateRefreshToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(64);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    public static string HashToken(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToBase64String(bytes);
    }

    private static int GetRefreshTokenLifetimeDays()
    {
        var value = Environment.GetEnvironmentVariable("REFRESH_TOKEN_DAYS");
        return int.TryParse(value, out var days) && days > 0 ? days : DefaultRefreshTokenDays;
    }
}
