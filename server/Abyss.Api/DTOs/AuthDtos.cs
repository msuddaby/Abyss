namespace Abyss.Api.DTOs;

public record RegisterRequest(string Username, string Email, string Password, string DisplayName);
public record LoginRequest(string Username, string Password);
public record AuthResponse(string Token, UserDto User);
public record UserDto(string Id, string Username, string DisplayName, string? AvatarUrl, string Status, string Bio);
public record UpdateProfileRequest(string? DisplayName, string? Bio, string? Status);
