using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWatchPartyModels : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MediaProviderConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    OwnerId = table.Column<string>(type: "text", nullable: false),
                    ProviderType = table.Column<int>(type: "integer", nullable: false),
                    DisplayName = table.Column<string>(type: "text", nullable: false),
                    ProviderConfigJson = table.Column<string>(type: "text", nullable: false),
                    LinkedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastValidatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MediaProviderConnections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MediaProviderConnections_AspNetUsers_OwnerId",
                        column: x => x.OwnerId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MediaProviderConnections_Servers_ServerId",
                        column: x => x.ServerId,
                        principalTable: "Servers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "WatchParties",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ChannelId = table.Column<Guid>(type: "uuid", nullable: false),
                    MediaProviderConnectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    HostUserId = table.Column<string>(type: "text", nullable: false),
                    ProviderItemId = table.Column<string>(type: "text", nullable: false),
                    ItemTitle = table.Column<string>(type: "text", nullable: false),
                    ItemThumbnail = table.Column<string>(type: "text", nullable: true),
                    ItemDurationMs = table.Column<long>(type: "bigint", nullable: true),
                    CurrentTimeMs = table.Column<double>(type: "double precision", nullable: false),
                    IsPlaying = table.Column<bool>(type: "boolean", nullable: false),
                    LastSyncAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    QueueJson = table.Column<string>(type: "text", nullable: false),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WatchParties", x => x.Id);
                    table.ForeignKey(
                        name: "FK_WatchParties_AspNetUsers_HostUserId",
                        column: x => x.HostUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_WatchParties_Channels_ChannelId",
                        column: x => x.ChannelId,
                        principalTable: "Channels",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_WatchParties_MediaProviderConnections_MediaProviderConnecti~",
                        column: x => x.MediaProviderConnectionId,
                        principalTable: "MediaProviderConnections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MediaProviderConnections_OwnerId",
                table: "MediaProviderConnections",
                column: "OwnerId");

            migrationBuilder.CreateIndex(
                name: "IX_MediaProviderConnections_ServerId_ProviderType",
                table: "MediaProviderConnections",
                columns: new[] { "ServerId", "ProviderType" });

            migrationBuilder.CreateIndex(
                name: "IX_WatchParties_ChannelId",
                table: "WatchParties",
                column: "ChannelId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WatchParties_HostUserId",
                table: "WatchParties",
                column: "HostUserId");

            migrationBuilder.CreateIndex(
                name: "IX_WatchParties_MediaProviderConnectionId",
                table: "WatchParties",
                column: "MediaProviderConnectionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WatchParties");

            migrationBuilder.DropTable(
                name: "MediaProviderConnections");
        }
    }
}
