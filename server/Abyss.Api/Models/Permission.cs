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
    MuteMembers = 1 << 9,
    ViewChannel = 1 << 10,
    ReadMessageHistory = 1 << 11,
    SendMessages = 1 << 12,
    AddReactions = 1 << 13,
    AttachFiles = 1 << 14,
    MentionEveryone = 1 << 15,
    Connect = 1 << 16,
    Speak = 1 << 17,
    Stream = 1 << 18,
    ManageSoundboard = 1 << 19,
    UseSoundboard = 1 << 20,
    AddToWatchTogether = 1 << 21,
    ModerateWatchTogether = 1 << 22,
}
