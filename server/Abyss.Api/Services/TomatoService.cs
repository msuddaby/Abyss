using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Models;

namespace Abyss.Api.Services;

/// <summary>
/// Thrown-tomato bookkeeping: sysadmin settings, ammo (rolling window) and
/// attaching splats to message lists returned by the API.
/// </summary>
public class TomatoService
{
    public const string SettingsKey = "TomatoSettings";

    /// <summary>
    /// Hard ceiling on live splats per message regardless of settings, so
    /// "unlimited everything" can't turn one message into thousands of DOM nodes.
    /// </summary>
    public const int MaxLiveSplatsPerMessage = 100;

    public const int MaxSmearsPerMessage = 20;

    /// <summary>Minimum gap between one user's throws (anti-autoclicker).</summary>
    public static readonly TimeSpan ThrowCooldown = TimeSpan.FromMilliseconds(200);

    public static readonly TomatoSettingsDto Defaults = new();

    private static readonly ConcurrentDictionary<string, DateTime> _lastThrow = new();
    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    private readonly AppDbContext _db;

    public TomatoService(AppDbContext db)
    {
        _db = db;
    }

    public static TomatoSettingsDto Normalize(TomatoSettingsDto s) => s with
    {
        MaxAmmo = Math.Clamp(s.MaxAmmo, 1, 1000),
        RefillMinutes = Math.Clamp(s.RefillMinutes, 1, 43200),
        MaxPerMessage = Math.Clamp(s.MaxPerMessage, 0, MaxLiveSplatsPerMessage),
    };

    public async Task<TomatoSettingsDto> GetSettingsAsync()
    {
        var row = await _db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(c => c.Key == SettingsKey);
        if (row?.Value == null) return Defaults;
        try
        {
            var parsed = JsonSerializer.Deserialize<TomatoSettingsDto>(row.Value, _json);
            return parsed == null ? Defaults : Normalize(parsed);
        }
        catch (JsonException)
        {
            return Defaults;
        }
    }

    public async Task<TomatoSettingsDto> SaveSettingsAsync(TomatoSettingsDto settings)
    {
        var normalized = Normalize(settings);
        var value = JsonSerializer.Serialize(normalized, _json);
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == SettingsKey);
        if (row == null)
        {
            _db.AppConfigs.Add(new AppConfig { Key = SettingsKey, Value = value });
        }
        else
        {
            row.Value = value;
            row.UpdatedAt = DateTime.UtcNow;
        }
        await _db.SaveChangesAsync();
        return normalized;
    }

    public async Task<TomatoAmmoDto> GetAmmoAsync(string userId, TomatoSettingsDto? settings = null)
    {
        settings ??= await GetSettingsAsync();
        if (settings.UnlimitedAmmo) return new TomatoAmmoDto(0, 0, null, Unlimited: true);

        var window = TimeSpan.FromMinutes(settings.RefillMinutes);
        var since = DateTime.UtcNow - window;
        // Counts wiped splats too — cleaning up a message never refunds the thrower.
        // Only the oldest MaxAmmo throws matter for the count and refill time.
        var recent = await _db.MessageSplats.AsNoTracking()
            .Where(s => s.UserId == userId && s.CreatedAt > since)
            .OrderBy(s => s.CreatedAt)
            .Select(s => s.CreatedAt)
            .Take(settings.MaxAmmo + 1)
            .ToListAsync();

        var remaining = Math.Max(0, settings.MaxAmmo - recent.Count);
        // The oldest throw in the window is the next one to "ripen" back.
        DateTime? nextRefill = recent.Count > 0
            ? DateTime.SpecifyKind(recent[0] + window, DateTimeKind.Utc)
            : null;
        return new TomatoAmmoDto(remaining, settings.MaxAmmo, nextRefill);
    }

    /// <summary>True if the user threw too recently; records the attempt otherwise.</summary>
    public static bool IsOnCooldown(string userId)
    {
        var now = DateTime.UtcNow;
        if (_lastThrow.TryGetValue(userId, out var last) && now - last < ThrowCooldown) return true;
        _lastThrow[userId] = now;
        return false;
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

        // Keep every live splat but only the most recent smears — repeated
        // throw-and-wipe cycles would otherwise pile up forever.
        var byMessage = splats.GroupBy(s => s.MessageId).ToDictionary(g => g.Key, g =>
        {
            var wiped = g.Where(s => s.WipedAt != null).TakeLast(MaxSmearsPerMessage);
            return g.Where(s => s.WipedAt == null).Concat(wiped).OrderBy(s => s.CreatedAt).ToList();
        });
        return messages
            .Select(m => byMessage.TryGetValue(m.Id, out var list) && !m.IsDeleted ? m with { Splats = list } : m)
            .ToList();
    }
}
