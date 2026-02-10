using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddNotificationAndPreferences : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "DefaultNotificationLevel",
                table: "Servers",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "UserChannelNotificationSettings",
                columns: table => new
                {
                    ChannelId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    NotificationLevel = table.Column<int>(type: "integer", nullable: true),
                    MuteUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserChannelNotificationSettings", x => new { x.ChannelId, x.UserId });
                    table.ForeignKey(
                        name: "FK_UserChannelNotificationSettings_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_UserChannelNotificationSettings_Channels_ChannelId",
                        column: x => x.ChannelId,
                        principalTable: "Channels",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "UserPreferences",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    InputMode = table.Column<int>(type: "integer", nullable: false),
                    JoinMuted = table.Column<bool>(type: "boolean", nullable: false),
                    JoinDeafened = table.Column<bool>(type: "boolean", nullable: false),
                    InputSensitivity = table.Column<double>(type: "double precision", nullable: false),
                    NoiseSuppression = table.Column<bool>(type: "boolean", nullable: false),
                    EchoCancellation = table.Column<bool>(type: "boolean", nullable: false),
                    AutoGainControl = table.Column<bool>(type: "boolean", nullable: false),
                    UiPreferences = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserPreferences", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_UserPreferences_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "UserServerNotificationSettings",
                columns: table => new
                {
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    NotificationLevel = table.Column<int>(type: "integer", nullable: true),
                    MuteUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    SuppressEveryone = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserServerNotificationSettings", x => new { x.ServerId, x.UserId });
                    table.ForeignKey(
                        name: "FK_UserServerNotificationSettings_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_UserServerNotificationSettings_Servers_ServerId",
                        column: x => x.ServerId,
                        principalTable: "Servers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserChannelNotificationSettings_UserId",
                table: "UserChannelNotificationSettings",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_UserServerNotificationSettings_UserId",
                table: "UserServerNotificationSettings",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserChannelNotificationSettings");

            migrationBuilder.DropTable(
                name: "UserPreferences");

            migrationBuilder.DropTable(
                name: "UserServerNotificationSettings");

            migrationBuilder.DropColumn(
                name: "DefaultNotificationLevel",
                table: "Servers");
        }
    }
}
