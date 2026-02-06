using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class CustomRolesAndBans : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1. Create new tables first (before dropping old column)
            migrationBuilder.CreateTable(
                name: "ServerBans",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    BannedById = table.Column<string>(type: "text", nullable: false),
                    Reason = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ServerBans", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ServerBans_AspNetUsers_BannedById",
                        column: x => x.BannedById,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ServerBans_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ServerBans_Servers_ServerId",
                        column: x => x.ServerId,
                        principalTable: "Servers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ServerRoles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    Color = table.Column<string>(type: "text", nullable: false),
                    Permissions = table.Column<long>(type: "bigint", nullable: false),
                    Position = table.Column<int>(type: "integer", nullable: false),
                    IsDefault = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ServerRoles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ServerRoles_Servers_ServerId",
                        column: x => x.ServerId,
                        principalTable: "Servers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            // 2. Add IsOwner column with default false
            migrationBuilder.AddColumn<bool>(
                name: "IsOwner",
                table: "ServerMembers",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "ServerMemberRoles",
                columns: table => new
                {
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    RoleId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ServerMemberRoles", x => new { x.ServerId, x.UserId, x.RoleId });
                    table.ForeignKey(
                        name: "FK_ServerMemberRoles_ServerMembers_ServerId_UserId",
                        columns: x => new { x.ServerId, x.UserId },
                        principalTable: "ServerMembers",
                        principalColumns: new[] { "ServerId", "UserId" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ServerMemberRoles_ServerRoles_RoleId",
                        column: x => x.RoleId,
                        principalTable: "ServerRoles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            // Create indexes
            migrationBuilder.CreateIndex(
                name: "IX_ServerBans_BannedById",
                table: "ServerBans",
                column: "BannedById");

            migrationBuilder.CreateIndex(
                name: "IX_ServerBans_ServerId_UserId",
                table: "ServerBans",
                columns: new[] { "ServerId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ServerBans_UserId",
                table: "ServerBans",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_ServerMemberRoles_RoleId",
                table: "ServerMemberRoles",
                column: "RoleId");

            migrationBuilder.CreateIndex(
                name: "IX_ServerRoles_ServerId",
                table: "ServerRoles",
                column: "ServerId");

            // 3. Data migration: create @everyone + Admin roles for existing servers,
            //    set IsOwner, link old Admins to Admin role, then drop old Role column
            migrationBuilder.Sql(@"
                -- Create @everyone role for each existing server (Position=0, IsDefault=true, Perms=0)
                INSERT INTO ""ServerRoles"" (""Id"", ""ServerId"", ""Name"", ""Color"", ""Permissions"", ""Position"", ""IsDefault"")
                SELECT gen_random_uuid(), ""Id"", '@everyone', '#99aab5', 0, 0, true
                FROM ""Servers"";

                -- Create Admin role for each existing server (Position=1, Perms=39 = ManageChannels|ManageMessages|KickMembers|ViewAuditLog)
                INSERT INTO ""ServerRoles"" (""Id"", ""ServerId"", ""Name"", ""Color"", ""Permissions"", ""Position"", ""IsDefault"")
                SELECT gen_random_uuid(), ""Id"", 'Admin', '#5865f2', 39, 1, false
                FROM ""Servers"";

                -- Set IsOwner=true where old Role=2 (Owner)
                UPDATE ""ServerMembers"" SET ""IsOwner"" = true WHERE ""Role"" = 2;

                -- Link old Admins (Role=1) to the new Admin role
                INSERT INTO ""ServerMemberRoles"" (""ServerId"", ""UserId"", ""RoleId"")
                SELECT sm.""ServerId"", sm.""UserId"", sr.""Id""
                FROM ""ServerMembers"" sm
                JOIN ""ServerRoles"" sr ON sr.""ServerId"" = sm.""ServerId"" AND sr.""Name"" = 'Admin' AND sr.""IsDefault"" = false
                WHERE sm.""Role"" = 1;
            ");

            // 4. Drop the old Role column
            migrationBuilder.DropColumn(
                name: "Role",
                table: "ServerMembers");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ServerBans");

            migrationBuilder.DropTable(
                name: "ServerMemberRoles");

            migrationBuilder.DropTable(
                name: "ServerRoles");

            migrationBuilder.DropColumn(
                name: "IsOwner",
                table: "ServerMembers");

            migrationBuilder.AddColumn<int>(
                name: "Role",
                table: "ServerMembers",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }
    }
}
