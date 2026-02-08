namespace Abyss.Api.Models;

public class ChannelPermissionOverride
{
    public Guid ChannelId { get; set; }
    public Channel? Channel { get; set; }
    public Guid RoleId { get; set; }
    public ServerRole? Role { get; set; }
    public long Allow { get; set; }
    public long Deny { get; set; }
}
