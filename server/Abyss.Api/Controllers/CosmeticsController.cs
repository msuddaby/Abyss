using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/cosmetics")]
[Authorize]
public class CosmeticsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;

    public CosmeticsController(AppDbContext db, IHubContext<ChatHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private bool IsSysadmin() => User.HasClaim("sysadmin", "true");
    private string GetUserId() => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private static CosmeticItemDto ToDto(CosmeticItem c) => new(
        c.Id, c.Name, c.Description, c.Type, c.Rarity,
        c.CssData, c.PreviewImageUrl, c.IsActive, c.CreatedAt);

    // ─── Sysadmin: CRUD ───

    [HttpGet]
    public async Task<ActionResult<List<CosmeticItemDto>>> ListAll()
    {
        if (!IsSysadmin()) return Forbid();

        var items = await _db.CosmeticItems
            .OrderBy(c => c.Type).ThenBy(c => c.Rarity).ThenBy(c => c.Name)
            .ToListAsync();

        return Ok(items.Select(ToDto));
    }

    [HttpPost]
    public async Task<ActionResult<CosmeticItemDto>> Create(CreateCosmeticRequest req)
    {
        if (!IsSysadmin()) return Forbid();

        var item = new CosmeticItem
        {
            Name = req.Name.Trim(),
            Description = req.Description.Trim(),
            Type = req.Type,
            Rarity = req.Rarity,
            CssData = req.CssData,
            PreviewImageUrl = req.PreviewImageUrl,
        };

        _db.CosmeticItems.Add(item);
        await _db.SaveChangesAsync();

        return Ok(ToDto(item));
    }

    [HttpPut("{id}")]
    public async Task<ActionResult<CosmeticItemDto>> Update(Guid id, UpdateCosmeticRequest req)
    {
        if (!IsSysadmin()) return Forbid();

        var item = await _db.CosmeticItems.FindAsync(id);
        if (item == null) return NotFound("Cosmetic not found.");

        if (req.Name != null) item.Name = req.Name.Trim();
        if (req.Description != null) item.Description = req.Description.Trim();
        if (req.Rarity.HasValue) item.Rarity = req.Rarity.Value;
        if (req.CssData != null) item.CssData = req.CssData;
        if (req.PreviewImageUrl != null) item.PreviewImageUrl = req.PreviewImageUrl;
        if (req.IsActive.HasValue) item.IsActive = req.IsActive.Value;

        await _db.SaveChangesAsync();
        return Ok(ToDto(item));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(Guid id)
    {
        if (!IsSysadmin()) return Forbid();

        var item = await _db.CosmeticItems.FindAsync(id);
        if (item == null) return NotFound("Cosmetic not found.");

        // Soft delete: deactivate
        item.IsActive = false;
        await _db.SaveChangesAsync();
        return Ok();
    }

    // ─── Sysadmin: Assign / Unassign ───

    [HttpPost("assign")]
    public async Task<IActionResult> Assign(AssignCosmeticRequest req)
    {
        if (!IsSysadmin()) return Forbid();

        var exists = await _db.UserCosmetics
            .AnyAsync(uc => uc.UserId == req.UserId && uc.CosmeticItemId == req.CosmeticItemId);
        if (exists) return BadRequest("User already has this cosmetic.");

        var user = await _db.Users.FindAsync(req.UserId);
        if (user == null) return NotFound("User not found.");

        var item = await _db.CosmeticItems.FindAsync(req.CosmeticItemId);
        if (item == null) return NotFound("Cosmetic not found.");

        _db.UserCosmetics.Add(new UserCosmetic
        {
            UserId = req.UserId,
            CosmeticItemId = req.CosmeticItemId,
        });

        await _db.SaveChangesAsync();
        return Ok();
    }

    [HttpDelete("assign")]
    public async Task<IActionResult> Unassign(AssignCosmeticRequest req)
    {
        if (!IsSysadmin()) return Forbid();

        var uc = await _db.UserCosmetics
            .FirstOrDefaultAsync(x => x.UserId == req.UserId && x.CosmeticItemId == req.CosmeticItemId);
        if (uc == null) return NotFound("User does not have this cosmetic.");

        _db.UserCosmetics.Remove(uc);
        await _db.SaveChangesAsync();
        return Ok();
    }

    // ─── Sysadmin: View who owns a cosmetic ───

    [HttpGet("{id}/owners")]
    public async Task<ActionResult<List<UserDto>>> GetOwners(Guid id)
    {
        if (!IsSysadmin()) return Forbid();

        var owners = await _db.UserCosmetics
            .Where(uc => uc.CosmeticItemId == id)
            .Include(uc => uc.User)
            .Select(uc => new UserDto(
                uc.User.Id, uc.User.UserName!, uc.User.DisplayName,
                uc.User.AvatarUrl, uc.User.Status, uc.User.Bio, uc.User.PresenceStatus))
            .ToListAsync();

        return Ok(owners);
    }

    // ─── Sysadmin: Get user's cosmetics ───

    [HttpGet("user/{userId}")]
    public async Task<ActionResult<List<UserCosmeticDto>>> GetUserCosmetics(string userId)
    {
        if (!IsSysadmin()) return Forbid();

        var cosmetics = await _db.UserCosmetics
            .Where(uc => uc.UserId == userId)
            .Include(uc => uc.CosmeticItem)
            .OrderBy(uc => uc.CosmeticItem.Type)
            .ThenBy(uc => uc.CosmeticItem.Name)
            .ToListAsync();

        return Ok(cosmetics.Select(uc => new UserCosmeticDto(ToDto(uc.CosmeticItem), uc.IsEquipped, uc.AcquiredAt)));
    }

    // ─── User: My cosmetics ───

    [HttpGet("my")]
    public async Task<ActionResult<List<UserCosmeticDto>>> MyCosmetics()
    {
        var userId = GetUserId();
        var cosmetics = await _db.UserCosmetics
            .Where(uc => uc.UserId == userId)
            .Include(uc => uc.CosmeticItem)
            .Where(uc => uc.CosmeticItem.IsActive)
            .OrderBy(uc => uc.CosmeticItem.Type)
            .ThenBy(uc => uc.CosmeticItem.Name)
            .ToListAsync();

        return Ok(cosmetics.Select(uc => new UserCosmeticDto(ToDto(uc.CosmeticItem), uc.IsEquipped, uc.AcquiredAt)));
    }

    // ─── User: Equip / Unequip ───

    [HttpPut("equip")]
    public async Task<ActionResult<EquippedCosmeticsDto>> Equip(EquipCosmeticRequest req)
    {
        var userId = GetUserId();
        var uc = await _db.UserCosmetics
            .Include(x => x.CosmeticItem)
            .FirstOrDefaultAsync(x => x.UserId == userId && x.CosmeticItemId == req.CosmeticItemId);
        if (uc == null) return NotFound("You don't own this cosmetic.");
        if (!uc.CosmeticItem.IsActive) return BadRequest("This cosmetic is no longer available.");

        // Unequip any currently equipped item of the same type
        var sameType = await _db.UserCosmetics
            .Include(x => x.CosmeticItem)
            .Where(x => x.UserId == userId && x.IsEquipped && x.CosmeticItem.Type == uc.CosmeticItem.Type)
            .ToListAsync();

        foreach (var other in sameType)
            other.IsEquipped = false;

        uc.IsEquipped = true;
        await _db.SaveChangesAsync();

        var equipped = await GetEquippedForUser(userId);
        await BroadcastCosmeticChange(userId, equipped);
        return Ok(equipped);
    }

    [HttpPut("unequip/{cosmeticId}")]
    public async Task<ActionResult<EquippedCosmeticsDto>> Unequip(Guid cosmeticId)
    {
        var userId = GetUserId();
        var uc = await _db.UserCosmetics
            .FirstOrDefaultAsync(x => x.UserId == userId && x.CosmeticItemId == cosmeticId);
        if (uc == null) return NotFound("You don't own this cosmetic.");

        uc.IsEquipped = false;
        await _db.SaveChangesAsync();

        var equipped = await GetEquippedForUser(userId);
        await BroadcastCosmeticChange(userId, equipped);
        return Ok(equipped);
    }

    // ─── Sysadmin: Equip/Unequip on behalf of user ───

    [HttpPut("admin-equip")]
    public async Task<ActionResult<EquippedCosmeticsDto>> AdminEquip(AssignCosmeticRequest req)
    {
        if (!IsSysadmin()) return Forbid();

        var uc = await _db.UserCosmetics
            .Include(x => x.CosmeticItem)
            .FirstOrDefaultAsync(x => x.UserId == req.UserId && x.CosmeticItemId == req.CosmeticItemId);
        if (uc == null) return NotFound("User does not own this cosmetic.");

        var sameType = await _db.UserCosmetics
            .Include(x => x.CosmeticItem)
            .Where(x => x.UserId == req.UserId && x.IsEquipped && x.CosmeticItem.Type == uc.CosmeticItem.Type)
            .ToListAsync();

        foreach (var other in sameType)
            other.IsEquipped = false;

        uc.IsEquipped = true;
        await _db.SaveChangesAsync();

        var equipped = await GetEquippedForUser(req.UserId);
        await BroadcastCosmeticChange(req.UserId, equipped);
        return Ok(equipped);
    }

    [HttpPut("admin-unequip")]
    public async Task<ActionResult<EquippedCosmeticsDto>> AdminUnequip(AssignCosmeticRequest req)
    {
        if (!IsSysadmin()) return Forbid();

        var uc = await _db.UserCosmetics
            .FirstOrDefaultAsync(x => x.UserId == req.UserId && x.CosmeticItemId == req.CosmeticItemId);
        if (uc == null) return NotFound("User does not own this cosmetic.");

        uc.IsEquipped = false;
        await _db.SaveChangesAsync();

        var equipped = await GetEquippedForUser(req.UserId);
        await BroadcastCosmeticChange(req.UserId, equipped);
        return Ok(equipped);
    }

    // ─── Helpers ───

    private async Task<EquippedCosmeticsDto> GetEquippedForUser(string userId)
    {
        var equipped = await _db.UserCosmetics
            .Where(uc => uc.UserId == userId && uc.IsEquipped)
            .Include(uc => uc.CosmeticItem)
            .Where(uc => uc.CosmeticItem.IsActive)
            .ToListAsync();

        return new EquippedCosmeticsDto(
            equipped.FirstOrDefault(e => e.CosmeticItem.Type == CosmeticType.Nameplate) is { } np ? ToDto(np.CosmeticItem) : null,
            equipped.FirstOrDefault(e => e.CosmeticItem.Type == CosmeticType.MessageStyle) is { } ms ? ToDto(ms.CosmeticItem) : null,
            equipped.FirstOrDefault(e => e.CosmeticItem.Type == CosmeticType.ProfileEffect) is { } pe ? ToDto(pe.CosmeticItem) : null,
            equipped.FirstOrDefault(e => e.CosmeticItem.Type == CosmeticType.AvatarDecoration) is { } ad ? ToDto(ad.CosmeticItem) : null
        );
    }

    private async Task BroadcastCosmeticChange(string userId, EquippedCosmeticsDto cosmetics)
    {
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == userId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        foreach (var serverId in serverIds)
            await _hub.Clients.Group($"server:{serverId}").SendAsync("UserCosmeticsChanged", userId, cosmetics);
    }
}
