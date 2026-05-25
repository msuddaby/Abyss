namespace Abyss.Api.Models;

/// <summary>
/// Maps a XenForo post id to the Abyss <see cref="Message"/> created when the
/// post was mirrored. Used for reply-parent lookups, edit/delete dispatch, and
/// idempotency on webhook replays.
/// </summary>
public class XenForoPostMessage
{
    public int XfPostId { get; set; }
    public Guid MessageId { get; set; }
    public Message Message { get; set; } = null!;
    public Guid ChannelId { get; set; }
    public Channel Channel { get; set; } = null!;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
