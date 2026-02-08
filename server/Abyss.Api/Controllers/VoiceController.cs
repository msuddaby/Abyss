using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Abyss.Api.Services;

namespace Abyss.Api.Controllers;

[ApiController]
[Route("api/voice")]
[Authorize]
public class VoiceController : ControllerBase
{
    private readonly TurnCredentialService _turn;

    public VoiceController(TurnCredentialService turn) => _turn = turn;

    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet("turn")]
    public ActionResult<TurnCredentialResult> GetTurnCredentials()
    {
        var creds = _turn.Issue(UserId);
        return Ok(creds);
    }
}
