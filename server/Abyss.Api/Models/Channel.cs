namespace Abyss.Api.Models;

public enum ChannelType
{
    Text,
    Voice,
    DM
}

public class Channel
{
    public Guid Id { get; set; }
    public string? Name { get; set; }
    public ChannelType Type { get; set; } = ChannelType.Text;
    public Guid? ServerId { get; set; }
    public Server? Server { get; set; }
    public int Position { get; set; }
    public List<ChannelPermissionOverride> PermissionOverrides { get; set; } = new();
    public bool PersistentChat { get; set; }
    public int? UserLimit { get; set; }

    // DM-specific fields
    public string? DmUser1Id { get; set; }
    public AppUser? DmUser1 { get; set; }
    public string? DmUser2Id { get; set; }
    public AppUser? DmUser2 { get; set; }
    public DateTime? LastMessageAt { get; set; }
}
