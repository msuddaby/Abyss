namespace Abyss.Api.Models;

public class Server
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? IconUrl { get; set; }
    public string OwnerId { get; set; } = string.Empty;
    public AppUser Owner { get; set; } = null!;
    public ICollection<ServerMember> Members { get; set; } = new List<ServerMember>();
    public ICollection<Channel> Channels { get; set; } = new List<Channel>();
    public ICollection<ServerRole> Roles { get; set; } = new List<ServerRole>();
    public ICollection<ServerBan> Bans { get; set; } = new List<ServerBan>();
    public ICollection<CustomEmoji> Emojis { get; set; } = new List<CustomEmoji>();
}
