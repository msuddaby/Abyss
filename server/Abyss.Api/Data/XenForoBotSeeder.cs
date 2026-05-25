using Microsoft.AspNetCore.Identity;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Data;

/// <summary>
/// Ensures the well-known "Forum" bot user exists. Mirrored XF posts whose
/// authors aren't linked to an Abyss account are stored under this user with
/// per-message ghost identity fields overriding the displayed name + avatar.
/// </summary>
public static class XenForoBotSeeder
{
    public static async Task SeedAsync(AppDbContext db, UserManager<AppUser> userManager)
    {
        var existing = await userManager.FindByIdAsync(XenForoMirrorService.BotUserId);
        if (existing != null) return;

        var bot = new AppUser
        {
            Id = XenForoMirrorService.BotUserId,
            UserName = XenForoMirrorService.BotUserName,
            NormalizedUserName = XenForoMirrorService.BotUserName.ToUpperInvariant(),
            Email = "xenforo-bot@abyss.local",
            NormalizedEmail = "XENFORO-BOT@ABYSS.LOCAL",
            EmailConfirmed = true,
            DisplayName = XenForoMirrorService.BotDisplayName,
            Status = string.Empty,
            Bio = string.Empty,
            PresenceStatus = 3, // Invisible — never broadcast presence for the bot
            SecurityStamp = Guid.NewGuid().ToString(),
        };

        // CreateAsync without a password — login is impossible. Identity still
        // requires a non-empty PasswordHash in some configurations; set a random
        // unusable one to be safe.
        bot.PasswordHash = new PasswordHasher<AppUser>().HashPassword(bot, Guid.NewGuid().ToString());

        var result = await userManager.CreateAsync(bot);
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(
                "Failed to seed XenForo bot user: " + string.Join(", ", result.Errors.Select(e => e.Description)));
        }
    }
}
