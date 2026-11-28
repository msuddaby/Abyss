using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class StudioHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "StudioChanges",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Summary = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    OpCount = table.Column<int>(type: "integer", nullable: false),
                    OpsJson = table.Column<string>(type: "jsonb", nullable: false),
                    InverseJson = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StudioChanges", x => x.Id);
                    table.ForeignKey(
                        name: "FK_StudioChanges_StudioProjects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "StudioProjects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "StudioVersions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Auto = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedById = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DocVersion = table.Column<long>(type: "bigint", nullable: false),
                    DocJson = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StudioVersions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_StudioVersions_StudioProjects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "StudioProjects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_StudioChanges_ProjectId_Id",
                table: "StudioChanges",
                columns: new[] { "ProjectId", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_StudioVersions_ProjectId_CreatedAt",
                table: "StudioVersions",
                columns: new[] { "ProjectId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "StudioChanges");

            migrationBuilder.DropTable(
                name: "StudioVersions");
        }
    }
}
