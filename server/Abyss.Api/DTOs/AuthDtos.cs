using System.ComponentModel.DataAnnotations;

namespace Abyss.Api.DTOs;

public record RegisterRequest(
    [Required, StringLength(32, MinimumLength = 1)] string Username,
    [Required, EmailAddress] string Email,
    [Required, StringLength(128, MinimumLength = 8)] string Password,
    [Required, StringLength(32, MinimumLength = 1)] string DisplayName,
    string? InviteCode);

public record LoginRequest(
    [Required] string Username,
    [Required] string Password);

public record RefreshRequest([Required] string RefreshToken);

public record LogoutRequest([Required] string RefreshToken);

public record AuthResponse(string Token, string RefreshToken, UserDto User);

public record UserDto(string Id, string Username, string DisplayName, string? AvatarUrl, string Status, string Bio, int PresenceStatus, EquippedCosmeticsDto? Cosmetics = null);

public record UpdateProfileRequest(
    [StringLength(32)] string? DisplayName,
    [StringLength(500)] string? Bio,
    [StringLength(128)] string? Status);

public record UpdatePresenceRequest([Range(0, 3)] int PresenceStatus);
