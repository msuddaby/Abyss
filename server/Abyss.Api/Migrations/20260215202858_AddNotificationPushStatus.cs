using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddNotificationPushStatus : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "PushAttempts",
                table: "Notifications",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "PushStatus",
                table: "Notifications",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_PushStatus_CreatedAt",
                table: "Notifications",
                columns: new[] { "PushStatus", "CreatedAt" },
                filter: "\"PushStatus\" = 1");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Notifications_PushStatus_CreatedAt",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "PushAttempts",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "PushStatus",
                table: "Notifications");
        }
    }
}
