using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

public class CosmeticService
{
    private readonly AppDbContext _db;

    public CosmeticService(AppDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// Get equipped cosmetics for a single user.
    /// </summary>
    public async Task<EquippedCosmeticsDto?> GetEquippedAsync(string userId)
    {
        var equipped = await _db.UserCosmetics
            .Where(uc => uc.UserId == userId && uc.IsEquipped && uc.CosmeticItem.IsActive)
            .Include(uc => uc.CosmeticItem)
            .ToListAsync();

        if (equipped.Count == 0) return null;

        return BuildDto(equipped);
    }

    /// <summary>
    /// Get equipped cosmetics for multiple users in a single query.
    /// Returns a dictionary keyed by userId.
    /// </summary>
    public async Task<Dictionary<string, EquippedCosmeticsDto>> GetEquippedBatchAsync(IEnumerable<string> userIds)
    {
        var ids = userIds.ToList();
        if (ids.Count == 0) return new();

        var equipped = await _db.UserCosmetics
            .Where(uc => ids.Contains(uc.UserId) && uc.IsEquipped && uc.CosmeticItem.IsActive)
            .Include(uc => uc.CosmeticItem)
            .ToListAsync();

        return equipped
            .GroupBy(uc => uc.UserId)
            .ToDictionary(g => g.Key, g => BuildDto(g.ToList()));
    }

    /// <summary>
    /// Build a UserDto with cosmetics for the given AppUser.
    /// </summary>
    public UserDto ToUserDto(AppUser user, EquippedCosmeticsDto? cosmetics)
    {
        return new UserDto(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio, cosmetics);
    }

    /// <summary>
    /// Attach cosmetics to message authors (and reply authors) using a batch lookup.
    /// </summary>
    public async Task<List<MessageDto>> AttachCosmeticsAsync(List<MessageDto> messages)
    {
        var authorIds = messages
            .Select(m => m.AuthorId)
            .Concat(messages.Where(m => m.ReplyTo != null).Select(m => m.ReplyTo!.AuthorId))
            .Distinct()
            .ToList();

        if (authorIds.Count == 0) return messages;

        var map = await GetEquippedBatchAsync(authorIds);
        if (map.Count == 0) return messages;

        return messages.Select(m => m with
        {
            Author = m.Author with { Cosmetics = map.GetValueOrDefault(m.AuthorId) },
            ReplyTo = m.ReplyTo == null ? null : m.ReplyTo with
            {
                Author = m.ReplyTo.Author with { Cosmetics = map.GetValueOrDefault(m.ReplyTo.AuthorId) }
            }
        }).ToList();
    }

    private static EquippedCosmeticsDto BuildDto(List<UserCosmetic> equipped)
    {
        static CosmeticItemDto? Find(List<UserCosmetic> list, CosmeticType type)
        {
            var uc = list.FirstOrDefault(e => e.CosmeticItem.Type == type);
            if (uc == null) return null;
            var c = uc.CosmeticItem;
            return new CosmeticItemDto(c.Id, c.Name, c.Description, c.Type, c.Rarity, c.CssData, c.PreviewImageUrl, c.IsActive, c.CreatedAt);
        }

        return new EquippedCosmeticsDto(
            Find(equipped, CosmeticType.Nameplate),
            Find(equipped, CosmeticType.MessageStyle),
            Find(equipped, CosmeticType.ProfileEffect),
            Find(equipped, CosmeticType.AvatarDecoration)
        );
    }
}
