namespace Abyss.Api.Models;

public class XenForoConnection
{
    public string OwnerId { get; set; } = string.Empty;
    public AppUser Owner { get; set; } = null!;
    public int XfUserId { get; set; }
    public string XfUsername { get; set; } = string.Empty;
    public DateTime LinkedAt { get; set; } = DateTime.UtcNow;
}
