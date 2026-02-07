using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Abyss.Api.Models;

namespace Abyss.Api.Data;

public class AppDbContext : IdentityDbContext<AppUser>
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Server> Servers => Set<Server>();
    public DbSet<ServerMember> ServerMembers => Set<ServerMember>();
    public DbSet<Channel> Channels => Set<Channel>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<Invite> Invites => Set<Invite>();
    public DbSet<Reaction> Reactions => Set<Reaction>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<ServerRole> ServerRoles => Set<ServerRole>();
    public DbSet<ServerMemberRole> ServerMemberRoles => Set<ServerMemberRole>();
    public DbSet<ServerBan> ServerBans => Set<ServerBan>();
    public DbSet<ChannelRead> ChannelReads => Set<ChannelRead>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<CustomEmoji> CustomEmojis => Set<CustomEmoji>();
    public DbSet<DevicePushToken> DevicePushTokens => Set<DevicePushToken>();
    public DbSet<AppConfig> AppConfigs => Set<AppConfig>();
    public DbSet<InviteCode> InviteCodes => Set<InviteCode>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<ServerMember>()
            .HasKey(sm => new { sm.ServerId, sm.UserId });

        builder.Entity<ServerMember>()
            .HasOne(sm => sm.Server)
            .WithMany(s => s.Members)
            .HasForeignKey(sm => sm.ServerId);

        builder.Entity<ServerMember>()
            .HasOne(sm => sm.User)
            .WithMany()
            .HasForeignKey(sm => sm.UserId);

        builder.Entity<Channel>()
            .HasOne(c => c.Server)
            .WithMany(s => s.Channels)
            .HasForeignKey(c => c.ServerId)
            .IsRequired(false);

        builder.Entity<Channel>()
            .HasOne(c => c.DmUser1)
            .WithMany()
            .HasForeignKey(c => c.DmUser1Id)
            .OnDelete(DeleteBehavior.NoAction);

        builder.Entity<Channel>()
            .HasOne(c => c.DmUser2)
            .WithMany()
            .HasForeignKey(c => c.DmUser2Id)
            .OnDelete(DeleteBehavior.NoAction);

        builder.Entity<Channel>()
            .HasIndex(c => new { c.DmUser1Id, c.DmUser2Id })
            .IsUnique()
            .HasFilter("\"DmUser1Id\" IS NOT NULL AND \"DmUser2Id\" IS NOT NULL");

        builder.Entity<Message>()
            .HasIndex(m => new { m.ChannelId, m.CreatedAt });

        builder.Entity<Message>()
            .HasOne(m => m.Author)
            .WithMany()
            .HasForeignKey(m => m.AuthorId);

        builder.Entity<Message>()
            .HasOne(m => m.Channel)
            .WithMany()
            .HasForeignKey(m => m.ChannelId);

        builder.Entity<Message>()
            .HasOne(m => m.ReplyToMessage)
            .WithMany()
            .HasForeignKey(m => m.ReplyToMessageId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.Entity<Attachment>()
            .HasOne(a => a.Message)
            .WithMany(m => m.Attachments)
            .HasForeignKey(a => a.MessageId);

        builder.Entity<Reaction>()
            .HasOne(r => r.Message)
            .WithMany(m => m.Reactions)
            .HasForeignKey(r => r.MessageId);

        builder.Entity<Reaction>()
            .HasOne(r => r.User)
            .WithMany()
            .HasForeignKey(r => r.UserId);

        builder.Entity<Reaction>()
            .HasIndex(r => new { r.MessageId, r.UserId, r.Emoji })
            .IsUnique();

        builder.Entity<Invite>()
            .HasIndex(i => i.Code)
            .IsUnique();

        builder.Entity<Invite>()
            .HasOne(i => i.Server)
            .WithMany()
            .HasForeignKey(i => i.ServerId);

        builder.Entity<Invite>()
            .HasOne(i => i.Creator)
            .WithMany()
            .HasForeignKey(i => i.CreatorId);

        builder.Entity<AuditLog>()
            .HasOne(a => a.Server)
            .WithMany()
            .HasForeignKey(a => a.ServerId);

        builder.Entity<AuditLog>()
            .HasOne(a => a.Actor)
            .WithMany()
            .HasForeignKey(a => a.ActorId);

        builder.Entity<AuditLog>()
            .HasIndex(a => new { a.ServerId, a.CreatedAt });

        // ServerRole
        builder.Entity<ServerRole>()
            .HasOne(r => r.Server)
            .WithMany(s => s.Roles)
            .HasForeignKey(r => r.ServerId);

        // ServerMemberRole (junction table)
        builder.Entity<ServerMemberRole>()
            .HasKey(smr => new { smr.ServerId, smr.UserId, smr.RoleId });

        builder.Entity<ServerMemberRole>()
            .HasOne(smr => smr.Member)
            .WithMany(sm => sm.MemberRoles)
            .HasForeignKey(smr => new { smr.ServerId, smr.UserId });

        builder.Entity<ServerMemberRole>()
            .HasOne(smr => smr.Role)
            .WithMany()
            .HasForeignKey(smr => smr.RoleId);

        // ServerBan
        builder.Entity<ServerBan>()
            .HasOne(b => b.Server)
            .WithMany(s => s.Bans)
            .HasForeignKey(b => b.ServerId);

        builder.Entity<ServerBan>()
            .HasOne(b => b.User)
            .WithMany()
            .HasForeignKey(b => b.UserId);

        builder.Entity<ServerBan>()
            .HasOne(b => b.BannedBy)
            .WithMany()
            .HasForeignKey(b => b.BannedById);

        builder.Entity<ServerBan>()
            .HasIndex(b => new { b.ServerId, b.UserId })
            .IsUnique();

        // ChannelRead
        builder.Entity<ChannelRead>()
            .HasKey(cr => new { cr.ChannelId, cr.UserId });

        builder.Entity<ChannelRead>()
            .HasOne(cr => cr.Channel)
            .WithMany()
            .HasForeignKey(cr => cr.ChannelId);

        builder.Entity<ChannelRead>()
            .HasOne(cr => cr.User)
            .WithMany()
            .HasForeignKey(cr => cr.UserId);

        builder.Entity<ChannelRead>()
            .HasIndex(cr => cr.UserId);

        // Notification
        builder.Entity<Notification>()
            .HasOne(n => n.User)
            .WithMany()
            .HasForeignKey(n => n.UserId);

        builder.Entity<Notification>()
            .HasOne(n => n.Message)
            .WithMany()
            .HasForeignKey(n => n.MessageId);

        builder.Entity<Notification>()
            .HasOne(n => n.Channel)
            .WithMany()
            .HasForeignKey(n => n.ChannelId)
            .OnDelete(DeleteBehavior.NoAction);

        builder.Entity<Notification>()
            .HasOne(n => n.Server)
            .WithMany()
            .HasForeignKey(n => n.ServerId)
            .IsRequired(false)
            .OnDelete(DeleteBehavior.NoAction);

        builder.Entity<Notification>()
            .HasIndex(n => new { n.UserId, n.IsRead });

        builder.Entity<Notification>()
            .HasIndex(n => new { n.UserId, n.ChannelId, n.IsRead });

        builder.Entity<Notification>()
            .HasIndex(n => new { n.UserId, n.ServerId, n.IsRead });

        // CustomEmoji
        builder.Entity<CustomEmoji>()
            .HasOne(e => e.Server)
            .WithMany(s => s.Emojis)
            .HasForeignKey(e => e.ServerId);

        builder.Entity<CustomEmoji>()
            .HasOne(e => e.CreatedBy)
            .WithMany()
            .HasForeignKey(e => e.CreatedById);

        builder.Entity<CustomEmoji>()
            .HasIndex(e => new { e.ServerId, e.Name })
            .IsUnique();

        // DevicePushToken
        builder.Entity<DevicePushToken>()
            .HasOne(d => d.User)
            .WithMany()
            .HasForeignKey(d => d.UserId);

        builder.Entity<DevicePushToken>()
            .HasIndex(d => d.UserId);

        builder.Entity<DevicePushToken>()
            .HasIndex(d => new { d.UserId, d.Token })
            .IsUnique();

        builder.Entity<AppConfig>()
            .HasKey(c => c.Key);

        builder.Entity<InviteCode>()
            .HasIndex(i => i.Code)
            .IsUnique();

        builder.Entity<InviteCode>()
            .HasOne(i => i.CreatedBy)
            .WithMany()
            .HasForeignKey(i => i.CreatedById)
            .OnDelete(DeleteBehavior.SetNull);
    }
}
