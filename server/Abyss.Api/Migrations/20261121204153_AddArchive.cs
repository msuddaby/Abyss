using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddArchive : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ArchiveAlbums",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    CreatedById = table.Column<string>(type: "text", nullable: false),
                    CoverItemId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ArchiveAlbums", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ArchiveAlbums_AspNetUsers_CreatedById",
                        column: x => x.CreatedById,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ArchiveAlbums_Servers_ServerId",
                        column: x => x.ServerId,
                        principalTable: "Servers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ArchiveItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    AlbumId = table.Column<Guid>(type: "uuid", nullable: true),
                    UploaderId = table.Column<string>(type: "text", nullable: false),
                    Title = table.Column<string>(type: "text", nullable: false),
                    Description = table.Column<string>(type: "text", nullable: true),
                    FileName = table.Column<string>(type: "text", nullable: false),
                    StoragePath = table.Column<string>(type: "text", nullable: false),
                    ContentType = table.Column<string>(type: "text", nullable: false),
                    Size = table.Column<long>(type: "bigint", nullable: false),
                    Width = table.Column<int>(type: "integer", nullable: true),
                    Height = table.Column<int>(type: "integer", nullable: true),
                    DurationMs = table.Column<long>(type: "bigint", nullable: true),
                    PosterPath = table.Column<string>(type: "text", nullable: true),
                    SourceAttachmentId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ArchiveItems", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ArchiveItems_ArchiveAlbums_AlbumId",
                        column: x => x.AlbumId,
                        principalTable: "ArchiveAlbums",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_ArchiveItems_AspNetUsers_UploaderId",
                        column: x => x.UploaderId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ArchiveItems_Servers_ServerId",
                        column: x => x.ServerId,
                        principalTable: "Servers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ArchiveAlbums_CreatedById",
                table: "ArchiveAlbums",
                column: "CreatedById");

            migrationBuilder.CreateIndex(
                name: "IX_ArchiveAlbums_ServerId_Name",
                table: "ArchiveAlbums",
                columns: new[] { "ServerId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ArchiveItems_AlbumId_CreatedAt",
                table: "ArchiveItems",
                columns: new[] { "AlbumId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ArchiveItems_ServerId_CreatedAt",
                table: "ArchiveItems",
                columns: new[] { "ServerId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ArchiveItems_UploaderId",
                table: "ArchiveItems",
                column: "UploaderId");

            // Let everyone upload to the archive by default (Permission.UploadToArchive = 1 << 25)
            migrationBuilder.Sql("UPDATE \"ServerRoles\" SET \"Permissions\" = \"Permissions\" | 33554432 WHERE \"IsDefault\" = TRUE;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ArchiveItems");

            migrationBuilder.DropTable(
                name: "ArchiveAlbums");
        }
    }
}
