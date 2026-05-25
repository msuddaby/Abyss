using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddXenForoMirrorChannels : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "GhostAuthorAvatarUrl",
                table: "Messages",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GhostAuthorName",
                table: "Messages",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "XfPostId",
                table: "Messages",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "XfPostUrl",
                table: "Messages",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "XenForoNodeId",
                table: "Channels",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "XenForoNodeTitle",
                table: "Channels",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "XenForoPostMessages",
                columns: table => new
                {
                    XfPostId = table.Column<int>(type: "integer", nullable: false),
                    MessageId = table.Column<Guid>(type: "uuid", nullable: false),
                    ChannelId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_XenForoPostMessages", x => x.XfPostId);
                    table.ForeignKey(
                        name: "FK_XenForoPostMessages_Channels_ChannelId",
                        column: x => x.ChannelId,
                        principalTable: "Channels",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_XenForoPostMessages_Messages_MessageId",
                        column: x => x.MessageId,
                        principalTable: "Messages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_XenForoPostMessages_ChannelId_XfPostId",
                table: "XenForoPostMessages",
                columns: new[] { "ChannelId", "XfPostId" });

            migrationBuilder.CreateIndex(
                name: "IX_XenForoPostMessages_MessageId",
                table: "XenForoPostMessages",
                column: "MessageId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "XenForoPostMessages");

            migrationBuilder.DropColumn(
                name: "GhostAuthorAvatarUrl",
                table: "Messages");

            migrationBuilder.DropColumn(
                name: "GhostAuthorName",
                table: "Messages");

            migrationBuilder.DropColumn(
                name: "XfPostId",
                table: "Messages");

            migrationBuilder.DropColumn(
                name: "XfPostUrl",
                table: "Messages");

            migrationBuilder.DropColumn(
                name: "XenForoNodeId",
                table: "Channels");

            migrationBuilder.DropColumn(
                name: "XenForoNodeTitle",
                table: "Channels");
        }
    }
}
