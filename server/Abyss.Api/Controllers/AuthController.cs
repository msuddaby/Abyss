using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Data;
using Abyss.Api.DTOs;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly UserManager<AppUser> _userManager;
    private readonly SignInManager<AppUser> _signInManager;
    private readonly TokenService _tokenService;
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly AppDbContext _db;
    private readonly IWebHostEnvironment _env;

    public AuthController(
        UserManager<AppUser> userManager,
        SignInManager<AppUser> signInManager,
        TokenService tokenService,
        IHubContext<ChatHub> hubContext,
        AppDbContext db,
        IWebHostEnvironment env)
    {
        _userManager = userManager;
        _signInManager = signInManager;
        _tokenService = tokenService;
        _hubContext = hubContext;
        _db = db;
        _env = env;
    }

    [HttpPost("register")]
    public async Task<ActionResult<AuthResponse>> Register(RegisterRequest request)
    {
        var user = new AppUser
        {
            UserName = request.Username,
            Email = request.Email,
            DisplayName = request.DisplayName
        };

        var result = await _userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
            return BadRequest(result.Errors);

        var token = _tokenService.CreateToken(user);
        return Ok(new AuthResponse(token, ToUserDto(user)));
    }

    [HttpPost("login")]
    public async Task<ActionResult<AuthResponse>> Login(LoginRequest request)
    {
        var user = await _userManager.FindByNameAsync(request.Username);
        if (user == null)
            return Unauthorized("Invalid credentials");

        var result = await _signInManager.CheckPasswordSignInAsync(user, request.Password, false);
        if (!result.Succeeded)
            return Unauthorized("Invalid credentials");

        var token = _tokenService.CreateToken(user);
        return Ok(new AuthResponse(token, ToUserDto(user)));
    }

    [HttpPut("profile")]
    [Authorize]
    public async Task<ActionResult<UserDto>> UpdateProfile(UpdateProfileRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();

        if (request.DisplayName != null) user.DisplayName = request.DisplayName;
        if (request.Bio != null) user.Bio = request.Bio;
        if (request.Status != null) user.Status = request.Status;

        await _userManager.UpdateAsync(user);

        var dto = ToUserDto(user);
        await BroadcastProfileUpdate(userId, dto);
        return Ok(dto);
    }

    [HttpPost("avatar")]
    [Authorize]
    public async Task<ActionResult<UserDto>> UploadAvatar(IFormFile file)
    {
        if (file.Length == 0) return BadRequest("No file");
        if (file.Length > 5 * 1024 * 1024) return BadRequest("File too large (max 5MB)");

        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();

        var uploadsDir = Path.Combine(_env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot"), "uploads");
        Directory.CreateDirectory(uploadsDir);

        var fileName = $"{Guid.NewGuid()}{Path.GetExtension(file.FileName)}";
        var filePath = Path.Combine(uploadsDir, fileName);

        using (var stream = new FileStream(filePath, FileMode.Create))
        {
            await file.CopyToAsync(stream);
        }

        user.AvatarUrl = $"/uploads/{fileName}";
        await _userManager.UpdateAsync(user);

        var dto = ToUserDto(user);
        await BroadcastProfileUpdate(userId, dto);
        return Ok(dto);
    }

    [HttpGet("profile/{userId}")]
    [Authorize]
    public async Task<ActionResult<UserDto>> GetProfile(string userId)
    {
        var user = await _userManager.FindByIdAsync(userId);
        if (user == null) return NotFound();
        return Ok(ToUserDto(user));
    }

    private async Task BroadcastProfileUpdate(string userId, UserDto dto)
    {
        var serverIds = await _db.ServerMembers
            .Where(sm => sm.UserId == userId)
            .Select(sm => sm.ServerId)
            .ToListAsync();

        foreach (var serverId in serverIds)
        {
            await _hubContext.Clients.Group($"server:{serverId}").SendAsync("UserProfileUpdated", dto);
        }
    }

    private static UserDto ToUserDto(AppUser user) =>
        new(user.Id, user.UserName!, user.DisplayName, user.AvatarUrl, user.Status, user.Bio);
}
