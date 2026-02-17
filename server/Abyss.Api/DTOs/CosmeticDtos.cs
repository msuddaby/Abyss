using System.ComponentModel.DataAnnotations;
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
    [Required, StringLength(100, MinimumLength = 1)] string Name,
    [Required, StringLength(500, MinimumLength = 1)] string Description,
    CosmeticType Type,
    CosmeticRarity Rarity,
    [Required, MaxLength(10000)] string CssData,
    string? PreviewImageUrl);

public record UpdateCosmeticRequest(
    [StringLength(100, MinimumLength = 1)] string? Name,
    [StringLength(500, MinimumLength = 1)] string? Description,
    CosmeticRarity? Rarity,
    [MaxLength(10000)] string? CssData,
    string? PreviewImageUrl,
    bool? IsActive);

public record AssignCosmeticRequest([Required] string UserId, Guid CosmeticItemId);
public record EquipCosmeticRequest(Guid CosmeticItemId);
