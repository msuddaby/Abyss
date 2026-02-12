namespace Abyss.Api.Models;

public enum FriendshipStatus
{
    Pending,
    Accepted,
    Declined
}

public class Friendship
{
    public Guid Id { get; set; }
    public string RequesterId { get; set; } = null!;
    public AppUser? Requester { get; set; }
    public string AddresseeId { get; set; } = null!;
    public AppUser? Addressee { get; set; }
    public FriendshipStatus Status { get; set; } = FriendshipStatus.Pending;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? AcceptedAt { get; set; }
}
