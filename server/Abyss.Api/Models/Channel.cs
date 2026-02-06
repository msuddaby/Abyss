namespace Abyss.Api.Models;

public enum ChannelType
{
    Text,
    Voice
}

public class Channel
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public ChannelType Type { get; set; } = ChannelType.Text;
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public int Position { get; set; }
}
