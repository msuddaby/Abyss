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

        if (storedToken == null || !storedToken.IsActive || storedToken.User == null)
            return Unauthorized("Invalid refresh token");

        var newRefresh = CreateRefreshToken(storedToken.User, out var newRefreshToken);
        storedToken.RevokedAt = DateTime.UtcNow;
        storedToken.ReplacedByTokenId = newRefresh.Id;

        _db.RefreshTokens.Add(newRefresh);
        await _db.SaveChangesAsync();

        var accessToken = _tokenService.CreateToken(storedToken.User);
        return Ok(new AuthResponse(accessToken, newRefreshToken, ToUserDto(storedToken.User)));
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
        return Ok(new UserDto(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio, cosmetics));
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

    private static UserDto ToUserDto(AppUser user) =>
        new(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio);

    private async Task<bool> IsInviteOnlyAsync()
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == InviteOnlyKey);
        if (row == null) return false;
        return bool.TryParse(row.Value, out var value) && value;
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
