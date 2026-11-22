using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;

namespace Abyss.Api.Services;

/// <summary>
/// Thrown-tomato bookkeeping: ammo (rolling 24h window) and attaching splats to
/// message lists returned by the API.
/// </summary>
public class TomatoService
{
    public const int MaxAmmo = 5;
    public static readonly TimeSpan RefillWindow = TimeSpan.FromHours(24);

    private readonly AppDbContext _db;

    public TomatoService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<TomatoAmmoDto> GetAmmoAsync(string userId)
    {
        var since = DateTime.UtcNow - RefillWindow;
        // Counts wiped splats too — cleaning up a message never refunds the thrower.
        var recent = await _db.MessageSplats.AsNoTracking()
            .Where(s => s.UserId == userId && s.CreatedAt > since)
            .OrderBy(s => s.CreatedAt)
            .Select(s => s.CreatedAt)
            .ToListAsync();

        var remaining = Math.Max(0, MaxAmmo - recent.Count);
        // The oldest throw in the window is the next one to "ripen" back.
        DateTime? nextRefill = recent.Count > 0 && remaining < MaxAmmo
            ? DateTime.SpecifyKind(recent[0] + RefillWindow, DateTimeKind.Utc)
            : null;
        return new TomatoAmmoDto(remaining, MaxAmmo, nextRefill);
    }

    public async Task<List<MessageDto>> AttachSplatsAsync(List<MessageDto> messages)
    {
        var ids = messages.Where(m => !m.IsDeleted).Select(m => m.Id).ToList();
        if (ids.Count == 0) return messages;

        var splats = await _db.MessageSplats.AsNoTracking()
            .Where(s => ids.Contains(s.MessageId))
            .OrderBy(s => s.CreatedAt)
            .Select(s => new MessageSplatDto(s.Id, s.MessageId, s.UserId, s.Kind, s.X, s.Y, s.Seed,
                s.CreatedAt, s.WipedAt, s.User.DisplayName))
            .ToListAsync();
        if (splats.Count == 0) return messages;

        var byMessage = splats.GroupBy(s => s.MessageId).ToDictionary(g => g.Key, g => g.ToList());
        return messages
            .Select(m => byMessage.TryGetValue(m.Id, out var list) && !m.IsDeleted ? m with { Splats = list } : m)
            .ToList();
    }
}
