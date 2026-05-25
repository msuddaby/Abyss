using System.ComponentModel.DataAnnotations;

namespace Abyss.Api.Models;

public class Message
{
    public Guid Id { get; set; }
    public string Content { get; set; } = string.Empty;
    public string AuthorId { get; set; } = string.Empty;
    public AppUser Author { get; set; } = null!;
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? EditedAt { get; set; }
    public bool IsDeleted { get; set; }
    public bool IsSystem { get; set; }
    public Guid? ReplyToMessageId { get; set; }
    public Message? ReplyToMessage { get; set; }
    public ICollection<Attachment> Attachments { get; set; } = new List<Attachment>();
    public ICollection<Reaction> Reactions { get; set; } = new List<Reaction>();

    // Ghost author identity — used for mirrored XF posts whose author isn't linked to Abyss.
    // When set, the client renders these instead of the AppUser's normal name/avatar.
    [MaxLength(64)]
    public string? GhostAuthorName { get; set; }
    [MaxLength(2048)]
    public string? GhostAuthorAvatarUrl { get; set; }

    // Source link (e.g. XenForo post permalink) for mirrored content.
    public int? XfPostId { get; set; }
    [MaxLength(2048)]
    public string? XfPostUrl { get; set; }
}
