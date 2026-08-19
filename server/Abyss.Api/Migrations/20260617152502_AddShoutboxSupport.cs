using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddShoutboxSupport : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_XenForoConnections_XfUserId",
                table: "XenForoConnections");

            migrationBuilder.AddColumn<bool>(
                name: "IsForumBacked",
                table: "AspNetUsers",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateIndex(
                name: "IX_XenForoConnections_XfUserId",
                table: "XenForoConnections",
                column: "XfUserId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_XenForoConnections_XfUserId",
                table: "XenForoConnections");

            migrationBuilder.DropColumn(
                name: "IsForumBacked",
                table: "AspNetUsers");

            migrationBuilder.CreateIndex(
                name: "IX_XenForoConnections_XfUserId",
                table: "XenForoConnections",
                column: "XfUserId");
        }
    }
}
