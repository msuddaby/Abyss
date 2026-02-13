using Abyss.Api.Models;

namespace Abyss.Api.DTOs;

public record CosmeticItemDto(
    Guid Id, string Name, string Description,
    CosmeticType Type, CosmeticRarity Rarity,
    string CssData, string? PreviewImageUrl, bool IsActive,
    DateTime CreatedAt);

public record UserCosmeticDto(
    CosmeticItemDto Item, bool IsEquipped, DateTime AcquiredAt);

public record EquippedCosmeticsDto(
    CosmeticItemDto? Nameplate,
    CosmeticItemDto? MessageStyle,
    CosmeticItemDto? ProfileEffect,
    CosmeticItemDto? AvatarDecoration);

public record CreateCosmeticRequest(
    string Name, string Description,
    CosmeticType Type, CosmeticRarity Rarity,
    string CssData, string? PreviewImageUrl);

public record UpdateCosmeticRequest(
    string? Name, string? Description,
    CosmeticRarity? Rarity,
    string? CssData, string? PreviewImageUrl,
    bool? IsActive);

public record AssignCosmeticRequest(string UserId, Guid CosmeticItemId);
public record EquipCosmeticRequest(Guid CosmeticItemId);
