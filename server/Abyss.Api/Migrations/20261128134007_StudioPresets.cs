using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class StudioPresets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "StudioPresets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ServerId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedById = table.Column<string>(type: "text", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Type = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    ParamsJson = table.Column<string>(type: "jsonb", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StudioPresets", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_StudioPresets_ServerId_Kind_Type",
                table: "StudioPresets",
                columns: new[] { "ServerId", "Kind", "Type" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "StudioPresets");
        }
    }
}
