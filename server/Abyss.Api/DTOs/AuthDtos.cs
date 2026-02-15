namespace Abyss.Api.DTOs;

public record RegisterRequest(string Username, string Email, string Password, string DisplayName, string? InviteCode);
public record LoginRequest(string Username, string Password);
public record RefreshRequest(string RefreshToken);
public record LogoutRequest(string RefreshToken);
public record AuthResponse(string Token, string RefreshToken, UserDto User);
public record UserDto(string Id, string Username, string DisplayName, string? AvatarUrl, string Status, string Bio, int PresenceStatus, EquippedCosmeticsDto? Cosmetics = null);
public record UpdateProfileRequest(string? DisplayName, string? Bio, string? Status);
public record UpdatePresenceRequest(int PresenceStatus);
