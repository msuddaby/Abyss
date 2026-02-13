using Abyss.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Abyss.Api.Data;

/// <summary>
/// Seeds all cosmetics into the database on startup.
/// Idempotent — skips any cosmetic whose Name already exists.
/// </summary>
public static class CosmeticSeeder
{
    public static async Task SeedAsync(AppDbContext db)
    {
        var existingNames = (await db.CosmeticItems.Select(c => c.Name).ToListAsync()).ToHashSet();

        var cosmetics = GetAllCosmetics()
            .Where(c => !existingNames.Contains(c.Name))
            .ToList();

        if (cosmetics.Count == 0) return;

        db.CosmeticItems.AddRange(cosmetics);
        await db.SaveChangesAsync();
    }

    private static CosmeticItem NP(string name, string desc, CosmeticRarity rarity, string css) => new()
    {
        Id = Guid.NewGuid(), Name = name, Description = desc,
        Type = CosmeticType.Nameplate, Rarity = rarity, CssData = css,
    };

    private static CosmeticItem MS(string name, string desc, CosmeticRarity rarity, string css) => new()
    {
        Id = Guid.NewGuid(), Name = name, Description = desc,
        Type = CosmeticType.MessageStyle, Rarity = rarity, CssData = css,
    };

    private static List<CosmeticItem> GetAllCosmetics() =>
    [
        // ================================================================
        //  NAMEPLATES — COMMON
        // ================================================================

        NP("Slate", "Cool blue-grey tone", CosmeticRarity.Common,
            @"{""color"":""#8e9aaf"",""fontWeight"":""600""}"),

        NP("Rose", "Soft pink elegance", CosmeticRarity.Common,
            @"{""color"":""#e8a0bf"",""fontWeight"":""600""}"),

        NP("Mint", "Fresh green vibes", CosmeticRarity.Common,
            @"{""color"":""#7ec8a0"",""fontWeight"":""600""}"),

        // ================================================================
        //  NAMEPLATES — UNCOMMON
        // ================================================================

        NP("Crimson Fire", "Fiery red-orange gradient", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #ff6b6b, #ff8e53)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Ocean Breeze", "Cool cyan-blue gradient", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #36d1dc, #5b86e5)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Sakura", "Cherry blossom pink", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #fbc2eb, #a6c1ee)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Peach Sunset", "Warm peach-to-red gradient", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #ffb88c, #de6262)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Steel", "Forged in cold metal", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #8e9eab, #eef2f3, #8e9eab)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Mint Chip", "Cool mint gradient", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #7ec8a0, #2d6a4f)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Toxic Drip", "Radioactive green glow", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #b8ff00, #00ff87)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""filter"":""drop-shadow(0 0 4px rgba(184,255,0,0.4))""}"),

        NP("Vaporwave", "Retro pastel aesthetic", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #ff71ce, #01cdfe, #b967ff)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Witchcraft", "Purple-teal mystic potion", CosmeticRarity.Uncommon,
            @"{""background"":""linear-gradient(90deg, #8e44ad, #16a085)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        // ================================================================
        //  NAMEPLATES — RARE
        // ================================================================

        NP("Volcanic", "Molten lava flow", CosmeticRarity.Rare,
            @"{""background"":""linear-gradient(90deg, #ff512f, #dd2476)"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700""}"),

        NP("Emerald Glow", "Radiant green glow", CosmeticRarity.Rare,
            @"{""color"":""#43b581"",""textShadow"":""0 0 8px rgba(67,181,129,0.6), 0 0 16px rgba(67,181,129,0.3)"",""fontWeight"":""700""}"),

        NP("Neon Purple", "Electric purple neon glow", CosmeticRarity.Rare,
            @"{""color"":""#b388ff"",""textShadow"":""0 0 8px rgba(179,136,255,0.7), 0 0 20px rgba(179,136,255,0.4)"",""fontWeight"":""700""}"),

        NP("Electric", "High voltage cyan glow", CosmeticRarity.Rare,
            @"{""color"":""#00d4ff"",""textShadow"":""0 0 8px rgba(0,212,255,0.7), 0 0 20px rgba(0,100,255,0.3)"",""fontWeight"":""700""}"),

        NP("Rose Gold", "Elegant rose-gold shimmer", CosmeticRarity.Rare,
            @"{""background"":""linear-gradient(90deg, #b76e79, #f0c5a8, #b76e79)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 4s linear infinite""}"),

        NP("Amber Glow", "Warm amber with radiant glow", CosmeticRarity.Rare,
            @"{""color"":""#f0a500"",""textShadow"":""0 0 8px rgba(240,165,0,0.6), 0 0 20px rgba(240,100,0,0.3)"",""fontWeight"":""700""}"),

        NP("Deep Ocean", "Bioluminescent ocean depths", CosmeticRarity.Rare,
            @"{""color"":""#0abde3"",""textShadow"":""0 0 10px rgba(10,189,227,0.5), 0 0 24px rgba(0,50,100,0.4)"",""fontWeight"":""700""}"),

        // ================================================================
        //  NAMEPLATES — EPIC
        // ================================================================

        NP("Shadow Lord", "Darkness emanates from within", CosmeticRarity.Epic,
            @"{""color"":""#c0c0c0"",""textShadow"":""0 2px 4px rgba(0,0,0,0.8), 0 0 12px rgba(0,0,0,0.5)"",""fontWeight"":""700"",""letterSpacing"":""0.5px""}"),

        NP("Midnight Pulse", "Pulsing midnight blue glow", CosmeticRarity.Epic,
            @"{""color"":""#7289da"",""textShadow"":""0 0 6px rgba(114,137,218,0.5)"",""fontWeight"":""700"",""animation"":""nameplate-pulse 2s ease-in-out infinite""}"),

        NP("Gold Shimmer", "Dripping liquid gold", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #f7971e, #ffd200, #f7971e)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 3s linear infinite""}"),

        NP("Frost Bite", "Sub-zero icy shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #a8edea, #fed6e3, #a8edea)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 5s linear infinite""}"),

        NP("Blood Moon", "Crimson lunar shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #8b0000, #dc143c, #8b0000)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 4s linear infinite""}"),

        NP("Arctic Aurora", "Northern lights shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #00c9ff, #92fe9d, #00c9ff)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 4s linear infinite""}"),

        NP("Supernova", "Blinding stellar shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #fffbd5, #ff6b00, #fffbd5)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 2.5s linear infinite"",""filter"":""brightness(1.1)""}"),

        NP("Enchanted", "Forest magic emerald-gold shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #43b581, #f0c850, #43b581)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 4s linear infinite""}"),

        NP("Amethyst", "Crystal purple shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #9b59b6, #e8b4f8, #9b59b6)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 4s linear infinite""}"),

        NP("Cotton Candy", "Pastel dreamscape shimmer", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #fccb90, #d57eeb, #9ad0ec, #fccb90)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 5s linear infinite""}"),

        NP("Phantom", "Ghostly flickering presence", CosmeticRarity.Epic,
            @"{""color"":""rgba(255,255,255,0.6)"",""textShadow"":""0 0 12px rgba(255,255,255,0.25), 0 0 30px rgba(200,200,255,0.15)"",""fontWeight"":""700"",""animation"":""phantom-flicker 4s ease-in-out infinite""}"),

        NP("Solar Flare", "Blinding solar radiance", CosmeticRarity.Epic,
            @"{""background"":""linear-gradient(90deg, #fff200, #ff6b00, #fff200)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer 2s linear infinite"",""filter"":""brightness(1.15)""}"),

        // ================================================================
        //  NAMEPLATES — LEGENDARY
        // ================================================================

        NP("Rainbow Shift", "Full spectrum color shift", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #ff6b6b, #ffa500, #ffd700, #43b581, #5b86e5, #b388ff, #ff6b6b)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer-300 4s linear infinite""}"),

        NP("Cyber Punk", "Neon cyberpunk future", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #f72585, #7209b7, #3a0ca3, #4cc9f0, #f72585)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer-300 3s linear infinite""}"),

        NP("Holographic", "Otherworldly holographic shimmer", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(135deg, #ff0080, #ff8c00, #40e0d0, #7b68ee, #ff0080)"",""backgroundSize"":""400% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer-400 6s linear infinite"",""filter"":""brightness(1.1)""}"),

        NP("Static Glitch", "Corrupted terminal output", CosmeticRarity.Legendary,
            @"{""color"":""#00ff41"",""textShadow"":""-1px 0 #ff0000, 1px 0 #00ffff"",""fontWeight"":""700"",""letterSpacing"":""1px""}"),

        NP("Galaxy", "Deep space cosmic flow", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #0f0c29, #8e2de2, #da22ff, #4facfe, #0f0c29)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer-300 5s linear infinite""}"),

        NP("Dragon Fire", "Breathe legendary fire", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #ff0000, #ff6600, #ffcc00, #ff6600, #ff0000)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer-300 2.5s linear infinite"",""filter"":""brightness(1.1)""}"),

        NP("Prismatic", "Every color at once", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #ff0000, #ff8800, #ffff00, #00ff00, #0088ff, #ff00ff, #ff0000)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""animation"":""nameplate-shimmer-300 1.5s linear infinite""}"),

        NP("Nether Rune", "Ancient teal rune magic", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #00ffc8, #065e4a, #00ffc8, #032b22, #00ffc8)"",""backgroundSize"":""400% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""900"",""letterSpacing"":""3px"",""textTransform"":""uppercase"",""animation"":""nameplate-shimmer-400 8s linear infinite""}"),

        NP("Shattered", "Reality is broken", CosmeticRarity.Legendary,
            @"{""color"":""#e0e0e0"",""textShadow"":""-2px 0 #ff003c, 2px 0 #00fff7"",""fontWeight"":""700"",""letterSpacing"":""1.5px"",""animation"":""nameplate-glitch 0.15s steps(2) infinite""}"),

        NP("Celestial Script", "Written in the stars", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #ffd700, #fffbe6, #ffd700)"",""backgroundSize"":""200% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""700"",""fontStyle"":""italic"",""animation"":""nameplate-shimmer 4s linear infinite""}"),

        NP("Inferno", "Everything burns", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #dc143c, #ff4500, #ff8c00, #ffd700, #fff8e7, #ffd700, #ff8c00, #ff4500, #dc143c)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""900"",""animation"":""nameplate-shimmer-300 2s linear infinite"",""filter"":""brightness(1.15)""}"),

        NP("Chromatic Wave", "Ride the full spectrum", CosmeticRarity.Legendary,
            @"{""background"":""linear-gradient(90deg, #ff0040, #ff8800, #eeff00, #00ff88, #0088ff, #cc00ff, #ff0040)"",""backgroundSize"":""300% auto"",""backgroundClip"":""text"",""WebkitBackgroundClip"":""text"",""WebkitTextFillColor"":""transparent"",""fontWeight"":""800"",""animation"":""nameplate-chroma-shift 4s linear infinite""}"),

        // ================================================================
        //  MESSAGE STYLES — COMMON
        // ================================================================

        MS("Royal Blue", "Clean blue accent", CosmeticRarity.Common,
            @"{""borderLeft"":""3px solid #5865f2"",""background"":""linear-gradient(90deg, rgba(88,101,242,0.1), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Crimson Edge", "Bold red accent", CosmeticRarity.Common,
            @"{""borderLeft"":""3px solid #ed4245"",""background"":""linear-gradient(90deg, rgba(237,66,69,0.08), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Emerald Accent", "Natural green accent", CosmeticRarity.Common,
            @"{""borderLeft"":""3px solid #43b581"",""background"":""linear-gradient(90deg, rgba(67,181,129,0.08), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Amber Line", "Simple warm amber accent", CosmeticRarity.Common,
            @"{""borderLeft"":""3px solid #f0a500"",""background"":""linear-gradient(90deg, rgba(240,165,0,0.06), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Lavender Line", "Soft purple left border", CosmeticRarity.Common,
            @"{""borderLeft"":""3px solid #b388ff"",""background"":""linear-gradient(90deg, rgba(179,136,255,0.05), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        // ================================================================
        //  MESSAGE STYLES — UNCOMMON
        // ================================================================

        MS("Sunset Glow", "Warm golden tones", CosmeticRarity.Uncommon,
            @"{""borderLeft"":""3px solid #faa61a"",""background"":""linear-gradient(90deg, rgba(250,166,26,0.08), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Coral Reef", "Warm coral with turquoise fade", CosmeticRarity.Uncommon,
            @"{""borderLeft"":""3px solid #ff7979"",""background"":""linear-gradient(90deg, rgba(255,121,121,0.06), rgba(0,210,211,0.02), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Midnight Blue", "Deep navy accent", CosmeticRarity.Uncommon,
            @"{""borderLeft"":""3px solid #2c3e7b"",""background"":""linear-gradient(90deg, rgba(44,62,123,0.1), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Sunrise", "Golden hour gradient border", CosmeticRarity.Uncommon,
            @"{""borderLeft"":""3px solid transparent"",""borderImage"":""linear-gradient(to bottom, #f7971e, #ff6b6b, #ee5a9f) 1"",""background"":""linear-gradient(90deg, rgba(247,151,30,0.05), rgba(238,90,159,0.03), transparent)""}"),

        // ================================================================
        //  MESSAGE STYLES — RARE
        // ================================================================

        MS("Neon Border", "Futuristic neon purple glow", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid #b388ff"",""background"":""linear-gradient(90deg, rgba(179,136,255,0.06), transparent)"",""boxShadow"":""-4px 0 12px rgba(179,136,255,0.15)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Gradient Border", "Pink-to-purple gradient", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid transparent"",""borderImage"":""linear-gradient(to bottom, #f72585, #7209b7) 1"",""background"":""linear-gradient(90deg, rgba(247,37,133,0.05), transparent)""}"),

        MS("Cherry Blossom", "Soft sakura pink hues", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid #fbc2eb"",""background"":""linear-gradient(90deg, rgba(251,194,235,0.06), rgba(166,193,238,0.02), transparent)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Toxic Splash", "Radioactive border glow", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid #b8ff00"",""background"":""linear-gradient(90deg, rgba(184,255,0,0.06), rgba(0,255,135,0.03), transparent)"",""boxShadow"":""-3px 0 10px rgba(184,255,0,0.1)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Mystic Veil", "Purple mystic glow border", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid #8e44ad"",""background"":""linear-gradient(90deg, rgba(142,68,173,0.06), rgba(22,160,133,0.03), transparent)"",""boxShadow"":""-3px 0 12px rgba(142,68,173,0.12)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Twilight", "Purple-to-orange dusk gradient border", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid transparent"",""borderImage"":""linear-gradient(to bottom, #a855f7, #f97316) 1"",""background"":""linear-gradient(90deg, rgba(168,85,247,0.05), rgba(249,115,22,0.03), transparent)""}"),

        MS("Deep Sea", "Bioluminescent ocean glow", CosmeticRarity.Rare,
            @"{""borderLeft"":""3px solid #0abde3"",""background"":""linear-gradient(90deg, rgba(10,189,227,0.06), rgba(0,50,100,0.04), transparent)"",""boxShadow"":""-3px 0 12px rgba(10,189,227,0.1)"",""borderRadius"":""0 4px 4px 0""}"),

        // ================================================================
        //  MESSAGE STYLES — EPIC
        // ================================================================

        MS("Golden Frame", "Full golden border frame", CosmeticRarity.Epic,
            @"{""border"":""1px solid rgba(243,156,18,0.3)"",""borderLeft"":""3px solid #f39c12"",""background"":""linear-gradient(90deg, rgba(243,156,18,0.06), transparent)"",""borderRadius"":""4px""}"),

        MS("Frost Glass", "Frosted glass border effect", CosmeticRarity.Epic,
            @"{""background"":""rgba(168,237,234,0.04)"",""border"":""1px solid rgba(168,237,234,0.12)"",""borderRadius"":""8px""}"),

        MS("Dark Aura", "Void-like inset darkness", CosmeticRarity.Epic,
            @"{""background"":""rgba(0,0,0,0.2)"",""borderLeft"":""3px solid #2c2f33"",""boxShadow"":""inset 0 0 20px rgba(0,0,0,0.3)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Glowing Ember", "Smoldering volcanic glow", CosmeticRarity.Epic,
            @"{""borderLeft"":""3px solid #ff512f"",""background"":""linear-gradient(90deg, rgba(255,81,47,0.08), rgba(221,36,118,0.04), transparent)"",""boxShadow"":""-2px 0 8px rgba(255,81,47,0.12)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Double Border", "Symmetrical dual-side border", CosmeticRarity.Epic,
            @"{""borderLeft"":""3px solid #5865f2"",""borderRight"":""3px solid #5865f2"",""background"":""linear-gradient(90deg, rgba(88,101,242,0.06), transparent, rgba(88,101,242,0.06))"",""borderRadius"":""4px""}"),

        MS("Pulsing Glow", "Gently pulsing border glow", CosmeticRarity.Epic,
            @"{""borderLeft"":""3px solid #7289da"",""background"":""linear-gradient(90deg, rgba(114,137,218,0.06), transparent)"",""borderRadius"":""0 4px 4px 0"",""animation"":""msg-glow 3s ease-in-out infinite""}"),

        MS("Spectral Frame", "Ghostly pulsing border", CosmeticRarity.Epic,
            @"{""border"":""1px solid rgba(255,255,255,0.08)"",""borderLeft"":""3px solid rgba(255,255,255,0.15)"",""background"":""rgba(255,255,255,0.02)"",""borderRadius"":""4px"",""animation"":""spectral-pulse 4s ease-in-out infinite""}"),

        MS("Ember Trail", "Smoldering fire glow on the border", CosmeticRarity.Epic,
            @"{""borderLeft"":""3px solid #ff4500"",""background"":""linear-gradient(90deg, rgba(255,69,0,0.08), rgba(255,140,0,0.04), transparent)"",""boxShadow"":""-4px 0 14px rgba(255,69,0,0.15)"",""borderRadius"":""0 4px 4px 0"",""animation"":""ember-glow 3s ease-in-out infinite""}"),

        // ================================================================
        //  MESSAGE STYLES — LEGENDARY
        // ================================================================

        MS("Rainbow Border", "Full spectrum rainbow border", CosmeticRarity.Legendary,
            @"{""borderLeft"":""3px solid transparent"",""borderImage"":""linear-gradient(to bottom, #ff6b6b, #ffa500, #ffd700, #43b581, #5b86e5, #b388ff) 1"",""background"":""linear-gradient(90deg, rgba(114,137,218,0.04), transparent)""}"),

        MS("Holographic Frame", "Color-shifting holographic border", CosmeticRarity.Legendary,
            @"{""borderLeft"":""3px solid transparent"",""borderImage"":""linear-gradient(to bottom, #ff6b6b, #ffa500, #43b581, #5b86e5, #b388ff) 1"",""background"":""linear-gradient(90deg, rgba(114,137,218,0.04), transparent)""}"),

        MS("Terminal", "Retro hacker terminal aesthetic", CosmeticRarity.Legendary,
            @"{""borderLeft"":""3px solid #00ff41"",""background"":""rgba(0,255,65,0.03)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Plasma Frame", "Contained lightning border", CosmeticRarity.Legendary,
            @"{""borderLeft"":""3px solid #00d4ff"",""background"":""linear-gradient(90deg, rgba(0,212,255,0.08), rgba(123,104,238,0.05), rgba(218,34,255,0.03), transparent)"",""boxShadow"":""-4px 0 16px rgba(0,212,255,0.2), inset 0 0 15px rgba(123,104,238,0.05)"",""borderRadius"":""0 4px 4px 0""}"),

        MS("Void", "The abyss stares back", CosmeticRarity.Legendary,
            @"{""borderLeft"":""3px solid #1a1a2e"",""background"":""linear-gradient(90deg, rgba(0,0,0,0.3), rgba(10,10,30,0.15), transparent)"",""boxShadow"":""inset 0 0 30px rgba(0,0,0,0.4), -3px 0 12px rgba(80,0,120,0.15)"",""borderRadius"":""0 4px 4px 0""}"),
    ];
}
