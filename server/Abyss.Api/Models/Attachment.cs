namespace Abyss.Api.Models;

public class Attachment
{
    public Guid Id { get; set; }
    public Guid? MessageId { get; set; }
    public Message? Message { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string FilePath { get; set; } = string.Empty;
    public string ContentType { get; set; } = string.Empty;
    public long Size { get; set; }
}
