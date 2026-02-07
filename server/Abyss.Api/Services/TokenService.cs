using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public class TokenService
{
    public string CreateToken(AppUser user)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id),
            new(ClaimTypes.Name, user.UserName!),
            new("displayName", user.DisplayName)
        };

        var sysadminUsername = Environment.GetEnvironmentVariable("SYSADMIN_USERNAME");
        if (!string.IsNullOrWhiteSpace(sysadminUsername)
            && string.Equals(user.UserName, sysadminUsername, StringComparison.OrdinalIgnoreCase))
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
            expires: DateTime.UtcNow.AddDays(7),
            signingCredentials: creds
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
