using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly UserManager<AppUser> _userManager;
    private readonly SignInManager<AppUser> _signInManager;
    private readonly TokenService _tokenService;
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly AppDbContext _db;
    private readonly ImageService _imageService;
    private readonly CosmeticService _cosmeticService;
    private const string InviteOnlyKey = "InviteOnly";
    private const int DefaultRefreshTokenDays = 30;

    public AuthController(
        UserManager<AppUser> userManager,
        SignInManager<AppUser> signInManager,
        TokenService tokenService,
        IHubContext<ChatHub> hubContext,
        AppDbContext db,
        ImageService imageService,
        CosmeticService cosmeticService)
    {
        _userManager = userManager;
        _signInManager = signInManager;
        _tokenService = tokenService;
        _hubContext = hubContext;
        _db = db;
        _cosmeticService = cosmeticService;
        _imageService = imageService;
    }

    private static readonly Regex EmailRegex = new(@"^[^@\s]+@[^@\s]+\.[^@\s]+$", RegexOptions.Compiled);

    [HttpPost("register")]
    [EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Register(RegisterRequest request)
    {
        if (!string.IsNullOrWhiteSpace(request.Email) && !EmailRegex.IsMatch(request.Email))
            return BadRequest("Invalid email format.");

        Models.InviteCode? invite = null;
        if (await IsInviteOnlyAsync())
        {
            if (string.IsNullOrWhiteSpace(request.InviteCode))
                return BadRequest("Invite code required.");

            invite = await _db.InviteCodes.FirstOrDefaultAsync(i => i.Code == request.InviteCode);
            if (invite == null) return BadRequest("Invalid invite code.");
            if (invite.ExpiresAt.HasValue && invite.ExpiresAt.Value < DateTime.UtcNow)
                return BadRequest("Invite code expired.");
            if (invite.MaxUses.HasValue && invite.Uses >= invite.MaxUses.Value)
                return BadRequest("Invite code already used.");
        }

        var user = new AppUser
        {
            UserName = request.Username,
            Email = request.Email,
            DisplayName = request.DisplayName
        };

        var result = await _userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
            return BadRequest(result.Errors);

        if (invite != null)
        {
            invite.Uses += 1;
            invite.LastUsedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }

        var response = await CreateAuthResponseAsync(user);
        return Ok(response);
    }

    [HttpPost("login")]
    [EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Login(LoginRequest request)
    {
        var user = await _userManager.FindByNameAsync(request.Username);
        if (user == null)
            return Unauthorized("Invalid credentials");

        var result = await _signInManager.CheckPasswordSignInAsync(user, request.Password, false);
        if (!result.Succeeded)
            return Unauthorized("Invalid credentials");

        var response = await CreateAuthResponseAsync(user);
        return Ok(response);
    }

    [HttpPost("refresh")]
    public async Task<ActionResult<AuthResponse>> Refresh(RefreshRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.RefreshToken)) return Unauthorized("Invalid refresh token");

        var tokenHash = HashToken(request.RefreshToken);
        var storedToken = await _db.RefreshTokens
            .Include(rt => rt.User)
            .FirstOrDefaultAsync(rt => rt.TokenHash == tokenHash);

        if (storedToken == null || storedToken.User == null)
            return Unauthorized("Invalid refresh token");

        if (!storedToken.IsActive)
        {
            // Grace period: if this token was revoked by rotation (not logout) within
            // the last 30 seconds, the client likely never received the response.
            // Follow the replacement chain and issue a new token pair.
            if (storedToken.RevokedAt.HasValue
                && storedToken.ReplacedByTokenId.HasValue
                && (DateTime.UtcNow - storedToken.RevokedAt.Value).TotalSeconds <= 30)
            {
                var currentToken = await FollowReplacementChainAsync(storedToken.ReplacedByTokenId.Value);
                if (currentToken != null)
                    currentToken.RevokedAt = DateTime.UtcNow;

                var newRefresh = CreateRefreshToken(storedToken.User, out var newRefreshToken);
                _db.RefreshTokens.Add(newRefresh);
                await _db.SaveChangesAsync();

                var accessToken = _tokenService.CreateToken(storedToken.User);
                return Ok(new AuthResponse(accessToken, newRefreshToken, ToUserDto(storedToken.User)));
            }

            return Unauthorized("Invalid refresh token");
        }

        var newRotatedRefresh = CreateRefreshToken(storedToken.User, out var newRotatedRefreshToken);
        storedToken.RevokedAt = DateTime.UtcNow;
        storedToken.ReplacedByTokenId = newRotatedRefresh.Id;

        _db.RefreshTokens.Add(newRotatedRefresh);
        await _db.SaveChangesAsync();

        var newAccessToken = _tokenService.CreateToken(storedToken.User);
        return Ok(new AuthResponse(newAccessToken, newRotatedRefreshToken, ToUserDto(storedToken.User)));
    }

    [HttpPost("logout")]
    public async Task<IActionResult> Logout(LogoutRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.RefreshToken)) return Ok();

        var tokenHash = HashToken(request.RefreshToken);
        var storedToken = await _db.RefreshTokens.FirstOrDefaultAsync(rt => rt.TokenHash == tokenHash);
        if (storedToken == null) return Ok();

        storedToken.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return Ok();
    }

    [HttpPut("profile")]
    [Authorize]
    public async Task<ActionResult<UserDto>> UpdateProfile(UpdateProfileRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();

        if (request.DisplayName != null) user.DisplayName = request.DisplayName;
        if (request.Bio != null) user.Bio = request.Bio;
        if (request.Status != null) user.Status = request.Status;

        await _userManager.UpdateAsync(user);

        var dto = ToUserDto(user);
        await BroadcastProfileUpdate(userId, dto);
        return Ok(dto);
    }

    [HttpPost("avatar")]
    [Authorize]
    public async Task<ActionResult<UserDto>> UploadAvatar(IFormFile file)
    {
        if (file.Length == 0) return BadRequest("No file");
        if (file.Length > 5 * 1024 * 1024) return BadRequest("File too large (max 5MB)");

        var imageError = ImageService.ValidateImageFile(file);
        if (imageError != null) return BadRequest(imageError);

        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();

        user.AvatarUrl = await _imageService.ProcessAvatarAsync(file);
        await _userManager.UpdateAsync(user);

        var dto = ToUserDto(user);
        await BroadcastProfileUpdate(userId, dto);
        return Ok(dto);
    }

    [HttpGet("profile/{userId}")]
    [Authorize]
    public async Task<ActionResult<UserDto>> GetProfile(string userId)
    {
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();
        var cosmetics = await _cosmeticService.GetEquippedAsync(userId);
        return Ok(new UserDto(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio, user.PresenceStatus, cosmetics));
    }

    [HttpPut("presence")]
    [Authorize]
    public async Task<IActionResult> UpdatePresenceStatus([FromBody] UpdatePresenceRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();

        // Validate status value (0-3)
        if (request.PresenceStatus < 0 || request.PresenceStatus > 3)
            return BadRequest("Invalid presence status");

        user.PresenceStatus = request.PresenceStatus;
        await _userManager.UpdateAsync(user);

        // Broadcast status change via SignalR
        await BroadcastPresenceChange(userId, request.PresenceStatus);

        return Ok();
    }

    private async Task BroadcastProfileUpdate(string userId, UserDto dto)
    {
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == userId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        foreach (var serverId in serverIds)
        {
            await _hubContext.Clients.Group($"server:{serverId}").SendAsync("UserProfileUpdated", dto);
        }
    }

    private async Task BroadcastPresenceChange(string userId, int presenceStatus)
    {
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == userId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        foreach (var serverId in serverIds)
        {
            await _hubContext.Clients.Group($"server:{serverId}").SendAsync("UserPresenceStatusChanged", userId, presenceStatus);
        }
    }

    private static UserDto ToUserDto(AppUser user) =>
        new(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio, user.PresenceStatus);

    private async Task<bool> IsInviteOnlyAsync()
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == InviteOnlyKey);
        if (row == null) return false;
        return bool.TryParse(row.Value, out var value) && value;
    }

    /// Follows the ReplacedByTokenId chain to find the latest token in the sequence.
    private async Task<RefreshToken?> FollowReplacementChainAsync(Guid tokenId)
    {
        var token = await _db.RefreshTokens.FindAsync(tokenId);
        const int maxDepth = 10;
        for (var i = 0; i < maxDepth && token?.ReplacedByTokenId != null; i++)
            token = await _db.RefreshTokens.FindAsync(token.ReplacedByTokenId);
        return token;
    }

    private async Task<AuthResponse> CreateAuthResponseAsync(AppUser user)
    {
        var refresh = CreateRefreshToken(user, out var refreshToken);
        _db.RefreshTokens.Add(refresh);
        await _db.SaveChangesAsync();

        var accessToken = _tokenService.CreateToken(user);
        return new AuthResponse(accessToken, refreshToken, ToUserDto(user));
    }

    private static RefreshToken CreateRefreshToken(AppUser user, out string rawToken)
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

    private static string GenerateRefreshToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(64);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    private static string HashToken(string token)
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
