using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddXenForoConnections : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "XenForoConnections",
                columns: table => new
                {
                    OwnerId = table.Column<string>(type: "text", nullable: false),
                    XfUserId = table.Column<int>(type: "integer", nullable: false),
                    XfUsername = table.Column<string>(type: "text", nullable: false),
                    LinkedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_XenForoConnections", x => x.OwnerId);
                    table.ForeignKey(
                        name: "FK_XenForoConnections_AspNetUsers_OwnerId",
                        column: x => x.OwnerId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_XenForoConnections_XfUserId",
                table: "XenForoConnections",
                column: "XfUserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "XenForoConnections");
        }
    }
}
