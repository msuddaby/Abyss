using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/admin")]
[Authorize]
public class AdminController : ControllerBase
{
    private readonly AppDbContext _db;
    private const string InviteOnlyKey = "InviteOnly";

    public AdminController(AppDbContext db)
    {
        _db = db;
    }

    private bool IsSysadmin() => User.HasClaim("sysadmin", "true");

    [HttpGet("overview")]
    public async Task<ActionResult<AdminOverviewDto>> GetOverview()
    {
        if (!IsSysadmin()) return Forbid();

        var servers = await _db.Servers
            .OrderBy(s => s.Name)
            .Select(s => new AdminServerDto(
                s.Id,
                s.Name,
                s.OwnerId,
                s.Members.Count,
                s.Channels.Count))
            .ToListAsync();

        var users = await _db.Users
            .OrderBy(u => u.UserName)
            .Select(u => new AdminUserDto(
                u.Id,
                u.UserName!,
                u.DisplayName,
                u.Email,
                u.Status))
            .ToListAsync();

        return Ok(new AdminOverviewDto(servers, users));
    }

    [HttpGet("settings")]
    public async Task<ActionResult<AdminSettingsDto>> GetSettings()
    {
        if (!IsSysadmin()) return Forbid();

        var inviteOnly = await GetInviteOnlyAsync();
        var codes = await _db.InviteCodes
            .OrderByDescending(c => c.CreatedAt)
            .Select(c => new InviteCodeDto(
                c.Id,
                c.Code,
                c.CreatedById,
                c.CreatedAt,
                c.ExpiresAt,
                c.MaxUses,
                c.Uses,
                c.LastUsedAt))
            .ToListAsync();

        return Ok(new AdminSettingsDto(inviteOnly, codes));
    }

    [HttpPut("settings/invite-only")]
    public async Task<IActionResult> UpdateInviteOnly(UpdateInviteOnlyRequest request)
    {
        if (!IsSysadmin()) return Forbid();

        await SetInviteOnlyAsync(request.InviteOnly);
        return Ok(new { inviteOnly = request.InviteOnly });
    }

    [HttpPost("invite-codes")]
    public async Task<ActionResult<InviteCodeDto>> CreateInviteCode(CreateInviteCodeRequest request)
    {
        if (!IsSysadmin()) return Forbid();

        var code = GenerateInviteCode();
        var userId = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;

        var invite = new Models.InviteCode
        {
            Code = code,
            CreatedById = userId,
            ExpiresAt = request.ExpiresAt,
            MaxUses = request.MaxUses
        };

        _db.InviteCodes.Add(invite);
        await _db.SaveChangesAsync();

        return Ok(new InviteCodeDto(
            invite.Id,
            invite.Code,
            invite.CreatedById,
            invite.CreatedAt,
            invite.ExpiresAt,
            invite.MaxUses,
            invite.Uses,
            invite.LastUsedAt));
    }

    private async Task<bool> GetInviteOnlyAsync()
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == InviteOnlyKey);
        if (row == null) return false;
        return bool.TryParse(row.Value, out var value) && value;
    }

    private async Task SetInviteOnlyAsync(bool enabled)
    {
        var row = await _db.AppConfigs.FirstOrDefaultAsync(c => c.Key == InviteOnlyKey);
        if (row == null)
        {
            row = new Models.AppConfig { Key = InviteOnlyKey, Value = enabled.ToString() };
            _db.AppConfigs.Add(row);
        }
        else
        {
            row.Value = enabled.ToString();
            row.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();
    }

    private static string GenerateInviteCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        var bytes = new byte[10];
        System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
        var chars = new char[10];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = alphabet[bytes[i] % alphabet.Length];
        }
        return new string(chars);
    }
}
