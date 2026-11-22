namespace Abyss.Api.Models;

/// <summary>
/// A thrown object (tomato, for now) stuck to a message. Position is stored as a
/// fraction of the message's rendered box so it lands in the same spot at any width.
/// Wiping soft-deletes (WipedAt) so ammo accounting — which counts throws, not
/// surviving splats — can't be refunded by cleaning up, and so clients can render
/// a faint smear where the splat used to be.
/// </summary>
public class MessageSplat
{
    public Guid Id { get; set; }
    public Guid MessageId { get; set; }
    public Message Message { get; set; } = null!;
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public string Kind { get; set; } = "tomato";
    public float X { get; set; }
    public float Y { get; set; }
    /// <summary>Deterministic seed so every client draws the same splat shape.</summary>
    public int Seed { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? WipedAt { get; set; }
}
