namespace Abyss.Api.Models;

[Flags]
public enum Permission : long
{
    ManageChannels = 1 << 0,
    ManageMessages = 1 << 1,
    KickMembers = 1 << 2,
    BanMembers = 1 << 3,
    ManageRoles = 1 << 4,
    ViewAuditLog = 1 << 5,
    ManageServer = 1 << 6,
    ManageInvites = 1 << 7,
    ManageEmojis = 1 << 8,
}
