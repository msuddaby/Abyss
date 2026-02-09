namespace Abyss.Api.Models;

public class ServerRole
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Server Server { get; set; } = null!;
    public string Name { get; set; } = string.Empty;
    public string Color { get; set; } = "#99aab5";
    public long Permissions { get; set; }
    public int Position { get; set; }
    public bool IsDefault { get; set; }
    public bool DisplaySeparately { get; set; }
}
