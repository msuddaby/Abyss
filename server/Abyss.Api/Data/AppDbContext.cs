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
            .HasForeignKey(c => c.ServerId);

        builder.Entity<Message>()
            .HasOne(m => m.Author)
            .WithMany()
            .HasForeignKey(m => m.AuthorId);

        builder.Entity<Message>()
            .HasOne(m => m.Channel)
            .WithMany()
            .HasForeignKey(m => m.ChannelId);

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
    }
}
